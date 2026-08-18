import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import * as gitSnapshot from "../src/git-snapshot.ts";
import { gitWorkspaceFingerprint } from "../src/git-snapshot.ts";

const execFileAsync = promisify(execFile);

type SourceFingerprint = (cwd: string, timeoutMs?: number) => Promise<string>;

function captureWorkspaceSourceFingerprint(cwd: string): Promise<string> {
  const candidate = (
    gitSnapshot as typeof gitSnapshot & {
      captureWorkspaceSourceFingerprint?: SourceFingerprint;
    }
  ).captureWorkspaceSourceFingerprint;
  if (typeof candidate !== "function") {
    assert.fail("captureWorkspaceSourceFingerprint must be exported");
  }
  return candidate(cwd);
}

async function initRepo(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue28-bootstrap-git-"));
  await execFileAsync("git", ["init", "-q"], { cwd });
  await execFileAsync("git", ["config", "user.email", "maswe@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "MASWE"], { cwd });
  await writeFile(path.join(cwd, "README.md"), "# demo\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "init"], { cwd });
  return cwd;
}

async function nonGitDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "maswe-issue28-bootstrap-nongit-"));
}

test("Git bootstrap source fingerprint excludes .maswe and tracks source planes", async () => {
  const cwd = await initRepo();
  const runPath = path.join(cwd, ".maswe", "runs", "run-1", "run.json");
  await mkdir(path.dirname(runPath), { recursive: true });
  await writeFile(runPath, '{"id":"run-1","title":"before"}\n', "utf8");

  const sourceBefore = await captureWorkspaceSourceFingerprint(cwd);
  const authoritativeBefore = await gitWorkspaceFingerprint(cwd);
  await writeFile(runPath, '{"id":"run-1","title":"after"}\n', "utf8");
  assert.equal(
    await captureWorkspaceSourceFingerprint(cwd),
    sourceBefore,
    ".maswe run state must not affect bootstrap source identity",
  );
  assert.notEqual(
    await gitWorkspaceFingerprint(cwd),
    authoritativeBefore,
    "authoritative fingerprint must retain read-only .maswe enforcement",
  );

  await writeFile(path.join(cwd, "README.md"), "# unstaged source\n", "utf8");
  assert.notEqual(
    await captureWorkspaceSourceFingerprint(cwd),
    sourceBefore,
    "unstaged source content must affect the Git source plane",
  );
  await execFileAsync("git", ["add", "README.md"], { cwd });
  assert.notEqual(
    await captureWorkspaceSourceFingerprint(cwd),
    sourceBefore,
    "staged source content must affect the Git source plane",
  );
  await writeFile(path.join(cwd, "untracked.txt"), "untracked source\n", "utf8");
  assert.notEqual(
    await captureWorkspaceSourceFingerprint(cwd),
    sourceBefore,
    "non-ignored untracked source content must affect the Git source plane",
  );
});

test("non-Git bootstrap source fingerprint excludes .maswe and tracks source files", async () => {
  const cwd = await nonGitDir();
  const runPath = path.join(cwd, ".maswe", "runs", "run-1", "run.json");
  await mkdir(path.dirname(runPath), { recursive: true });
  await writeFile(runPath, '{"id":"run-1","title":"before"}\n', "utf8");
  await writeFile(path.join(cwd, "README.md"), "# source\n", "utf8");

  const sourceBefore = await captureWorkspaceSourceFingerprint(cwd);
  const authoritativeBefore = await gitWorkspaceFingerprint(cwd);
  await writeFile(runPath, '{"id":"run-1","title":"after"}\n', "utf8");
  assert.equal(
    await captureWorkspaceSourceFingerprint(cwd),
    sourceBefore,
    ".maswe run state must not affect non-Git bootstrap source identity",
  );
  assert.notEqual(
    await gitWorkspaceFingerprint(cwd),
    authoritativeBefore,
    "authoritative fingerprint must retain non-Git read-only .maswe enforcement",
  );

  await writeFile(path.join(cwd, "README.md"), "# changed source\n", "utf8");
  assert.notEqual(
    await captureWorkspaceSourceFingerprint(cwd),
    sourceBefore,
    "non-Git source content must affect bootstrap source identity",
  );
});
