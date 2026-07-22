import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { RunRecord, RunWorkspace } from "./domain.ts";
import {
  gitChangedFiles,
  gitCurrentBranch,
  gitRemoteUrl,
  gitRevParse,
  gitWorkspaceFingerprint,
  isGitRepository,
  isGitWorkspaceClean,
} from "./git-snapshot.ts";

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function gitExec(command: string, args: string[], cwd: string): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}

function matchGlob(filePath: string, glob: string): boolean {
  if (glob === "**" || glob === "**/*") return true;
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/{{GLOBSTAR}}/g, ".*");
  return new RegExp(`^${escaped}$`).test(filePath);
}

export function pathAllowed(filePath: string, globs: string[]): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return globs.some((glob) => matchGlob(normalized, glob.replace(/\\/g, "/")));
}

export function externalWorktreePath(repositoryPath: string, runId: string): string {
  const repoKey = createHash("sha256").update(path.resolve(repositoryPath)).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), "maswe-worktrees", repoKey, runId);
}

export async function ensureMasweGitExclude(repositoryPath: string): Promise<void> {
  if (!(await isGitRepository(repositoryPath))) return;
  const resolved = await gitExec("git", ["rev-parse", "--git-path", "info/exclude"], repositoryPath);
  if (resolved.exitCode !== 0) {
    throw new Error(`Failed to resolve info/exclude: ${resolved.stderr}`);
  }
  const excludePath = path.isAbsolute(resolved.stdout.trim())
    ? resolved.stdout.trim()
    : path.resolve(repositoryPath, resolved.stdout.trim());
  await mkdir(path.dirname(excludePath), { recursive: true });
  let existing = "";
  try {
    existing = await readFile(excludePath, "utf8");
  } catch {
    existing = "";
  }
  if (!existing.split(/\r?\n/).includes(".maswe/")) {
    await appendFile(
      excludePath,
      `${existing.endsWith("\n") || existing.length === 0 ? "" : "\n"}.maswe/\n`,
      "utf8",
    );
  }
}

export async function captureWorkspace(cwd: string): Promise<RunWorkspace> {
  if (!(await isGitRepository(cwd))) {
    return {
      baseSha: "not-a-git-repository",
      headSha: "not-a-git-repository",
      branch: "not-a-git-repository",
      fingerprint: await gitWorkspaceFingerprint(cwd),
    };
  }
  const headSha = await gitRevParse(cwd, "HEAD");
  const remote = await gitRemoteUrl(cwd);
  return {
    ...(remote ? { remote } : {}),
    baseSha: headSha,
    headSha,
    branch: await gitCurrentBranch(cwd),
    fingerprint: await gitWorkspaceFingerprint(cwd),
  };
}

export async function assertExpectedBranch(cwd: string, expectedBranch: string): Promise<void> {
  if (!(await isGitRepository(cwd))) return;
  if (expectedBranch === "not-a-git-repository") return;
  const actual = await gitCurrentBranch(cwd);
  if (actual !== expectedBranch) {
    throw new Error(
      `Unexpected branch movement: expected ${expectedBranch}, currently on ${actual}`,
    );
  }
}

export async function refreshWorkspaceHead(run: RunRecord): Promise<string | undefined> {
  if (!run.workspace || run.workspace.baseSha === "not-a-git-repository") return undefined;
  const cwd = workingDirectoryFor(run);
  await assertExpectedBranch(cwd, run.workspace.branch);
  const headSha = await gitRevParse(cwd, "HEAD");
  run.workspace.headSha = headSha;
  run.workspace.fingerprint = await gitWorkspaceFingerprint(cwd);
  return headSha;
}

export function invalidateStaleEvidence(run: RunRecord, headSha: string): boolean {
  if (!run.evidence) return false;
  let invalidated = false;
  if (run.evidence.quality && run.evidence.quality.headSha !== headSha) {
    delete run.evidence.quality;
    invalidated = true;
  }
  if (run.evidence.verification && run.evidence.verification.headSha !== headSha) {
    delete run.evidence.verification;
    invalidated = true;
  }
  if (run.evidence.mergeReady && run.evidence.mergeReady.headSha !== headSha) {
    delete run.evidence.mergeReady;
    invalidated = true;
  }
  if (
    run.evidence &&
    !run.evidence.quality &&
    !run.evidence.verification &&
    !run.evidence.mergeReady
  ) {
    delete run.evidence;
  }
  return invalidated;
}

export async function listWorkingTreePaths(cwd: string): Promise<string[]> {
  const status = await gitExec("git", ["status", "--porcelain=v1", "--untracked-files=all"], cwd);
  if (status.exitCode !== 0) throw new Error(`git status failed: ${status.stderr}`);
  const files: string[] = [];
  for (const line of status.stdout.split("\n")) {
    if (!line.trim()) continue;
    const pathPart = line.slice(3);
    if (pathPart.includes(" -> ")) {
      files.push(pathPart.split(" -> ")[1]!.trim());
    } else {
      files.push(pathPart.trim());
    }
  }
  return files;
}

export async function assertWorkingTreeScope(
  cwd: string,
  allowedPathGlobs: string[],
): Promise<string[]> {
  const files = await listWorkingTreePaths(cwd);
  const disallowed = files.filter((file) => !pathAllowed(file, allowedPathGlobs));
  if (disallowed.length > 0) {
    throw new Error(`Change-scope violation: ${disallowed.join(", ")}`);
  }
  return files;
}

export async function ensureRunWorkspace(
  repositoryPath: string,
  run: RunRecord,
): Promise<RunWorkspace> {
  await ensureMasweGitExclude(repositoryPath);
  const base = await captureWorkspace(repositoryPath);
  if (!run.config.policy.useIsolatedWorktree) {
    return base;
  }
  if (!(await isGitRepository(repositoryPath))) {
    throw new Error("Isolated worktrees require a git repository.");
  }

  const branch = `maswe/${run.id}`;
  const worktreePath = externalWorktreePath(repositoryPath, run.id);
  await mkdir(path.dirname(worktreePath), { recursive: true });

  const createBranch = await gitExec("git", ["branch", branch, "HEAD"], repositoryPath);
  if (createBranch.exitCode !== 0 && !/already exists/i.test(createBranch.stderr)) {
    throw new Error(`Failed to create branch ${branch}: ${createBranch.stderr}`);
  }

  const addWorktree = await gitExec(
    "git",
    ["worktree", "add", worktreePath, branch],
    repositoryPath,
  );
  if (addWorktree.exitCode !== 0 && !/already exists|already checked out/i.test(addWorktree.stderr)) {
    const existing = await gitExec("git", ["rev-parse", "--is-inside-work-tree"], worktreePath);
    if (existing.exitCode !== 0) {
      throw new Error(`Failed to create worktree: ${addWorktree.stderr}`);
    }
  }

  return {
    ...base,
    branch,
    worktreePath,
    fingerprint: await gitWorkspaceFingerprint(worktreePath),
    headSha: await gitRevParse(worktreePath, "HEAD"),
  };
}

export async function createDeterministicCommit(
  cwd: string,
  message: string,
  options: { allowedPathGlobs: string[] },
): Promise<{ headSha: string; files: string[] }> {
  await assertWorkingTreeScope(cwd, options.allowedPathGlobs);

  const status = await gitExec("git", ["status", "--porcelain=v1", "--untracked-files=all"], cwd);
  if (status.exitCode !== 0) throw new Error(`git status failed: ${status.stderr}`);
  if (!status.stdout.trim()) {
    return { headSha: await gitRevParse(cwd, "HEAD"), files: [] };
  }

  const add = await gitExec("git", ["add", "-A"], cwd);
  if (add.exitCode !== 0) throw new Error(`git add failed: ${add.stderr}`);

  const staged = await gitExec("git", ["diff", "--cached", "--name-only"], cwd);
  const files = staged.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const disallowed = files.filter((file) => !pathAllowed(file, options.allowedPathGlobs));
  if (disallowed.length > 0) {
    await gitExec("git", ["reset", "HEAD"], cwd);
    throw new Error(`Change-scope violation: ${disallowed.join(", ")}`);
  }

  const commit = await gitExec("git", ["-c", "core.hooksPath=/dev/null", "commit", "-m", message], cwd);
  if (commit.exitCode !== 0) {
    throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
  }

  if (!(await isGitWorkspaceClean(cwd))) {
    throw new Error("worktree remained dirty after deterministic commit");
  }

  return { headSha: await gitRevParse(cwd, "HEAD"), files };
}

export async function assertChangeScope(
  cwd: string,
  baseSha: string,
  allowedPathGlobs: string[],
): Promise<string[]> {
  const files = await gitChangedFiles(cwd, baseSha, "HEAD");
  const disallowed = files.filter((file) => !pathAllowed(file, allowedPathGlobs));
  if (disallowed.length > 0) {
    throw new Error(`Change-scope violation versus base: ${disallowed.join(", ")}`);
  }
  return files;
}

export async function cleanupRunWorkspace(run: RunRecord): Promise<void> {
  if (!run.workspace?.worktreePath) return;
  const repositoryPath = run.repositoryPath;
  const worktreePath = run.workspace.worktreePath;
  // Preserve the failed/completed run branch ref for provenance; only remove the worktree directory.
  const removed = await gitExec("git", ["worktree", "remove", "--force", worktreePath], repositoryPath);
  if (removed.exitCode !== 0) {
    const stillThere = await gitExec("git", ["rev-parse", "--is-inside-work-tree"], worktreePath).catch(
      () => ({ exitCode: 1, stdout: "", stderr: "" }),
    );
    if (stillThere.exitCode === 0) {
      throw new Error(
        `Failed to remove managed worktree ${worktreePath}: ${removed.stderr || removed.stdout}`,
      );
    }
  }
}

export async function restoreRunWorkspace(
  repositoryPath: string,
  run: RunRecord,
): Promise<RunWorkspace> {
  await ensureMasweGitExclude(repositoryPath);
  if (!run.workspace || run.workspace.baseSha === "not-a-git-repository") {
    return captureWorkspace(repositoryPath);
  }
  if (!run.config.policy.useIsolatedWorktree) {
    return {
      ...run.workspace,
      headSha: await gitRevParse(repositoryPath, "HEAD"),
      fingerprint: await gitWorkspaceFingerprint(repositoryPath),
    };
  }

  const branch = run.workspace.branch;
  const headSha = run.workspace.headSha;
  const worktreePath = externalWorktreePath(repositoryPath, run.id);
  await mkdir(path.dirname(worktreePath), { recursive: true });

  const existing = await gitExec("git", ["rev-parse", "--verify", branch], repositoryPath);
  if (existing.exitCode !== 0) {
    const create = await gitExec("git", ["branch", branch, headSha], repositoryPath);
    if (create.exitCode !== 0) {
      throw new Error(`Failed to recreate branch ${branch} at ${headSha}: ${create.stderr}`);
    }
  } else if (existing.stdout.trim() !== headSha) {
    const force = await gitExec("git", ["branch", "-f", branch, headSha], repositoryPath);
    if (force.exitCode !== 0) {
      throw new Error(`Failed to point ${branch} at preserved headSha ${headSha}: ${force.stderr}`);
    }
  }

  const probe = await gitExec("git", ["rev-parse", "--is-inside-work-tree"], worktreePath).catch(
    () => ({ exitCode: 1, stdout: "", stderr: "missing worktree" }),
  );
  if (probe.exitCode !== 0) {
    const add = await gitExec("git", ["worktree", "add", worktreePath, branch], repositoryPath);
    if (add.exitCode !== 0) {
      throw new Error(`Failed to restore worktree at ${headSha}: ${add.stderr}`);
    }
  }

  const restoredHead = await gitRevParse(worktreePath, "HEAD");
  if (restoredHead !== headSha) {
    throw new Error(
      `Restored worktree HEAD ${restoredHead} does not match preserved headSha ${headSha}`,
    );
  }

  return {
    ...run.workspace,
    branch,
    worktreePath,
    headSha: restoredHead,
    fingerprint: await gitWorkspaceFingerprint(worktreePath),
  };
}

export function workingDirectoryFor(run: RunRecord): string {
  return run.workspace?.worktreePath ?? run.repositoryPath;
}
