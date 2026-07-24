import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  appendFile,
  mkdtemp,
  mkdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { RunRecord } from "../src/domain.ts";
import { gitWorkspaceFingerprint } from "../src/git-snapshot.ts";
import { ensureMasweGitExclude, ensureRunWorkspace } from "../src/git-workspace.ts";
import { publishLockClaim } from "../src/lock-journal.ts";
import { FileRunStore } from "../src/store.ts";

const execFileAsync = promisify(execFile);

async function initRepo(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-fp-"));
  await execFileAsync("git", ["init", "-q"], { cwd });
  await execFileAsync("git", ["config", "user.email", "maswe@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "MASWE"], { cwd });
  await writeFile(path.join(cwd, "README.md"), "# demo\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "init"], { cwd });
  return cwd;
}

test("useIsolatedWorktree=false: mutating run.json changes fingerprint", async () => {
  const cwd = await initRepo();
  await ensureMasweGitExclude(cwd);
  const store = new FileRunStore(cwd);
  const config = structuredClone(DEFAULT_CONFIG);
  config.policy.useIsolatedWorktree = false;
  const run = await store.create("fp-runjson", "request", config);
  const before = await gitWorkspaceFingerprint(cwd);
  const afterSame = await gitWorkspaceFingerprint(cwd);
  assert.equal(before, afterSame, "stable fingerprint without mutation");

  const runPath = path.join(cwd, ".maswe", "runs", run.id, "run.json");
  const raw = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(runPath, "utf8")));
  raw.title = "tampered-by-readonly-role";
  await writeFile(runPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  const after = await gitWorkspaceFingerprint(cwd);
  assert.notEqual(before, after, "run.json mutation must change fingerprint");
});

test("useIsolatedWorktree=false: mutating artifact changes fingerprint", async () => {
  const cwd = await initRepo();
  await ensureMasweGitExclude(cwd);
  const store = new FileRunStore(cwd);
  const config = structuredClone(DEFAULT_CONFIG);
  config.policy.useIsolatedWorktree = false;
  const run = await store.create("fp-art", "request", config);
  await store.writeArtifact(run, "01-note.md", "original\n");
  const before = await gitWorkspaceFingerprint(cwd);

  const artifact = run.artifacts.find((a) => a.logicalName === "01-note.md");
  assert.ok(artifact);
  await writeFile(path.join(cwd, artifact.path), "tampered artifact\n", "utf8");
  const after = await gitWorkspaceFingerprint(cwd);
  assert.notEqual(before, after, "artifact mutation must change fingerprint");
});

test("useIsolatedWorktree=false: creating hidden authoritative state changes fingerprint", async () => {
  const cwd = await initRepo();
  await ensureMasweGitExclude(cwd);
  const store = new FileRunStore(cwd);
  const config = structuredClone(DEFAULT_CONFIG);
  config.policy.useIsolatedWorktree = false;
  const run = await store.create("fp-hidden", "request", config);
  const before = await gitWorkspaceFingerprint(cwd);

  await mkdir(path.join(cwd, ".maswe", "runs", run.id, "artifacts"), { recursive: true });
  await writeFile(
    path.join(cwd, ".maswe", "runs", run.id, "artifacts", "hidden-handoff.md"),
    "sneaky\n",
    "utf8",
  );
  const after = await gitWorkspaceFingerprint(cwd);
  assert.notEqual(before, after, "new authoritative .maswe file must change fingerprint");
});

test("useIsolatedWorktree=false: ordinary repository mutation still changes fingerprint", async () => {
  const cwd = await initRepo();
  await ensureMasweGitExclude(cwd);
  const before = await gitWorkspaceFingerprint(cwd);
  await appendFile(path.join(cwd, "README.md"), "edit\n", "utf8");
  const after = await gitWorkspaceFingerprint(cwd);
  assert.notEqual(before, after);
});

test("lock and temp churn under .maswe does not change fingerprint", async () => {
  const cwd = await initRepo();
  await ensureMasweGitExclude(cwd);
  const store = new FileRunStore(cwd);
  const run = await store.create("fp-lock", "request", DEFAULT_CONFIG);
  await mkdir(path.join(cwd, ".maswe", "runs", run.id, "artifacts"), {
    recursive: true,
  });
  const before = await gitWorkspaceFingerprint(cwd);

  await writeFile(
    path.join(cwd, ".maswe", "runs", run.id, ".lock"),
    `${JSON.stringify({ pid: process.pid, owner: "t", at: new Date().toISOString() })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(cwd, ".maswe", "runs", run.id, ".admin.lock"),
    `${JSON.stringify({ pid: process.pid, owner: "a", at: new Date().toISOString() })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(cwd, ".maswe", "runs", run.id, "artifacts", "note.attempt-1.md.tmp"),
    "temp\n",
    "utf8",
  );
  const journalClaims = path.join(
    cwd,
    ".maswe",
    "runs",
    run.id,
    ".lock-journal-v3",
    "data",
    "claims",
  );
  await mkdir(journalClaims, { recursive: true });
  await publishLockClaim(
    path.join(cwd, ".maswe", "runs", run.id),
    "data",
    "store-write",
  );
  const after = await gitWorkspaceFingerprint(cwd);
  assert.equal(before, after, "ephemeral lock/temp files must not affect fingerprint");
});

test("journal exclusion is limited to a run's exact synchronization namespace", async () => {
  const cwd = await initRepo();
  await ensureMasweGitExclude(cwd);
  await mkdir(path.join(cwd, ".maswe", ".lock-journal-v3"), { recursive: true });
  const before = await gitWorkspaceFingerprint(cwd);
  await writeFile(
    path.join(cwd, ".maswe", ".lock-journal-v3", "not-a-run-journal"),
    "must remain authoritative\n",
    "utf8",
  );
  assert.notEqual(await gitWorkspaceFingerprint(cwd), before);
});

test("unexpected journal root and kind entries remain fingerprint-visible", async () => {
  const cwd = await initRepo();
  await ensureMasweGitExclude(cwd);
  const store = new FileRunStore(cwd);
  const run = await store.create("fp-journal-unsafe", "request", DEFAULT_CONFIG);
  const journalRoot = path.join(
    cwd,
    ".maswe",
    "runs",
    run.id,
    ".lock-journal-v3",
  );
  const before = await gitWorkspaceFingerprint(cwd);

  await writeFile(path.join(journalRoot, "unexpected"), "unexpected\n");
  const afterRoot = await gitWorkspaceFingerprint(cwd);
  assert.notEqual(afterRoot, before);

  await symlink(
    path.join(cwd, "outside"),
    path.join(journalRoot, "data", "unexpected-link"),
  );
  assert.notEqual(await gitWorkspaceFingerprint(cwd), afterRoot);
});

test("non-journal symlinks contribute their type and target to the fingerprint", async () => {
  const cwd = await initRepo();
  await ensureMasweGitExclude(cwd);
  await mkdir(path.join(cwd, ".maswe"), { recursive: true });
  const before = await gitWorkspaceFingerprint(cwd);

  await symlink("first-target", path.join(cwd, ".maswe", "unexpected-link"));
  const afterLink = await gitWorkspaceFingerprint(cwd);
  assert.notEqual(afterLink, before);
});

test(
  "literal POSIX backslashes cannot masquerade as journal path separators",
  { skip: process.platform === "win32" },
  async () => {
    const cwd = await initRepo();
    await ensureMasweGitExclude(cwd);
    await mkdir(path.join(cwd, ".maswe"), { recursive: true });
    const before = await gitWorkspaceFingerprint(cwd);

    await writeFile(
      path.join(
        cwd,
        ".maswe",
        "runs\\r\\.lock-journal-v3\\data\\claims\\00000000000000000001.json",
      ),
      "authoritative literal filename\n",
    );
    assert.notEqual(await gitWorkspaceFingerprint(cwd), before);
  },
);

test("canonical-looking malformed and unsafe journal claims remain fingerprint-visible", async () => {
  const cwd = await initRepo();
  await ensureMasweGitExclude(cwd);
  const store = new FileRunStore(cwd);
  const run = await store.create("fp-journal-records", "request", DEFAULT_CONFIG);
  const claims = path.join(
    cwd,
    ".maswe",
    "runs",
    run.id,
    ".lock-journal-v3",
    "data",
    "claims",
  );
  const before = await gitWorkspaceFingerprint(cwd);

  await writeFile(
    path.join(claims, "00000000000000000099.json"),
    "malformed claim\n",
  );
  const afterMalformed = await gitWorkspaceFingerprint(cwd);
  assert.notEqual(afterMalformed, before);

  await symlink(
    path.join(cwd, "outside"),
    path.join(claims, "00000000000000000098.json"),
  );
  assert.notEqual(await gitWorkspaceFingerprint(cwd), afterMalformed);
});

test("canonical journal kind path is excluded only when it is an ordinary directory", async () => {
  const cwd = await initRepo();
  await ensureMasweGitExclude(cwd);
  const journalRoot = path.join(
    cwd,
    ".maswe",
    "runs",
    "kind-type",
    ".lock-journal-v3",
  );
  await mkdir(journalRoot, { recursive: true });
  const before = await gitWorkspaceFingerprint(cwd);

  await symlink(path.join(cwd, "outside"), path.join(journalRoot, "data"));
  assert.notEqual(await gitWorkspaceFingerprint(cwd), before);
});

test("isolated worktree fingerprint still detects worktree repository mutations", async () => {
  const cwd = await initRepo();
  const run = {
    id: "fp-iso",
    config: structuredClone(DEFAULT_CONFIG),
  } as RunRecord;
  run.config.policy.useIsolatedWorktree = true;
  const workspace = await ensureRunWorkspace(cwd, run);
  assert.ok(workspace.worktreePath);
  const before = await gitWorkspaceFingerprint(workspace.worktreePath);
  await appendFile(path.join(workspace.worktreePath, "README.md"), "iso-edit\n", "utf8");
  const after = await gitWorkspaceFingerprint(workspace.worktreePath);
  assert.notEqual(before, after);
});
