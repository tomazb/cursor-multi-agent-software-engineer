import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { MasweConfig, RuntimeRequest, RuntimeResult } from "../src/domain.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { CursorCliRuntime, type CursorCliOutputFormat } from "../src/runtimes/cursor-cli.ts";
import type { SpawnResult } from "../src/process.ts";

const execFileAsync = promisify(execFile);
const REQUESTED_MODEL = "cursor-grok-4.5-high";
const MIXED_CASE_REQUESTED_MODEL = "Cursor-Grok-4.5-High";
const FALLBACK_MODEL = "cursor-claude-fable-5-high";
const CATALOGUE = [
  REQUESTED_MODEL,
  FALLBACK_MODEL,
  "cursor-claude-opus-4.8-high",
  "gpt-5.6-sol-high",
].join("\n");

function streamOutput(model: unknown, includeResult = true): string {
  const records: unknown[] = [
    { type: "system", subtype: "init", model },
  ];
  if (includeResult) {
    records.push({
      type: "result",
      subtype: "success",
      result: "READY_FOR_BRAINSTORM_APPROVAL",
    });
  }
  return records.map((record) => JSON.stringify(record)).join("\n");
}

async function executeCursorCase(
  t: test.TestContext,
  outputFormat: CursorCliOutputFormat,
  execution: SpawnResult | Error,
): Promise<RuntimeResult> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-cursor-identity-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.command = "agent";
  config.runtime.outputFormat = outputFormat;
  config.roles.brainstormer.model = REQUESTED_MODEL;
  const runtime = new CursorCliRuntime(config, {
    cwd,
    spawnFn: async (_command, args) => {
      if (args[0] === "models") {
        return { exitCode: 0, stdout: CATALOGUE, stderr: "", durationMs: 1 };
      }
      if (execution instanceof Error) throw execution;
      return execution;
    },
  });
  const request: RuntimeRequest = {
    runId: "cursor-identity",
    role: "brainstormer",
    prompt: "brainstorm",
    cwd,
    roleConfig: config.roles.brainstormer,
  };

  return runtime.execute(request);
}

const successfulIdentityCases: Array<{
  name: string;
  outputFormat: CursorCliOutputFormat;
  stdout: string;
}> = [
  {
    name: "json without an identity field",
    outputFormat: "json",
    stdout: JSON.stringify({
      type: "result",
      subtype: "success",
      result: "READY_FOR_BRAINSTORM_APPROVAL",
    }),
  },
  {
    name: "text without an identity field",
    outputFormat: "text",
    stdout: "READY_FOR_BRAINSTORM_APPROVAL",
  },
  {
    name: "stream initialization equal to the requested exact id",
    outputFormat: "stream-json",
    stdout: streamOutput(REQUESTED_MODEL),
  },
  {
    name: "stream initialization different from the requested exact id",
    outputFormat: "stream-json",
    stdout: streamOutput("Opus 4.7 (Thinking) 1M Extra High"),
  },
  {
    name: "stream without initialization identity",
    outputFormat: "stream-json",
    stdout: JSON.stringify({
      type: "result",
      subtype: "success",
      result: "READY_FOR_BRAINSTORM_APPROVAL",
    }),
  },
  {
    name: "stream with numeric initialization identity",
    outputFormat: "stream-json",
    stdout: streamOutput(123),
  },
  {
    name: "stream with object initialization identity",
    outputFormat: "stream-json",
    stdout: streamOutput({ display: "model" }),
  },
];

for (const spec of successfulIdentityCases) {
  test(`Cursor CLI omits actualModel for ${spec.name}`, async (t) => {
    const result = await executeCursorCase(t, spec.outputFormat, {
      exitCode: 0,
      stdout: spec.stdout,
      stderr: "",
      durationMs: 1,
    });

    assert.equal(result.status, "finished");
    assert.equal(result.requestedModel, REQUESTED_MODEL);
    assert.equal(Object.hasOwn(result, "actualModel"), false);
  });
}

test("Cursor CLI failure after initialization does not fabricate actualModel", async (t) => {
  const result = await executeCursorCase(t, "stream-json", {
    exitCode: 1,
    stdout: streamOutput("Different Display Model", false),
    stderr: "provider failed",
    durationMs: 1,
  });

  assert.equal(result.status, "error");
  assert.equal(result.requestedModel, REQUESTED_MODEL);
  assert.equal(Object.hasOwn(result, "actualModel"), false);
});

test("Cursor CLI spawn failure does not fabricate actualModel", async (t) => {
  const result = await executeCursorCase(t, "json", new Error("spawn failed"));

  assert.equal(result.status, "error");
  assert.equal(result.requestedModel, REQUESTED_MODEL);
  assert.equal(Object.hasOwn(result, "actualModel"), false);
});

async function initGitRepo(t: test.TestContext): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-cursor-fallback-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "-q"], { cwd });
  await execFileAsync("git", ["config", "user.email", "maswe@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "MASWE"], { cwd });
  await writeFile(path.join(cwd, "README.md"), "# Cursor fallback\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "init"], { cwd });
  return cwd;
}

test("Cursor CLI identity absence preserves ordinary transport fallback", async (t) => {
  const cwd = await initGitRepo(t);
  const config: MasweConfig = structuredClone(DEFAULT_CONFIG);
  config.runtime.kind = "cursor-cli";
  config.runtime.command = "agent";
  config.runtime.outputFormat = "stream-json";
  config.policy.useIsolatedWorktree = false;
  config.policy.rejectModelFallback = false;
  config.quality.commands = [];
  config.roles.brainstormer.fallbackModels = [FALLBACK_MODEL];
  const invokedModels: string[] = [];
  const runtime = new CursorCliRuntime(config, {
    cwd,
    spawnFn: async (_command, args) => {
      if (args[0] === "models") {
        return { exitCode: 0, stdout: CATALOGUE, stderr: "", durationMs: 1 };
      }
      const modelIndex = args.indexOf("--model");
      const model = args[modelIndex + 1]!;
      invokedModels.push(model);
      if (model === REQUESTED_MODEL) {
        return {
          exitCode: 1,
          stdout: streamOutput("Different Display Model", false),
          stderr: "temporary provider failure",
          durationMs: 1,
        };
      }
      return {
        exitCode: 0,
        stdout: streamOutput("Fallback Display Model"),
        stderr: "",
        durationMs: 1,
      };
    },
  });

  const run = await new Orchestrator(cwd, config, runtime).start(
    "Cursor identity provenance",
    "Exercise ordinary fallback.",
  );

  assert.equal(run.state, "WAITING_FOR_BRAINSTORM_APPROVAL");
  assert.deepEqual(invokedModels, [REQUESTED_MODEL, FALLBACK_MODEL]);
  assert.equal(run.failure, undefined);
});

async function runPersistedMixedCaseDesigner(
  t: test.TestContext,
  options: { rejectModelFallback: boolean; primaryFails: boolean },
): Promise<{ run: Awaited<ReturnType<Orchestrator["approve"]>>; designerModels: string[] }> {
  const cwd = await initGitRepo(t);
  const config: MasweConfig = structuredClone(DEFAULT_CONFIG);
  config.runtime.kind = "cursor-cli";
  config.runtime.command = "agent";
  config.runtime.outputFormat = "text";
  config.policy.useIsolatedWorktree = false;
  config.policy.rejectModelFallback = options.rejectModelFallback;
  config.quality.commands = [];
  config.roles.designer.model = REQUESTED_MODEL;
  config.roles.designer.fallbackModels = [FALLBACK_MODEL];
  const invokedModels: string[] = [];
  let executionCount = 0;
  const runtime = new CursorCliRuntime(config, {
    cwd,
    spawnFn: async (_command, args) => {
      if (args[0] === "models") {
        return { exitCode: 0, stdout: CATALOGUE, stderr: "", durationMs: 1 };
      }
      const modelIndex = args.indexOf("--model");
      const model = args[modelIndex + 1]!;
      executionCount += 1;
      if (executionCount === 1) {
        return {
          exitCode: 0,
          stdout: "READY_FOR_BRAINSTORM_APPROVAL\n",
          stderr: "",
          durationMs: 1,
        };
      }
      invokedModels.push(model);
      if (options.primaryFails && model === REQUESTED_MODEL) {
        return {
          exitCode: 7,
          stdout: "",
          stderr: "temporary provider failure",
          durationMs: 1,
        };
      }
      return {
        exitCode: 0,
        stdout: "READY_FOR_DESIGN_APPROVAL\n",
        stderr: "",
        durationMs: 1,
      };
    },
  });
  const orchestrator = new Orchestrator(cwd, config, runtime);
  const started = await orchestrator.start(
    "Persisted mixed-case Cursor identity",
    "Exercise canonical candidate selection.",
  );
  const runPath = path.join(cwd, ".maswe", "runs", started.id, "run.json");
  const persisted = JSON.parse(await readFile(runPath, "utf8")) as {
    config: MasweConfig;
  };
  persisted.config.roles.designer.model = MIXED_CASE_REQUESTED_MODEL;
  await writeFile(runPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

  return {
    run: await orchestrator.approve(started.id, "brainstorm"),
    designerModels: invokedModels,
  };
}

test("mixed-case persisted Cursor candidate executes as the trusted catalogue identity", async (t) => {
  const { run, designerModels } = await runPersistedMixedCaseDesigner(t, {
    rejectModelFallback: true,
    primaryFails: false,
  });

  assert.equal(run.state, "WAITING_FOR_DESIGN_APPROVAL");
  assert.equal(run.failure, undefined);
  assert.deepEqual(designerModels, [REQUESTED_MODEL]);
});

test("mixed-case persisted Cursor candidate keeps an ordinary runtime error retryable", async (t) => {
  const { run, designerModels } = await runPersistedMixedCaseDesigner(t, {
    rejectModelFallback: false,
    primaryFails: true,
  });

  assert.equal(run.state, "WAITING_FOR_DESIGN_APPROVAL");
  assert.equal(run.failure, undefined);
  assert.deepEqual(designerModels, [REQUESTED_MODEL, FALLBACK_MODEL]);
});

test("mixed-case persisted Cursor candidate fails ordinarily when fallback is disabled", async (t) => {
  const { run, designerModels } = await runPersistedMixedCaseDesigner(t, {
    rejectModelFallback: true,
    primaryFails: true,
  });

  assert.equal(run.state, "FAILED");
  assert.equal(run.failure?.code, "runtime-models-exhausted");
  assert.notEqual(run.failure?.code, "policy-runtime-identity-mismatch");
  assert.equal(run.failure?.runtime?.attempts[0]?.model, REQUESTED_MODEL);
  assert.deepEqual(designerModels, [REQUESTED_MODEL]);
});
