import { createHash, type Hash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawnCaptured } from "./process.ts";

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const GIT_TIMEOUT_MS = 120_000;

/** Lock/recovery markers and write temps that may churn during normal orchestration. */
const MASWE_EPHEMERAL_BASENAMES = new Set([
  ".lock",
  ".admin.lock",
  ".admin.lock.recovering",
]);

/**
 * Authoritative MASWE paths included in the read-only fingerprint (under `cwd/.maswe`):
 * - project config files
 * - `runs/<id>/run.json`
 * - `runs/<id>/artifacts/**` (durable handoff content)
 *
 * Intentionally excluded (ephemeral / self-churn):
 * - `.lock`, `.admin.lock`, `.admin.lock.recovering`
 * - `*.tmp` write staging files
 *
 * Git-excluded files outside `.maswe` are not hashed here; they follow ordinary
 * git status/`--exclude-standard` policy. Isolated worktrees fingerprint their
 * own `cwd` (typically without a local `.maswe` store).
 */
async function hashMasweAuthoritativeState(cwd: string, hash: Hash): Promise<void> {
  const masweRoot = path.join(cwd, ".maswe");
  let entries: string[];
  try {
    entries = await readdir(masweRoot, { recursive: true });
  } catch {
    return;
  }

  const relativePaths = entries
    .map((entry) => entry.replace(/\\/g, "/"))
    .filter((relative) => {
      const base = path.posix.basename(relative);
      if (MASWE_EPHEMERAL_BASENAMES.has(base)) return false;
      if (base.endsWith(".tmp")) return false;
      return true;
    })
    .sort();

  for (const relative of relativePaths) {
    const absolute = path.join(masweRoot, relative);
    let fileStat;
    try {
      fileStat = await stat(absolute);
    } catch {
      continue;
    }
    if (!fileStat.isFile()) continue;
    hash.update(`.maswe/${relative}`);
    try {
      hash.update(await readFile(absolute));
    } catch {
      hash.update("unreadable");
    }
  }
}

/** Shared git spawn with a hard timeout so hung git cannot wedge the orchestrator. */
export async function gitRun(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<ProcessResult> {
  const result = await spawnCaptured("git", args, { cwd, timeoutMs });
  if (result.timedOut) {
    throw new Error(`git ${args.join(" ")} timed out after ${timeoutMs}ms`);
  }
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

async function run(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<ProcessResult> {
  if (command !== "git") {
    throw new Error(`Unsupported command for git-snapshot run helper: ${command}`);
  }
  return gitRun(args, cwd, timeoutMs);
}

function gitFailure(args: string[], result: ProcessResult): Error {
  const details = (result.stderr || result.stdout).trim();
  return new Error(
    `git ${args.join(" ")} failed with exit ${result.exitCode}${details ? `: ${details}` : ""}`,
  );
}

/**
 * Probe repository identity. A completed nonzero rev-parse means "not Git";
 * execution failures (spawn errors/timeouts) propagate so callers fail closed.
 */
export async function isGitRepository(cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<boolean> {
  const result = await run("git", ["rev-parse", "--is-inside-work-tree"], cwd, timeoutMs);
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

export async function isGitWorkspaceClean(cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<boolean> {
  if (!(await isGitRepository(cwd, timeoutMs))) return true;
  const args = [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ".",
    ":(exclude).maswe",
    ":(exclude).maswe/**",
  ];
  const result = await run("git", args, cwd, timeoutMs);
  if (result.exitCode !== 0) throw gitFailure(args, result);
  return result.stdout.trim().length === 0;
}

/**
 * Stable namespace hashed for non-Git working directories.
 * Workspace identity fields (`baseSha` / `headSha` / `branch`) still use the
 * literal sentinel `not-a-git-repository`; the read-only fingerprint is always
 * a SHA-256 digest so authoritative `.maswe` mutations remain detectable.
 */
const NON_GIT_FINGERPRINT_NAMESPACE = "maswe:workspace-fingerprint:non-git\0";

export async function gitWorkspaceFingerprint(
  cwd: string,
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<string> {
  const hash = createHash("sha256");
  const isGit = await isGitRepository(cwd, timeoutMs);

  if (isGit) {
    const commands = [
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      ["diff", "--binary"],
      ["diff", "--cached", "--binary"],
    ];
    for (const args of commands) {
      const result = await run("git", args, cwd, timeoutMs);
      if (result.exitCode !== 0) throw gitFailure(args, result);
      hash.update(result.stdout);
      hash.update(result.stderr);
    }

    const untrackedArgs = ["ls-files", "--others", "--exclude-standard", "-z"];
    const untracked = await run("git", untrackedArgs, cwd, timeoutMs);
    if (untracked.exitCode !== 0) throw gitFailure(untrackedArgs, untracked);
    for (const relative of untracked.stdout.split("\0").filter(Boolean).sort()) {
      try {
        hash.update(relative);
        hash.update(await readFile(path.join(cwd, relative)));
      } catch {
        hash.update("unreadable");
      }
    }
  } else {
    hash.update(NON_GIT_FINGERPRINT_NAMESPACE);
  }

  // Authoritative `.maswe` state is hashed in both Git and non-Git modes so
  // read-only roles cannot mutate handoffs without detection. Git excludes
  // hide `.maswe/` from porcelain/untracked hashing above.
  await hashMasweAuthoritativeState(cwd, hash);
  return hash.digest("hex");
}

export async function gitRevParse(cwd: string, rev = "HEAD"): Promise<string> {
  const result = await run("git", ["rev-parse", rev], cwd);
  if (result.exitCode !== 0) {
    throw new Error(`git rev-parse ${rev} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

export async function gitCurrentBranch(cwd: string): Promise<string> {
  const result = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (result.exitCode !== 0) {
    throw new Error(`git branch lookup failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

export async function gitRemoteUrl(cwd: string, name = "origin"): Promise<string | undefined> {
  const result = await run("git", ["remote", "get-url", name], cwd);
  if (result.exitCode !== 0) return undefined;
  const url = result.stdout.trim();
  return url.length > 0 ? url : undefined;
}

export async function gitChangedFiles(cwd: string, baseSha: string, headSha = "HEAD"): Promise<string[]> {
  const result = await run("git", ["diff", "--name-only", "-z", `${baseSha}...${headSha}`], cwd);
  if (result.exitCode !== 0) {
    throw new Error(`git diff failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.split("\0").filter(Boolean);
}
