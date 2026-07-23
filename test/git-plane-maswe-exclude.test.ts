import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { gitWorkspaceFingerprint } from "../src/git-snapshot.ts";

const execFileAsync = promisify(execFile);

async function initRepoWithoutMasweExclude(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-fp-noexclude-"));
  await execFileAsync("git", ["init", "-q"], { cwd });
  await execFileAsync("git", ["config", "user.email", "maswe@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "MASWE"], { cwd });
  await writeFile(path.join(cwd, "README.md"), "# demo\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "init"], { cwd });

  const excludePath = path.join(cwd, ".git", "info", "exclude");
  let exclude = "";
  try {
    exclude = await readFile(excludePath, "utf8");
  } catch {
    exclude = "";
  }
  assert.equal(
    exclude.split(/\r?\n/).includes(".maswe/"),
    false,
    "fixture must not rely on .git/info/exclude for .maswe/",
  );
  return cwd;
}

test("Git-plane fingerprint ignores ephemeral .maswe churn without info/exclude", async () => {
  const cwd = await initRepoWithoutMasweExclude();
  await mkdir(path.join(cwd, ".maswe", "runs", "r1", "artifacts"), { recursive: true });
  await writeFile(path.join(cwd, ".maswe", "config.json"), '{"version":1}\n', "utf8");
  await writeFile(
    path.join(cwd, ".maswe", "runs", "r1", "run.json"),
    `${JSON.stringify({ id: "r1", title: "base" }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(cwd, ".maswe", "runs", "r1", "artifacts", "01-note.md"),
    "durable\n",
    "utf8",
  );

  const baseline = await gitWorkspaceFingerprint(cwd);

  await writeFile(path.join(cwd, ".maswe", ".lock"), "lock\n", "utf8");
  await writeFile(path.join(cwd, ".maswe", ".admin.lock"), "admin\n", "utf8");
  await writeFile(path.join(cwd, ".maswe", ".admin.lock.recovering"), "recovering\n", "utf8");
  await writeFile(path.join(cwd, ".maswe", "example.tmp"), "tmp\n", "utf8");
  await writeFile(
    path.join(cwd, ".maswe", "runs", "r1", "artifacts", "note.attempt-1.md.tmp"),
    "staging\n",
    "utf8",
  );

  const afterEphemeral = await gitWorkspaceFingerprint(cwd);
  assert.equal(
    afterEphemeral,
    baseline,
    "ephemeral .maswe files must not perturb the fingerprint without info/exclude",
  );
});

test("without info/exclude, authoritative .maswe and ordinary repo mutations still change fingerprint", async () => {
  const cwd = await initRepoWithoutMasweExclude();
  await mkdir(path.join(cwd, ".maswe", "runs", "r1", "artifacts"), { recursive: true });
  await writeFile(path.join(cwd, ".maswe", "config.json"), '{"version":1}\n', "utf8");
  await writeFile(
    path.join(cwd, ".maswe", "runs", "r1", "run.json"),
    `${JSON.stringify({ id: "r1", title: "base" }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(cwd, ".maswe", "runs", "r1", "artifacts", "01-note.md"),
    "durable\n",
    "utf8",
  );

  const baseline = await gitWorkspaceFingerprint(cwd);

  await writeFile(path.join(cwd, ".maswe", "config.json"), '{"version":2}\n', "utf8");
  const afterConfig = await gitWorkspaceFingerprint(cwd);
  assert.notEqual(afterConfig, baseline, "config mutation must change fingerprint");

  await writeFile(
    path.join(cwd, ".maswe", "runs", "r1", "run.json"),
    `${JSON.stringify({ id: "r1", title: "changed" }, null, 2)}\n`,
    "utf8",
  );
  const afterRun = await gitWorkspaceFingerprint(cwd);
  assert.notEqual(afterRun, afterConfig, "run.json mutation must change fingerprint");

  await writeFile(
    path.join(cwd, ".maswe", "runs", "r1", "artifacts", "01-note.md"),
    "durable changed\n",
    "utf8",
  );
  const afterArtifact = await gitWorkspaceFingerprint(cwd);
  assert.notEqual(afterArtifact, afterRun, "artifact mutation must change fingerprint");

  await writeFile(path.join(cwd, "README.md"), "# demo\nedited\n", "utf8");
  const afterRepo = await gitWorkspaceFingerprint(cwd);
  assert.notEqual(afterRepo, afterArtifact, "ordinary repo mutation must change fingerprint");
});

test("staged and unstaged .maswe paths are governed by authoritative MASWE hashing", async () => {
  const cwd = await initRepoWithoutMasweExclude();
  await mkdir(path.join(cwd, ".maswe"), { recursive: true });
  await writeFile(path.join(cwd, ".maswe", "config.json"), '{"version":1}\n', "utf8");

  const baseline = await gitWorkspaceFingerprint(cwd);

  // Unstaged tracked-looking path under .maswe (untracked file).
  await writeFile(path.join(cwd, ".maswe", ".lock"), "lock\n", "utf8");
  assert.equal(await gitWorkspaceFingerprint(cwd), baseline);

  // Force-add an ephemeral path into the index; Git-plane must still exclude .maswe
  // so only authoritative hashing applies (ephemeral basename remains ignored).
  await execFileAsync("git", ["add", "-f", ".maswe/.lock"], { cwd });
  assert.equal(
    await gitWorkspaceFingerprint(cwd),
    baseline,
    "staged ephemeral .maswe path must not change fingerprint",
  );

  // Authoritative staged content still detected via MASWE-plane hash.
  await writeFile(path.join(cwd, ".maswe", "config.json"), '{"version":9}\n', "utf8");
  await execFileAsync("git", ["add", "-f", ".maswe/config.json"], { cwd });
  const afterAuthoritative = await gitWorkspaceFingerprint(cwd);
  assert.notEqual(afterAuthoritative, baseline);

  // Confirm exclude file still absent / unused for this contract.
  try {
    await access(path.join(cwd, ".git", "info", "exclude"));
    const exclude = await readFile(path.join(cwd, ".git", "info", "exclude"), "utf8");
    assert.equal(exclude.split(/\r?\n/).includes(".maswe/"), false);
  } catch {
    // missing exclude file is fine
  }
});
