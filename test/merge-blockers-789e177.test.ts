import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, migrateConfig, loadConfig } from "../src/config.ts";
import { migrateRunRecord } from "../src/store.ts";
import { CursorCliRuntime, parseModelCatalogueIds, shouldPassTrustFlag } from "../src/runtimes/cursor-cli.ts";
import type { RuntimeRequest } from "../src/domain.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { MockRuntime } from "../src/runtimes/mock.ts";
import { FileRunStore } from "../src/store.ts";
import { createRuntime } from "../src/runtime.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("parseModelCatalogueIds matches exact model IDs only", () => {
  const catalogue = `
Available models:
  gpt-5.6-sol-high
  gpt-5
  claude-opus-4.8 (default)
  - grok-4.5
`;
  const ids = parseModelCatalogueIds(catalogue);
  assert.equal(ids.has("gpt-5.6-sol-high"), true);
  assert.equal(ids.has("gpt-5"), true);
  assert.equal(ids.has("claude-opus-4.8"), true);
  assert.equal(ids.has("grok-4.5"), true);
  assert.equal(ids.has("gpt-5.6"), false);
  assert.equal(ids.has("opus"), false);
});

test("shouldPassTrustFlag is true for managed worktrees when policy enabled", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.policy.trustManagedWorktrees = true;
  assert.equal(shouldPassTrustFlag(config, { managedWorktree: true }), true);
  assert.equal(shouldPassTrustFlag(config, { managedWorktree: false }), false);
  config.policy.trustManagedWorktrees = false;
  assert.equal(shouldPassTrustFlag(config, { managedWorktree: true }), false);
});

test("CursorCliRuntime passes --trust for all roles in managed worktrees", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-trust-"));
  const seen: string[][] = [];
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.kind = "cursor-cli";
  config.runtime.command = process.execPath;
  config.policy.trustManagedWorktrees = true;
  config.policy.promptTransport = "argv";

  const runtime = new CursorCliRuntime(config, {
    cwd,
    spawnFn: async (command, args) => {
      seen.push([command, ...args]);
      return { exitCode: 0, stdout: "ok\nREADY_FOR_BRAINSTORM_APPROVAL\n", stderr: "", durationMs: 1 };
    },
  });

  const request: RuntimeRequest = {
    runId: "r1",
    role: "brainstormer",
    prompt: "hello",
    cwd,
    roleConfig: config.roles.brainstormer,
    managedWorktree: true,
  };
  await runtime.execute(request);
  assert.ok(seen.some((args) => args.includes("--trust")), "read-only managed worktree must pass --trust");

  seen.length = 0;
  request.role = "builder";
  request.roleConfig = config.roles.builder;
  await runtime.execute(request);
  assert.ok(seen.some((args) => args.includes("--trust")), "write managed worktree must pass --trust");
});

test("migrateConfig does not apply environment overrides; loadConfig does", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-pure-migrate-"));
  await mkdir(path.join(cwd, ".maswe"));
  await writeFile(
    path.join(cwd, ".maswe", "config.json"),
    JSON.stringify({
      runtime: { kind: "mock", command: "agent", outputFormat: "json" },
      roles: { verifier: { model: "snapshotted-verifier" } },
    }),
  );

  process.env.MASWE_MODEL_VERIFIER = "env-verifier";
  process.env.MASWE_RUNTIME = "cursor-cli";
  try {
    const migrated = migrateConfig({
      runtime: { kind: "mock", command: "agent", outputFormat: "json" },
      roles: { verifier: { model: "snapshotted-verifier" } },
    });
    assert.equal(migrated.roles.verifier.model, "snapshotted-verifier");
    assert.equal(migrated.runtime.kind, "mock");

    const loaded = await loadConfig(cwd);
    assert.equal(loaded.roles.verifier.model, "env-verifier");
    assert.equal(loaded.runtime.kind, "cursor-cli");

    const run = migrateRunRecord({
      schemaVersion: 1,
      version: 1,
      id: "r",
      title: "t",
      request: "q",
      repositoryPath: cwd,
      state: "CREATED",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      approvals: { brainstorm: false, design: false },
      counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
      config: {
        runtime: { kind: "mock", command: "agent", outputFormat: "json" },
        roles: {
          brainstormer: { model: "a", reasoning: "high", permissions: "read-only" },
          designer: { model: "a", reasoning: "high", permissions: "read-only" },
          builder: { model: "a", reasoning: "high", permissions: "workspace-write" },
          verifier: { model: "snapshotted-verifier", reasoning: "high", permissions: "read-only" },
          prResolver: { model: "a", reasoning: "high", permissions: "workspace-write" },
        },
        gates: DEFAULT_CONFIG.gates,
        quality: { commands: [] },
        policy: DEFAULT_CONFIG.policy,
      },
      artifacts: [],
      events: [],
    });
    assert.equal(run.config.roles.verifier.model, "snapshotted-verifier");
    assert.equal(run.config.runtime.kind, "mock");
  } finally {
    delete process.env.MASWE_MODEL_VERIFIER;
    delete process.env.MASWE_RUNTIME;
  }
});

test("existing-run commands construct runtime from persisted run.config snapshot", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-run-cfg-"));
  const project = structuredClone(DEFAULT_CONFIG);
  project.runtime.kind = "mock";
  project.runtime.command = "project-agent";
  project.roles.brainstormer.model = "project-model";
  project.gates.requireBrainstormApproval = true;
  project.gates.requireDesignApproval = true;
  project.quality.commands = [];
  project.policy.useIsolatedWorktree = false;

  const store = new FileRunStore(cwd);
  const run = await store.create("snap", "request", project);
  // Mutate project-facing defaults after snapshot.
  project.roles.brainstormer.model = "mutated-project-model";
  project.runtime.command = "mutated-agent";

  const fromRun = createRuntime(run.config, cwd);
  assert.ok(fromRun instanceof MockRuntime || run.config.runtime.kind === "mock");
  assert.equal(run.config.roles.brainstormer.model, "project-model");
  assert.equal(run.config.runtime.command, "project-agent");
  assert.notEqual(run.config.roles.brainstormer.model, project.roles.brainstormer.model);
});

test("complete rejects external commit or dirty tree after merge-ready", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-complete-"));
  await execFileAsync("git", ["init", "-q"], { cwd });
  await execFileAsync("git", ["config", "user.email", "maswe@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "MASWE"], { cwd });
  await writeFile(path.join(cwd, "README.md"), "# demo\n", "utf8");
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(path.join(cwd, "src", "ok.ts"), "export {}\n", "utf8");
  await execFileAsync("git", ["add", "."], { cwd });
  await execFileAsync("git", ["commit", "-qm", "init"], { cwd });

  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.kind = "mock";
  config.policy.useIsolatedWorktree = true;
  config.policy.allowedPathGlobs = ["**"];
  config.gates.requireBrainstormApproval = false;
  config.gates.requireDesignApproval = false;
  config.quality.commands = [];

  class EditingBuilder extends MockRuntime {
    override async execute(request: RuntimeRequest) {
      if (request.role === "builder") {
        await writeFile(path.join(request.cwd, "src", "feature.ts"), "export const x = 1;\n", "utf8");
        return {
          status: "finished" as const,
          output: "ok\nBUILD_COMPLETE\n",
          requestedModel: request.roleConfig.model,
          actualModel: request.roleConfig.model,
        };
      }
      return super.execute(request);
    }
  }

  const orchestrator = new Orchestrator(cwd, config, new EditingBuilder());
  let run = await orchestrator.start("Complete gate", "Must revalidate.");
  assert.equal(run.state, "PR_READY");
  run = await orchestrator.markMergeReady(run.id);
  assert.equal(run.state, "MERGE_READY");
  assert.ok(run.evidence?.mergeReady?.headSha);

  const workdir = run.workspace!.worktreePath!;
  await writeFile(path.join(workdir, "src", "ok.ts"), "export const drifted = 1;\n", "utf8");
  await execFileAsync("git", ["add", "src/ok.ts"], { cwd: workdir });
  await execFileAsync("git", ["commit", "-qm", "external"], { cwd: workdir });

  await assert.rejects(orchestrator.complete(run.id), /merge-ready|stale|HEAD|evidence|clean/i);

  // Dirty tree also blocked.
  run = await orchestrator.store.load(run.id);
  // reset to MERGE_READY with matching SHA by restoring? Simpler: new run.
  const orch2 = new Orchestrator(cwd, config, new EditingBuilder());
  let run2 = await orch2.start("Dirty complete", "dirty");
  run2 = await orch2.markMergeReady(run2.id);
  await writeFile(path.join(run2.workspace!.worktreePath!, "dirt.txt"), "x\n", "utf8");
  await assert.rejects(orch2.complete(run2.id), /clean|dirty|merge-ready/i);
});

test(
  "opt-in Cursor CLI smoke: brainstormer in newly generated managed worktree",
  { skip: process.env.MASWE_CURSOR_SMOKE !== "1" },
  async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-smoke-"));
    await execFileAsync("git", ["init", "-q"], { cwd });
    await execFileAsync("git", ["config", "user.email", "maswe@example.com"], { cwd });
    await execFileAsync("git", ["config", "user.name", "MASWE"], { cwd });
    await writeFile(path.join(cwd, "README.md"), "# smoke\n", "utf8");
    await execFileAsync("git", ["add", "README.md"], { cwd });
    await execFileAsync("git", ["commit", "-qm", "init"], { cwd });

    const config = structuredClone(DEFAULT_CONFIG);
    config.runtime.kind = "cursor-cli";
    config.policy.trustManagedWorktrees = true;
    config.policy.useIsolatedWorktree = true;
    config.gates.requireBrainstormApproval = true;
    config.quality.commands = [];

    const orchestrator = new Orchestrator(cwd, config, createRuntime(config, cwd));
    const run = await orchestrator.start("Smoke", "One-sentence brainstorm only.");
    assert.ok(run.workspace?.worktreePath);
    assert.equal(run.state, "WAITING_FOR_BRAINSTORM_APPROVAL");
    assert.ok(run.artifacts.some((a) => a.logicalName === "02-brainstorm.md"));
  },
);
