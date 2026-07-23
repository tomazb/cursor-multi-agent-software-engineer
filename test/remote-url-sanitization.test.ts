import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { gitRemoteUrl, sanitizeGitRemoteUrl } from "../src/git-snapshot.ts";
import { captureWorkspace } from "../src/git-workspace.ts";
import { FileRunStore } from "../src/store.ts";

const execFileAsync = promisify(execFile);

async function initRepoWithOrigin(origin: string): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-remote-"));
  await execFileAsync("git", ["init", "-q"], { cwd });
  await execFileAsync("git", ["config", "user.email", "maswe@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "MASWE"], { cwd });
  await execFileAsync("git", ["remote", "add", "origin", origin], { cwd });
  await writeFile(path.join(cwd, "README.md"), "# demo\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "init"], { cwd });
  return cwd;
}

test("sanitizeGitRemoteUrl strips HTTPS token credentials", () => {
  const sanitized = sanitizeGitRemoteUrl(
    "https://x-access-token:TOP_SECRET_TOKEN@github.com/org/repo.git",
  );
  assert.equal(sanitized, "https://github.com/org/repo.git");
  assert.doesNotMatch(sanitized ?? "", /TOP_SECRET_TOKEN/);
  assert.doesNotMatch(sanitized ?? "", /x-access-token/);
});

test("sanitizeGitRemoteUrl strips generic HTTPS userinfo", () => {
  const sanitized = sanitizeGitRemoteUrl("https://alice:password@example.com/org/repo.git");
  assert.equal(sanitized, "https://example.com/org/repo.git");
  assert.doesNotMatch(sanitized ?? "", /alice/);
  assert.doesNotMatch(sanitized ?? "", /password/);
});

test("sanitizeGitRemoteUrl strips ssh:// userinfo deliberately", () => {
  const sanitized = sanitizeGitRemoteUrl("ssh://deploy:s3cret@github.com/org/repo.git");
  assert.equal(sanitized, "ssh://github.com/org/repo.git");
  assert.doesNotMatch(sanitized ?? "", /deploy/);
  assert.doesNotMatch(sanitized ?? "", /s3cret/);
});

test("sanitizeGitRemoteUrl preserves SCP-style git@ remotes", () => {
  assert.equal(sanitizeGitRemoteUrl("git@github.com:org/repo.git"), "git@github.com:org/repo.git");
});

test("sanitizeGitRemoteUrl preserves credential-free HTTPS", () => {
  assert.equal(
    sanitizeGitRemoteUrl("https://github.com/org/repo.git"),
    "https://github.com/org/repo.git",
  );
});

test("sanitizeGitRemoteUrl omits malformed credential-like URLs", () => {
  const malformed = "https://x-access-token:RAW_SECRET_SHOULD_NOT_PERSIST@";
  const sanitized = sanitizeGitRemoteUrl(malformed);
  assert.equal(sanitized, undefined);
});

test("gitRemoteUrl and captureWorkspace never persist credential-bearing remotes", async () => {
  const secret = "TOP_SECRET_TOKEN_PERSISTENCE_PROBE";
  const origin = `https://x-access-token:${secret}@github.com/org/repo.git`;
  const cwd = await initRepoWithOrigin(origin);

  const remote = await gitRemoteUrl(cwd);
  assert.equal(remote, "https://github.com/org/repo.git");
  assert.doesNotMatch(remote ?? "", new RegExp(secret));

  const workspace = await captureWorkspace(cwd);
  assert.equal(workspace.remote, "https://github.com/org/repo.git");
  assert.doesNotMatch(JSON.stringify(workspace), new RegExp(secret));

  const store = new FileRunStore(cwd);
  const run = await store.create("remote-redact", "request", DEFAULT_CONFIG);
  run.workspace = workspace;
  await store.save(run);

  const persisted = await readFile(
    path.join(cwd, ".maswe", "runs", run.id, "run.json"),
    "utf8",
  );
  assert.doesNotMatch(persisted, new RegExp(secret));
  assert.doesNotMatch(persisted, /x-access-token/);
  assert.match(persisted, /https:\/\/github\.com\/org\/repo\.git/);
});

test("captureWorkspace preserves safe SCP-style origin remotes", async () => {
  const cwd = await initRepoWithOrigin("git@github.com:org/repo.git");
  const workspace = await captureWorkspace(cwd);
  assert.equal(workspace.remote, "git@github.com:org/repo.git");
});
