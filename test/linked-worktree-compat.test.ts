import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { DEFAULT_CONFIG, mergeConfigForTest } from "../src/config.ts";
import { migrateRunRecord } from "../src/store.ts";
import { ensureMasweGitExclude } from "../src/git-workspace.ts";
import { CursorCliRuntime } from "../src/runtimes/cursor-cli.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { MockRuntime } from "../src/runtimes/mock.ts";

const execFileAsync = promisify(execFile);

test("deep-migrates v0.1 config snapshots missing policy hardening fields", () => {
  const legacy = {
    version: 1,
    runtime: { kind: "mock", command: "agent", outputFormat: "json" },
    roles: {
      brainstormer: { model: "m", reasoning: "high", permissions: "read-only" },
      designer: { model: "m", reasoning: "high", permissions: "read-only" },
      builder: { model: "m", reasoning: "high", permissions: "workspace-write" },
      verifier: { model: "m", reasoning: "high", permissions: "read-only" },
      prResolver: { model: "m", reasoning: "high", permissions: "workspace-write" },
    },
    gates: {
      requireBrainstormApproval: true,
      requireDesignApproval: true,
      requireCiPass: true,
      requireVerifierPass: true,
    },
    quality: { commands: [] },
    policy: {
      rejectModelFallback: true,
      maxBuildVerifyCycles: 3,
      maxCommentResolutionCycles: 2,
      allowDirtyWorkspace: false,
    },
  };

  const migrated = mergeConfigForTest(legacy);
  assert.equal(migrated.policy.useIsolatedWorktree, true);
  assert.equal(migrated.policy.promptTransport, "stdin");
  assert.equal(typeof migrated.policy.commandTimeoutMs, "number");
  assert.equal(typeof migrated.policy.roleTimeoutMs, "number");
  assert.deepEqual(migrated.policy.allowedPathGlobs, ["**"]);

  const run = migrateRunRecord({
    schemaVersion: 1,
    id: "legacy",
    title: "t",
    request: "r",
    repositoryPath: "/tmp",
    state: "CREATED",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    approvals: { brainstorm: false, design: false },
    counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
    config: legacy,
    artifacts: [],
    events: [],
  });
  assert.equal(run.config.policy.useIsolatedWorktree, true);
  assert.equal(run.config.policy.promptTransport, "stdin");
});

test("ensureMasweGitExclude works when MASWE runs from a linked worktree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-link-root-"));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "maswe@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "MASWE"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "# demo\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: root });
  await execFileAsync("git", ["commit", "-qm", "init"], { cwd: root });
  await execFileAsync("git", ["branch", "feature"], { cwd: root });

  const linked = path.join(os.tmpdir(), `maswe-link-${Date.now()}`);
  await execFileAsync("git", ["worktree", "add", linked, "feature"], { cwd: root });

  await ensureMasweGitExclude(linked);
  const excludePath = (
    await execFileAsync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: linked })
  ).stdout.trim();
  const absoluteExclude = path.isAbsolute(excludePath)
    ? excludePath
    : path.join(linked, excludePath);
  const exclude = await readFile(absoluteExclude, "utf8");
  assert.match(exclude, /^\.maswe\/$/m);

  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.kind = "mock";
  config.policy.useIsolatedWorktree = true;
  config.gates.requireBrainstormApproval = false;
  config.gates.requireDesignApproval = false;
  config.quality.commands = [];
  const orchestrator = new Orchestrator(linked, config, new MockRuntime());
  const run = await orchestrator.start("From linked", "Operator is already in a worktree.");
  assert.equal(run.state, "PR_READY");
  assert.ok(run.workspace?.worktreePath);
});

test("doctor probes configured stdin path using CLI --cwd target", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-doctor-cwd-"));
  await writeFile(path.join(cwd, "marker.txt"), "cwd-ok\n", "utf8");
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.kind = "cursor-cli";
  config.runtime.command = process.execPath;
  config.policy.promptTransport = "stdin";

  const runtime = new CursorCliRuntime(config, { cwd });
  const report = await runtime.doctor();
  const probe = report.checks.find((c) => c.name === "prompt-transport-probe");
  assert.ok(probe);
  assert.equal(probe.ok, true);
  assert.match(probe.message, /stdin|cwd/i);
});
