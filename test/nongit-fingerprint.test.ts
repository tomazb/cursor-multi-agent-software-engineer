import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gitWorkspaceFingerprint } from "../src/git-snapshot.ts";

async function nonGitDir(prefix = "maswe-nongit-fp-"): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

test("non-Git directory with no .maswe state has a stable deterministic fingerprint", async () => {
  const cwd = await nonGitDir();
  const first = await gitWorkspaceFingerprint(cwd);
  const second = await gitWorkspaceFingerprint(cwd);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, "not-a-git-repository");
  assert.equal(first, second);
});

test("non-Git run.json mutation changes fingerprint", async () => {
  const cwd = await nonGitDir();
  const runDir = path.join(cwd, ".maswe", "runs", "r1");
  await mkdir(runDir, { recursive: true });
  const runPath = path.join(runDir, "run.json");
  await writeFile(runPath, `${JSON.stringify({ id: "r1", title: "a" }, null, 2)}\n`, "utf8");
  const before = await gitWorkspaceFingerprint(cwd);
  await writeFile(runPath, `${JSON.stringify({ id: "r1", title: "tampered" }, null, 2)}\n`, "utf8");
  const after = await gitWorkspaceFingerprint(cwd);
  assert.notEqual(before, after);
});

test("non-Git artifact mutation changes fingerprint", async () => {
  const cwd = await nonGitDir();
  const artDir = path.join(cwd, ".maswe", "runs", "r1", "artifacts");
  await mkdir(artDir, { recursive: true });
  const artifact = path.join(artDir, "02-brainstorm.md");
  await writeFile(artifact, "original\n", "utf8");
  const before = await gitWorkspaceFingerprint(cwd);
  await writeFile(artifact, "tampered\n", "utf8");
  const after = await gitWorkspaceFingerprint(cwd);
  assert.notEqual(before, after);
});

test("non-Git hidden authoritative-state creation changes fingerprint", async () => {
  const cwd = await nonGitDir();
  await mkdir(path.join(cwd, ".maswe", "runs", "r1"), { recursive: true });
  await writeFile(
    path.join(cwd, ".maswe", "runs", "r1", "run.json"),
    `${JSON.stringify({ id: "r1" }, null, 2)}\n`,
    "utf8",
  );
  const before = await gitWorkspaceFingerprint(cwd);
  await mkdir(path.join(cwd, ".maswe", "runs", "r1", "artifacts"), { recursive: true });
  await writeFile(
    path.join(cwd, ".maswe", "runs", "r1", "artifacts", "hidden-handoff.md"),
    "sneaky\n",
    "utf8",
  );
  const after = await gitWorkspaceFingerprint(cwd);
  assert.notEqual(before, after);
});

test("non-Git .maswe configuration mutation changes fingerprint", async () => {
  const cwd = await nonGitDir();
  await mkdir(path.join(cwd, ".maswe"), { recursive: true });
  const configPath = path.join(cwd, ".maswe", "config.json");
  await writeFile(configPath, `${JSON.stringify({ version: 1 }, null, 2)}\n`, "utf8");
  const before = await gitWorkspaceFingerprint(cwd);
  await writeFile(configPath, `${JSON.stringify({ version: 1, policy: { x: true } }, null, 2)}\n`, "utf8");
  const after = await gitWorkspaceFingerprint(cwd);
  assert.notEqual(before, after);
});

test("non-Git lock-file and temporary-file churn does not change fingerprint", async () => {
  const cwd = await nonGitDir();
  const runDir = path.join(cwd, ".maswe", "runs", "r1");
  await mkdir(path.join(runDir, "artifacts"), { recursive: true });
  await writeFile(
    path.join(runDir, "run.json"),
    `${JSON.stringify({ id: "r1" }, null, 2)}\n`,
    "utf8",
  );
  const before = await gitWorkspaceFingerprint(cwd);

  await writeFile(
    path.join(runDir, ".lock"),
    `${JSON.stringify({ pid: process.pid, owner: "t", at: new Date().toISOString() })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(runDir, ".admin.lock"),
    `${JSON.stringify({ pid: process.pid, owner: "a", at: new Date().toISOString() })}\n`,
    "utf8",
  );
  await writeFile(path.join(runDir, ".admin.lock.recovering"), "recovering\n", "utf8");
  await writeFile(path.join(runDir, "artifacts", "note.attempt-1.md.tmp"), "temp\n", "utf8");
  const journalReleases = path.join(
    runDir,
    ".lock-journal-v3",
    "data",
    "releases",
  );
  await mkdir(journalReleases, { recursive: true });
  await writeFile(
    path.join(
      journalReleases,
      `data.00000000000000000001.raw.${"a".repeat(64)}.json`,
    ),
    "published synchronization record\n",
    "utf8",
  );
  const after = await gitWorkspaceFingerprint(cwd);
  assert.equal(before, after);
});

test("non-Git no mutation leaves the fingerprint unchanged", async () => {
  const cwd = await nonGitDir();
  await mkdir(path.join(cwd, ".maswe", "runs", "r1", "artifacts"), { recursive: true });
  await writeFile(
    path.join(cwd, ".maswe", "runs", "r1", "run.json"),
    `${JSON.stringify({ id: "r1", title: "stable" }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(cwd, ".maswe", "runs", "r1", "artifacts", "note.md"),
    "content\n",
    "utf8",
  );
  const a = await gitWorkspaceFingerprint(cwd);
  const b = await gitWorkspaceFingerprint(cwd);
  const c = await gitWorkspaceFingerprint(cwd);
  assert.equal(a, b);
  assert.equal(b, c);
});

test("non-Git fingerprint is not an invariant constant across distinct MASWE state", async () => {
  const empty = await nonGitDir("maswe-nongit-empty-");
  const withState = await nonGitDir("maswe-nongit-state-");
  await mkdir(path.join(withState, ".maswe"), { recursive: true });
  await writeFile(
    path.join(withState, ".maswe", "config.json"),
    `${JSON.stringify({ version: 1 }, null, 2)}\n`,
    "utf8",
  );
  const emptyFp = await gitWorkspaceFingerprint(empty);
  const stateFp = await gitWorkspaceFingerprint(withState);
  assert.notEqual(emptyFp, stateFp);
  assert.notEqual(emptyFp, "not-a-git-repository");
  assert.notEqual(stateFp, "not-a-git-repository");
});

test("non-Git ordinary cwd file churn outside .maswe does not change fingerprint", async () => {
  const cwd = await nonGitDir();
  await mkdir(path.join(cwd, ".maswe"), { recursive: true });
  await writeFile(path.join(cwd, ".maswe", "config.json"), "{}\n", "utf8");
  const before = await gitWorkspaceFingerprint(cwd);
  await writeFile(path.join(cwd, "README.md"), "untracked outside maswe\n", "utf8");
  await appendFile(path.join(cwd, "README.md"), "more\n", "utf8");
  const after = await gitWorkspaceFingerprint(cwd);
  assert.equal(before, after);
});
