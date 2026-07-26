import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderRun } from "../src/run-rendering.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type {
  AgentRuntime,
  MasweConfig,
  RuntimeDoctorResult,
  RuntimeRequest,
  RuntimeResult,
} from "../src/domain.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import {
  FAILURE_AGGREGATE_MAX_CODE_POINTS,
  FAILURE_DIAGNOSTIC_MAX_CODE_POINTS,
} from "../src/redaction.ts";
import { FileRunStore } from "../src/store.ts";

const PERSISTED_CANARY = "ISSUE19_CANARY_PERSISTED_SECRET";
const MODELS = [
  "cursor-grok-4.5-high",
  "gpt-5.6-sol-high",
  "cursor-claude-fable-5-high",
  "cursor-claude-opus-4.8-high",
];

function issue19Config(rejectModelFallback = false): MasweConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.kind = "mock";
  config.policy.allowDirtyWorkspace = true;
  config.policy.useIsolatedWorktree = false;
  config.policy.rejectModelFallback = rejectModelFallback;
  for (const role of Object.keys(config.roles) as Array<keyof typeof config.roles>) {
    config.roles[role].model = MODELS[0]!;
    config.roles[role].fallbackModels = [];
  }
  config.roles.brainstormer.fallbackModels = MODELS.slice(1);
  return config;
}

class UnsafeFailureRuntime implements AgentRuntime {
  readonly attempts: string[] = [];

  async listModels(): Promise<string[]> {
    return MODELS;
  }

  async execute(request: RuntimeRequest): Promise<RuntimeResult> {
    this.attempts.push(request.roleConfig.model);
    const secret = `${PERSISTED_CANARY}_${this.attempts.length}`;
    const raw = [
      `provider rejected model ${request.roleConfig.model}`,
      `token=${secret}`,
      "safe retry guidance",
      "😀".repeat(3_000),
    ].join("\n");
    return {
      status: "error",
      output: raw,
      requestedModel: request.roleConfig.model,
      actualModel: request.roleConfig.model,
      failure: {
        code: "runtime-error",
        message: raw,
        requestedModel: request.roleConfig.model,
        exitCode: 23,
        timedOut: false,
        durationMs: 17,
        stderrPresent: true,
        truncated: false,
      },
      metadata: {
        stderr: raw,
        unsafeNested: { token: secret },
      },
    };
  }

  async doctor(): Promise<RuntimeDoctorResult> {
    return { ok: true, checks: [] };
  }
}

class ThrowingFailureRuntime extends UnsafeFailureRuntime {
  override async execute(request: RuntimeRequest): Promise<RuntimeResult> {
    this.attempts.push(request.roleConfig.model);
    throw new Error(
      `transport rejected ${request.roleConfig.model} token=${PERSISTED_CANARY}_THROWN`,
    );
  }
}

async function makeProject(
  t: test.TestContext,
  rejectModelFallback = false,
): Promise<{
  cwd: string;
  runtime: UnsafeFailureRuntime;
  store: FileRunStore;
  orchestrator: Orchestrator;
}> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue19-persist-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const runtime = new UnsafeFailureRuntime();
  const config = issue19Config(rejectModelFallback);
  const store = new FileRunStore(cwd);
  return {
    cwd,
    runtime,
    store,
    orchestrator: new Orchestrator(cwd, config, runtime, store),
  };
}

function assertNoCanary(value: unknown): void {
  const serialized = JSON.stringify(value) ?? "";
  assert.equal(
    serialized.includes(PERSISTED_CANARY),
    false,
    "synthetic Issue #19 canary crossed the persistence boundary",
  );
}

async function allFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await allFiles(target)));
    else files.push(target);
  }
  return files;
}

test("unsafe runtime failure is absent from returned state, disk, events, artifacts, and CLI", async (t) => {
  const { cwd, runtime, store, orchestrator } = await makeProject(t);

  const run = await orchestrator.start("Issue 19 persistence", "synthetic request");

  assert.equal(run.state, "FAILED");
  assert.deepEqual(runtime.attempts, MODELS);
  assertNoCanary(run);
  assert.match(run.failure?.message ?? "", /runtime-error/);
  assert.match(run.failure?.message ?? "", /safe retry guidance/);
  assert.match(run.failure?.message ?? "", /cursor-grok-4\.5-high/);
  assert.ok(
    [...(run.failure?.message ?? "")].length <=
      FAILURE_AGGREGATE_MAX_CODE_POINTS,
  );
  for (const event of run.events) assertNoCanary(event.details);

  const runFile = path.join(cwd, ".maswe", "runs", run.id, "run.json");
  const persisted = await readFile(runFile, "utf8");
  assert.equal(persisted.includes(PERSISTED_CANARY), false);
  assert.match(persisted, /safe retry guidance/);

  const files = await allFiles(path.join(cwd, ".maswe", "runs", run.id));
  for (const file of files) {
    const content = await readFile(file, "utf8");
    assert.equal(content.includes(PERSISTED_CANARY), false, `leak in ${file}`);
  }
  assert.equal(run.artifacts.length, 0);

  const loaded = await store.load(run.id);
  for (const cliOutput of [renderRun(loaded), JSON.stringify(loaded, null, 2)]) {
    assert.equal(cliOutput.includes(PERSISTED_CANARY), false);
    assert.match(cliOutput, /runtime-error/);
  }

  assertNoCanary(loaded);
});

test("retry history re-sanitizes previousFailure before persistence", async (t) => {
  const { cwd, store, orchestrator } = await makeProject(t, true);
  const failed = await orchestrator.start("Issue 19 retry", "synthetic request");
  failed.failure!.message = `manually unsafe token=${PERSISTED_CANARY}_RETRY`;
  await store.save(failed);

  const retried = await orchestrator.retryFromFailed(failed.id);

  assert.equal(retried.state, "FAILED");
  assertNoCanary(retried);
  const retry = retried.events.find((event) => event.type === "RETRY_FROM_FAILED");
  assert.ok(retry);
  assertNoCanary(retry?.details);
  assert.match(JSON.stringify(retry?.details), /\[REDACTED\]/);
  const persisted = await readFile(
    path.join(cwd, ".maswe", "runs", failed.id, "run.json"),
    "utf8",
  );
  assert.equal(persisted.includes(PERSISTED_CANARY), false);
});

test("single-model rejection uses the same bounded safe contract", async (t) => {
  const { runtime, orchestrator } = await makeProject(t, true);

  const run = await orchestrator.start("Issue 19 single model", "synthetic request");

  assert.equal(run.state, "FAILED");
  assert.deepEqual(runtime.attempts, [MODELS[0]]);
  assertNoCanary(run);
  assert.match(run.failure?.message ?? "", /cursor-grok-4\.5-high/);
  assert.match(run.failure?.message ?? "", /runtime-error/);
  assert.ok(
    [...(run.failure?.message ?? "")].length <=
      FAILURE_AGGREGATE_MAX_CODE_POINTS,
  );
});

test("FileRunStore sanitizes unsafe failure and retry event callers", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue19-store-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("unsafe caller", "request", issue19Config(true));
  run.failure = {
    message: `unsafe token=${PERSISTED_CANARY}_STORE`,
    at: new Date().toISOString(),
    resumeState: "BRAINSTORMING",
  };

  await store.applyEvent(run, "FAIL", "unsafe-caller", {
    reason: `unsafe token=${PERSISTED_CANARY}_EVENT`,
    resumeState: "BRAINSTORMING",
  });

  const failed = await store.load(run.id);
  assertNoCanary(failed);
  assert.match(failed.failure?.message ?? "", /\[REDACTED\]/);
  assert.match(
    String(failed.events.at(-1)?.details?.reason ?? ""),
    /\[REDACTED\]/,
  );
  const previousFailure = {
    message: `unsafe token=${PERSISTED_CANARY}_PREVIOUS`,
    at: new Date().toISOString(),
    resumeState: "BRAINSTORMING" as const,
  };
  delete failed.failure;
  await store.applyEvent(failed, "RETRY_FROM_FAILED", "unsafe-caller", {
    resumeState: "BRAINSTORMING",
    previousFailure,
  });

  const retried = await store.load(run.id);
  assertNoCanary(retried);
  assert.match(
    JSON.stringify(retried.events.at(-1)?.details),
    /\[REDACTED\]/,
  );
});

test("fallback aggregate is bounded while retaining each reachable model identity", async (t) => {
  const { orchestrator } = await makeProject(t);

  const run = await orchestrator.start("Issue 19 bounded fallback", "synthetic request");

  const message = run.failure?.message ?? "";
  assertNoCanary(message);
  assert.ok([...message].length <= FAILURE_AGGREGATE_MAX_CODE_POINTS);
  assert.ok([...message].length > FAILURE_DIAGNOSTIC_MAX_CODE_POINTS);
  for (const model of MODELS) {
    assert.match(message, new RegExp(model.replaceAll(".", "\\.")));
  }
  assert.match(message, /… \[truncated\]$/);
});

test("fallback aggregate reports model attempts omitted after reaching its bound", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue19-many-fallbacks-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const models = Array.from(
    { length: 12 },
    (_, index) => `synthetic-model-${String(index + 1).padStart(2, "0")}`,
  );
  const config = issue19Config(false);
  config.roles.brainstormer.model = models[0]!;
  config.roles.brainstormer.fallbackModels = models.slice(1);
  const runtime = new (class extends UnsafeFailureRuntime {
    override async listModels(): Promise<string[]> {
      return [...MODELS, ...models];
    }
  })();
  const orchestrator = new Orchestrator(
    cwd,
    config,
    runtime,
    new FileRunStore(cwd),
  );

  const run = await orchestrator.start(
    "Issue 19 many fallbacks",
    "synthetic request",
  );
  const message = run.failure?.message ?? "";

  assert.deepEqual(runtime.attempts, models);
  assertNoCanary(message);
  assert.ok([...message].length <= FAILURE_AGGREGATE_MAX_CODE_POINTS);
  assert.match(message, /8 additional model failures omitted after aggregate limit/);
});

test("thrown runtime errors and supersede state use the same safe boundary", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue19-supersede-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const config = issue19Config(true);
  const runtime = new ThrowingFailureRuntime();
  const store = new FileRunStore(cwd);
  const orchestrator = new Orchestrator(cwd, config, runtime, store);

  const original = await orchestrator.start("Issue 19 thrown", "synthetic request");
  assert.equal(original.state, "FAILED");
  assertNoCanary(original);
  assert.match(original.failure?.message ?? "", /transport rejected/);

  const replacement = await orchestrator.supersede(original.id);
  assert.equal(replacement.supersedes, original.id);
  assertNoCanary(replacement);
  assertNoCanary(await store.load(original.id));
  assertNoCanary(await store.load(replacement.id));

  for (const runId of [original.id, replacement.id]) {
    const persisted = await readFile(
      path.join(cwd, ".maswe", "runs", runId, "run.json"),
      "utf8",
    );
    assert.equal(persisted.includes(PERSISTED_CANARY), false);
  }
});
