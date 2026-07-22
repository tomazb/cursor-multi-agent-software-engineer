import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, mkdir, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { MasweConfig } from "../src/domain.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { MockRuntime } from "../src/runtimes/mock.ts";
import { cleanupRunWorkspace } from "../src/git-workspace.ts";

const execFileAsync = promisify(execFile);

async function initRepo(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-wt-"));
  await execFileAsync("git", ["init", "-q"], { cwd });
  await execFileAsync("git", ["config", "user.email", "maswe@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "MASWE"], { cwd });
  await writeFile(path.join(cwd, "README.md"), "# demo\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "init"], { cwd });
  return cwd;
}

function config(): MasweConfig {
  const c = structuredClone(DEFAULT_CONFIG);
  c.runtime.kind = "mock";
  c.policy.useIsolatedWorktree = true;
  c.gates.requireBrainstormApproval = false;
  c.gates.requireDesignApproval = false;
  c.quality.commands = [];
  return c;
}

test("worktree is not visible as untracked files in operator checkout", async () => {
  const cwd = await initRepo();
  const beforeBranch = (await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd }))
    .stdout.trim();
  const beforeHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
  const beforeStatus = (await execFileAsync("git", ["status", "--porcelain=v1"], { cwd })).stdout;

  const orchestrator = new Orchestrator(cwd, config(), new MockRuntime());
  const run = await orchestrator.start("Isolated", "Do not disturb checkout.");
  assert.ok(run.workspace?.worktreePath);
  assert.equal(path.resolve(run.workspace.worktreePath).startsWith(path.resolve(cwd) + path.sep), false);

  const afterBranch = (await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd }))
    .stdout.trim();
  const afterHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
  const afterStatus = (await execFileAsync("git", ["status", "--porcelain=v1"], { cwd })).stdout;
  assert.equal(afterBranch, beforeBranch);
  assert.equal(afterHead, beforeHead);
  assert.equal(afterStatus, beforeStatus);

  // A second run can start while the first remains.
  const second = await orchestrator.start("Second", "Another isolated run.");
  assert.notEqual(second.id, run.id);
  assert.ok(second.workspace?.worktreePath);
});

test("cleanup removes worktree for cancelled failed and superseded runs", async () => {
  const cwd = await initRepo();
  const orchestrator = new Orchestrator(cwd, config(), new MockRuntime());
  let run = await orchestrator.start("Cleanup", "Will cancel.");
  const worktreePath = run.workspace?.worktreePath;
  assert.ok(worktreePath);
  await access(worktreePath);

  run = await orchestrator.cancel(run.id);
  assert.equal(run.state, "CANCELLED");
  await assert.rejects(access(worktreePath), /ENOENT/);

  const failed = await orchestrator.start("Fail cleanup", "fail");
  // force fail via supersede path cleanup
  const replacement = await orchestrator.supersede(failed.id);
  assert.ok(replacement.workspace?.worktreePath);
  await assert.rejects(access(failed.workspace!.worktreePath!), /ENOENT/);

  await cleanupRunWorkspace(replacement);
});
