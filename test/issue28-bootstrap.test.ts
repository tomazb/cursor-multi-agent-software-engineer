import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import * as gitSnapshot from "../src/git-snapshot.ts";
import { gitWorkspaceFingerprint } from "../src/git-snapshot.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { MasweConfig, WorkspaceBootstrapIntent } from "../src/domain.ts";
import { externalWorktreePath } from "../src/git-workspace.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { MockRuntime } from "../src/runtimes/mock.ts";

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

function isolatedConfig(): MasweConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.kind = "mock";
  config.policy.useIsolatedWorktree = true;
  config.quality.commands = [];
  return config;
}

async function assertNoBootstrapGitSideEffects(
  cwd: string,
  runId: string,
): Promise<void> {
  const excludePath = (
    await execFileAsync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd })
  ).stdout.trim();
  let exclude = "";
  try {
    exclude = await readFile(
      path.isAbsolute(excludePath) ? excludePath : path.join(cwd, excludePath),
      "utf8",
    );
  } catch {
    // A missing exclude file is also proof that bootstrap did not create or update it.
  }
  assert.doesNotMatch(exclude, /^\.maswe\/$/m);

  const branch = await execFileAsync("git", ["branch", "--list", `maswe/${runId}`], { cwd });
  assert.equal(branch.stdout, "", "bootstrap must not create the deterministic branch");
  await assert.rejects(
    access(externalWorktreePath(cwd, runId)),
    "bootstrap must not create the deterministic worktree",
  );
}

async function assertCompleteIsolatedBootstrapIntent(
  cwd: string,
  run: { workspaceBootstrap?: WorkspaceBootstrapIntent },
): Promise<void> {
  const intent = run.workspaceBootstrap;
  assert.ok(intent, "durable run must include workspace bootstrap intent");
  assert.equal(intent.mode, "isolated-worktree");
  assert.equal(intent.sourceBaseSha, (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim());
  assert.equal(intent.sourceBranch, (await execFileAsync("git", ["branch", "--show-current"], { cwd })).stdout.trim());
  assert.equal(intent.sourceTreeFingerprint, await captureWorkspaceSourceFingerprint(cwd));
  assert.match(intent.plannedAt, /^\d{4}-\d{2}-\d{2}T/);
}

test("Git bootstrap source fingerprint excludes .maswe state", async () => {
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
});

test("Git bootstrap source fingerprint hashes unstaged diff bytes beyond status", async () => {
  const cwd = await initRepo();
  const readme = path.join(cwd, "README.md");

  await writeFile(readme, "# first unstaged content\n", "utf8");
  const first = await captureWorkspaceSourceFingerprint(cwd);
  const firstStatus = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd });
  assert.equal(firstStatus.stdout, " M README.md\n");

  await writeFile(readme, "# second unstaged content\n", "utf8");
  const second = await captureWorkspaceSourceFingerprint(cwd);
  const secondStatus = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd });
  assert.equal(secondStatus.stdout, firstStatus.stdout);
  assert.notEqual(second, first, "unstaged diff bytes must affect source identity");
});

test("Git bootstrap source fingerprint hashes staged diff bytes beyond status", async () => {
  const cwd = await initRepo();
  const readme = path.join(cwd, "README.md");

  await writeFile(readme, "# first staged content\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  const first = await captureWorkspaceSourceFingerprint(cwd);
  const firstStatus = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd });
  assert.equal(firstStatus.stdout, "M  README.md\n");

  await writeFile(readme, "# second staged content\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  const second = await captureWorkspaceSourceFingerprint(cwd);
  const secondStatus = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd });
  assert.equal(secondStatus.stdout, firstStatus.stdout);
  assert.notEqual(second, first, "staged diff bytes must affect source identity");
});

test("Git bootstrap source fingerprint hashes untracked bytes beyond status and path", async () => {
  const cwd = await initRepo();
  const untracked = path.join(cwd, "untracked.txt");

  await writeFile(untracked, "first untracked content\n", "utf8");
  const first = await captureWorkspaceSourceFingerprint(cwd);
  const firstStatus = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd });
  assert.equal(firstStatus.stdout, "?? untracked.txt\n");

  await writeFile(untracked, "second untracked content\n", "utf8");
  const second = await captureWorkspaceSourceFingerprint(cwd);
  const secondStatus = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd });
  assert.equal(secondStatus.stdout, firstStatus.stdout);
  assert.notEqual(second, first, "untracked bytes must affect source identity");
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

test("start persists complete bootstrap intent before any Git bootstrap side effect", async () => {
  const cwd = await initRepo();
  const config = isolatedConfig();
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), undefined, {
    beforeBootstrapReconcile: async () => {
      throw new Error("interrupt after durable start intent");
    },
  });

  await assert.rejects(
    orchestrator.start("Persist start intent", "Stop before workspace reconciliation."),
    /interrupt after durable start intent/,
  );

  const [created] = await orchestrator.store.list();
  const run = await orchestrator.store.load(created!.id);
  assert.equal(run.state, "CREATED");
  assert.equal(run.workspace, undefined);
  await assertCompleteIsolatedBootstrapIntent(cwd, run);
  await assertNoBootstrapGitSideEffects(cwd, run.id);
});

test("supersede persists linked bootstrap intent before any Git bootstrap side effect", async () => {
  const cwd = await initRepo();
  const config = isolatedConfig();
  const originalOrchestrator = new Orchestrator(cwd, config, new MockRuntime());
  const original = await originalOrchestrator.store.create(
    "Original run",
    "Create a replacement before reconciliation.",
    config,
  );
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), originalOrchestrator.store, {
    beforeBootstrapReconcile: async () => {
      throw new Error("interrupt after durable supersede intent");
    },
  });

  await assert.rejects(
    orchestrator.supersede(original.id),
    /interrupt after durable supersede intent/,
  );

  const runs = await orchestrator.store.list();
  const replacementId = runs.find((run) => run.id !== original.id)?.id;
  assert.ok(replacementId, "replacement must be durably created");
  const replacement = await orchestrator.store.load(replacementId);
  assert.equal(replacement.state, "CREATED");
  assert.equal(replacement.workspace, undefined);
  assert.equal(replacement.supersedes, original.id);
  await assertCompleteIsolatedBootstrapIntent(cwd, replacement);
  await assertNoBootstrapGitSideEffects(cwd, replacement.id);
});
