import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { MasweConfig, RunRecord } from "../src/domain.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { MockRuntime } from "../src/runtimes/mock.ts";
import {
  assertExpectedBranch,
  captureWorkspace,
  ensureRunWorkspace,
} from "../src/git-workspace.ts";
import { FileRunStore } from "../src/store.ts";

const execFileAsync = promisify(execFile);

async function initRepo(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue2-"));
  await execFileAsync("git", ["init", "-q"], { cwd });
  await execFileAsync("git", ["config", "user.email", "maswe@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "MASWE"], { cwd });
  await execFileAsync("git", ["remote", "add", "origin", "https://example.com/org/repo.git"], {
    cwd,
  });
  await writeFile(path.join(cwd, "README.md"), "# demo\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "init"], { cwd });
  return cwd;
}

function testConfig(overrides: (config: MasweConfig) => void = () => undefined): MasweConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.kind = "mock";
  config.policy.useIsolatedWorktree = true;
  config.gates.requireBrainstormApproval = false;
  config.gates.requireDesignApproval = false;
  config.quality.commands = [];
  overrides(config);
  return config;
}

test("captureWorkspace persists origin remote URL", async () => {
  const cwd = await initRepo();
  const workspace = await captureWorkspace(cwd);
  assert.equal(workspace.remote, "https://example.com/org/repo.git");
  assert.match(workspace.headSha, /^[0-9a-f]{40}$/);
});

test("assertExpectedBranch rejects unexpected branch movement", async () => {
  const cwd = await initRepo();
  await execFileAsync("git", ["checkout", "-qb", "other"], { cwd });
  await assert.rejects(
    assertExpectedBranch(cwd, "main"),
    /unexpected branch|branch movement|expected branch/i,
  );
});

test("build/CI/verify events record the evaluated head SHA", async () => {
  const cwd = await initRepo();
  const orchestrator = new Orchestrator(cwd, testConfig(), new MockRuntime());
  const run = await orchestrator.start("SHA binding", "Bind evidence to HEAD.");
  assert.equal(run.state, "PR_READY");
  assert.ok(run.workspace?.remote);

  const build = run.events.find((event) => event.type === "BUILD_COMPLETED");
  const ci = run.events.find((event) => event.type === "CI_PASSED");
  const verify = run.events.find((event) => event.type === "VERIFY_PASSED");
  assert.equal(build?.details?.headSha, run.workspace?.headSha);
  assert.equal(ci?.details?.headSha, run.workspace?.headSha);
  assert.equal(verify?.details?.headSha, run.workspace?.headSha);
  assert.equal(run.evidence?.quality?.headSha, run.workspace?.headSha);
  assert.equal(run.evidence?.verification?.headSha, run.workspace?.headSha);
});

test("new commits invalidate prior verification evidence", async () => {
  const cwd = await initRepo();
  const orchestrator = new Orchestrator(cwd, testConfig(), new MockRuntime());
  let run = await orchestrator.start("Invalidate", "Fresh commit must invalidate evidence.");
  assert.equal(run.state, "PR_READY");
  assert.ok(run.evidence?.verification);

  const worktree = run.workspace?.worktreePath;
  assert.ok(worktree);
  await mkdir(path.join(worktree, "src"), { recursive: true });
  await writeFile(path.join(worktree, "src", "extra.ts"), "export const n = 1;\n", "utf8");
  await execFileAsync("git", ["add", "src/extra.ts"], { cwd: worktree });
  await execFileAsync("git", ["commit", "-qm", "extra"], { cwd: worktree });

  await assert.rejects(orchestrator.markMergeReady(run.id), /invalidat|stale|head sha/i);
  run = await orchestrator.store.load(run.id);
  assert.equal(run.evidence?.verification, undefined);
  assert.equal(run.evidence?.quality, undefined);
});

test("concurrent store writers cannot silently overwrite run state", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-cas-"));
  const store = new FileRunStore(cwd);
  const run = await store.create("cas", "race", DEFAULT_CONFIG);
  const a = structuredClone(run) as RunRecord;
  const b = structuredClone(run) as RunRecord;
  a.title = "writer-a";
  await store.save(a);
  b.title = "writer-b";
  await assert.rejects(store.save(b), /version conflict/i);
  const loaded = await store.load(run.id);
  assert.equal(loaded.title, "writer-a");
});

test("ensureRunWorkspace does not disturb the operator checkout branch", async () => {
  const cwd = await initRepo();
  const before = (await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd }))
    .stdout.trim();
  const run = {
    id: "iso1",
    config: testConfig(),
  } as RunRecord;
  const workspace = await ensureRunWorkspace(cwd, run);
  const after = (await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd }))
    .stdout.trim();
  assert.equal(after, before);
  assert.equal(workspace.branch, "maswe/iso1");
  assert.ok(workspace.worktreePath);
});
