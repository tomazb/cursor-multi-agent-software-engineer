import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { RunRecord } from "../src/domain.ts";
import {
  assertChangeScope,
  createDeterministicCommit,
  ensureRunWorkspace,
  pathAllowed,
} from "../src/git-workspace.ts";

const execFileAsync = promisify(execFile);

async function initRepo(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-git-"));
  await execFileAsync("git", ["init", "-q"], { cwd });
  await execFileAsync("git", ["config", "user.email", "maswe@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "MASWE"], { cwd });
  await writeFile(path.join(cwd, "README.md"), "# demo\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "init"], { cwd });
  return cwd;
}

test("pathAllowed honors ** and simple globs", () => {
  assert.equal(pathAllowed("src/a.ts", ["**"]), true);
  assert.equal(pathAllowed("src/a.ts", ["src/**"]), true);
  assert.equal(pathAllowed("docs/a.md", ["src/**"]), false);
});

test("ensureRunWorkspace creates an isolated branch worktree", async () => {
  const cwd = await initRepo();
  const run = {
    id: "run123",
    config: structuredClone(DEFAULT_CONFIG),
  } as RunRecord;
  run.config.policy.useIsolatedWorktree = true;

  const workspace = await ensureRunWorkspace(cwd, run);
  assert.equal(workspace.branch, "maswe/run123");
  assert.ok(workspace.worktreePath?.includes(path.join(".maswe", "worktrees", "run123")));
  assert.match(workspace.headSha, /^[0-9a-f]{40}$/);
});

test("createDeterministicCommit rejects out-of-scope paths", async () => {
  const cwd = await initRepo();
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(path.join(cwd, "src", "ok.ts"), "export {}\n", "utf8");
  await writeFile(path.join(cwd, "secret.env"), "TOKEN=1\n", "utf8");

  await assert.rejects(
    createDeterministicCommit(cwd, "bad", { allowedPathGlobs: ["src/**"] }),
    /Change-scope violation/,
  );
});

test("createDeterministicCommit and assertChangeScope accept in-scope edits", async () => {
  const cwd = await initRepo();
  const base = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(path.join(cwd, "src", "ok.ts"), "export const x = 1;\n", "utf8");
  const committed = await createDeterministicCommit(cwd, "feat: ok", {
    allowedPathGlobs: ["src/**"],
  });
  assert.ok(committed.files.includes("src/ok.ts"));
  const files = await assertChangeScope(cwd, base, ["src/**"]);
  assert.deepEqual(files, ["src/ok.ts"]);
});
