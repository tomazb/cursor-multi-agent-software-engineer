import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
  assert.ok(workspace.worktreePath);
  assert.equal(path.resolve(workspace.worktreePath).startsWith(path.resolve(cwd) + path.sep), false);
  assert.match(workspace.headSha, /^[0-9a-f]{40}$/);
});

test("createDeterministicCommit rejects out-of-scope paths", async () => {
  const cwd = await initRepo();
  const expectedParentSha = (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })
  ).stdout.trim();
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(path.join(cwd, "src", "ok.ts"), "export {}\n", "utf8");
  await writeFile(path.join(cwd, "secret.env"), "TOKEN=1\n", "utf8");

  await assert.rejects(
    createDeterministicCommit(cwd, "bad", {
      allowedPathGlobs: ["src/**"],
      expectedParentSha,
    }),
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
    expectedParentSha: base,
  });
  assert.ok(committed.files.includes("src/ok.ts"));
  assert.equal(
    (await execFileAsync("git", ["rev-parse", "HEAD^"], { cwd })).stdout.trim(),
    base,
  );
  const files = await assertChangeScope(cwd, base, ["src/**"]);
  assert.deepEqual(files, ["src/ok.ts"]);
});

test("createDeterministicCommit no-op rejects a HEAD move after status", async (t) => {
  const cwd = await initRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  await execFileAsync("git", ["commit", "--allow-empty", "-qm", "expected parent"], { cwd });
  const expectedParentSha = (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })
  ).stdout.trim();
  const winningHeadSha = (
    await execFileAsync("git", ["rev-parse", "HEAD^"], { cwd })
  ).stdout.trim();
  const branch = (
    await execFileAsync("git", ["branch", "--show-current"], { cwd })
  ).stdout.trim();
  const realGit = (
    await execFileAsync("sh", ["-c", "command -v git"])
  ).stdout.trim();
  const shimRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-git-status-race-"));
  t.after(async () => rm(shimRoot, { recursive: true, force: true }));
  const shimPath = path.join(shimRoot, "git");
  const markerPath = path.join(shimRoot, "moved");
  await writeFile(
    shimPath,
    `#!/bin/sh\n"${realGit}" "$@"\ncode=$?\nif [ "$1" = "status" ] && [ "$code" -eq 0 ] && [ ! -e "${markerPath}" ]; then\n  : > "${markerPath}"\n  "${realGit}" update-ref "refs/heads/${branch}" "${winningHeadSha}" "${expectedParentSha}"\nfi\nexit "$code"\n`,
    "utf8",
  );
  await chmod(shimPath, 0o755);
  const previousPath = process.env.PATH;

  try {
    process.env.PATH = `${shimRoot}${path.delimiter}${previousPath ?? ""}`;
    await assert.rejects(
      createDeterministicCommit(cwd, "must not accept stale no-op", {
        allowedPathGlobs: ["**"],
        expectedParentSha,
      }),
      /input moved|expected.*HEAD|HEAD moved/i,
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }

  assert.equal(
    (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim(),
    winningHeadSha,
  );
});

test("createDeterministicCommit rejects an unexpected parent without moving or discarding it", async () => {
  const cwd = await initRepo();
  const expectedParentSha = (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })
  ).stdout.trim();
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(path.join(cwd, "src", "pending.ts"), "export const pending = true;\n", "utf8");
  await execFileAsync("git", ["commit", "--allow-empty", "-qm", "operator movement"], { cwd });
  const unexpectedHeadSha = (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })
  ).stdout.trim();

  await assert.rejects(
    createDeterministicCommit(cwd, "must not publish", {
      allowedPathGlobs: ["src/**"],
      expectedParentSha,
    }),
    /expected parent|unexpected HEAD|moved/i,
  );

  assert.equal(
    (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim(),
    unexpectedHeadSha,
  );
  assert.match(
    (
      await execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
        cwd,
      })
    ).stdout,
    /src\/pending\.ts/,
  );
});

test("createDeterministicCommit rejects detached HEAD before changing the index or worktree", async (t) => {
  const cwd = await initRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const expectedParentSha = (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })
  ).stdout.trim();
  await execFileAsync("git", ["checkout", "--detach", "-q", "HEAD"], { cwd });
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(path.join(cwd, "src", "staged.ts"), "export const staged = true;\n", "utf8");
  await execFileAsync("git", ["add", "src/staged.ts"], { cwd });
  await writeFile(path.join(cwd, "README.md"), "# unstaged edit\n", "utf8");
  await writeFile(path.join(cwd, "src", "untracked.ts"), "export const untracked = true;\n", "utf8");
  const statusBefore = (
    await execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd })
  ).stdout;
  const stagedBefore = (await execFileAsync("git", ["diff", "--cached", "--binary"], { cwd })).stdout;
  const unstagedBefore = (await execFileAsync("git", ["diff", "--binary"], { cwd })).stdout;

  await assert.rejects(
    createDeterministicCommit(cwd, "must not publish", {
      allowedPathGlobs: ["**"],
      expectedParentSha,
    }),
    /detached.*HEAD|attached branch/i,
  );

  assert.equal(
    (await execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd })).stdout,
    statusBefore,
  );
  assert.equal(
    (await execFileAsync("git", ["diff", "--cached", "--binary"], { cwd })).stdout,
    stagedBefore,
  );
  assert.equal((await execFileAsync("git", ["diff", "--binary"], { cwd })).stdout, unstagedBefore);
  assert.equal(
    (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim(),
    expectedParentSha,
  );
});

test("assertSafeRunId rejects path traversal run ids", async () => {
  const { assertSafeRunId } = await import("../src/git-workspace.ts");
  assert.throws(() => assertSafeRunId("../escape"), /Invalid run id/);
  assert.throws(() => assertSafeRunId("a/b"), /Invalid run id/);
  assert.doesNotThrow(() => assertSafeRunId("doctor-abcd1234"));
});

test("listWorkingTreePaths handles NUL-delimited rename entries", async () => {
  const cwd = await initRepo();
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(path.join(cwd, "src", "old.ts"), "export const old = 1;\n", "utf8");
  await execFileAsync("git", ["add", "src/old.ts"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "old"], { cwd });
  await execFileAsync("git", ["mv", "src/old.ts", "src/new.ts"], { cwd });
  const { listWorkingTreePaths } = await import("../src/git-workspace.ts");
  const paths = await listWorkingTreePaths(cwd);
  assert.ok(paths.includes("src/new.ts"), `expected rename dest in ${paths.join(",")}`);
});
