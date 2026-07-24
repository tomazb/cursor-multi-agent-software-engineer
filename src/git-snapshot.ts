import { createHash, type Hash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
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
const JOURNAL_KINDS = new Set(["data", "admin", "admin-recovery"]);
const JOURNAL_CLAIM_BASENAME = /^([0-9]{20})\.json$/;
const JOURNAL_EXACT_RELEASE_BASENAME =
  /^(data|admin|admin-recovery)\.([0-9]{20})\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[0-9a-f]{64}\.json$/;
const JOURNAL_RAW_RELEASE_BASENAME =
  /^(data|admin|admin-recovery)\.([0-9]{20})\.raw\.[0-9a-f]{64}\.json$/;
const JOURNAL_TEMP_BASENAME =
  /^\.(?:claim|release|link-probe|format)\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\.published)?\.tmp$/;

function isKnownJournalSynchronizationPath(segments: string[]): boolean {
  if (
    segments.length < 3 ||
    segments[0] !== "runs" ||
    segments[1] === "" ||
    segments[2] !== ".lock-journal-v3"
  ) {
    return false;
  }
  const journal = segments.slice(3);
  if (journal.length === 0) return true;
  if (journal.length === 1) {
    return journal[0] === "format.json" || JOURNAL_KINDS.has(journal[0]!);
  }
  if (!JOURNAL_KINDS.has(journal[0]!)) return false;
  if (journal.length === 2) {
    return ["claims", "releases", "tmp"].includes(journal[1]!);
  }
  if (journal.length !== 3) return false;
  if (journal[1] === "claims") {
    const claim = JOURNAL_CLAIM_BASENAME.exec(journal[2]!);
    return Boolean(claim && claim[1] !== "00000000000000000000");
  }
  if (journal[1] === "releases") {
    const exact = JOURNAL_EXACT_RELEASE_BASENAME.exec(journal[2]!);
    if (exact) {
      return exact[1] === journal[0] && exact[2] !== "00000000000000000000";
    }
    const raw = JOURNAL_RAW_RELEASE_BASENAME.exec(journal[2]!);
    return Boolean(raw && raw[1] === journal[0]);
  }
  if (journal[1] === "tmp") return JOURNAL_TEMP_BASENAME.test(journal[2]!);
  return false;
}

function isRunJournalPath(segments: string[]): boolean {
  return (
    segments.length >= 3 &&
    segments[0] === "runs" &&
    segments[1] !== "" &&
    segments[2] === ".lock-journal-v3"
  );
}

/**
 * Authoritative MASWE paths included in the read-only fingerprint (under `cwd/.maswe`):
 * - project config files
 * - `runs/<id>/run.json`
 * - `runs/<id>/artifacts/**` (durable handoff content)
 *
 * Intentionally excluded (ephemeral / self-churn):
 * - `.lock`, `.admin.lock`, `.admin.lock.recovering`
 * - canonical entries in exact `runs/<run-id>/.lock-journal-v3/` journals
 *   (unexpected or malformed entries remain fingerprint-visible)
 * - `*.tmp` write staging files
 *
 * The Git-plane fingerprint pathspec-excludes `.maswe/` entirely; this hasher is
 * the sole `.maswe` input. Other Git-excluded paths outside `.maswe` follow
 * ordinary `--exclude-standard` policy. Isolated worktrees fingerprint their
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
      const segments = relative.split("/");
      if (isRunJournalPath(segments)) {
        return !isKnownJournalSynchronizationPath(segments);
      }
      if (base.endsWith(".tmp")) return false;
      return true;
    })
    .sort();

  for (const relative of relativePaths) {
    const absolute = path.join(masweRoot, relative);
    let fileStat;
    try {
      fileStat = await lstat(absolute);
    } catch {
      continue;
    }
    const identity = `.maswe/${relative}`;
    const journalEntry = isRunJournalPath(relative.split("/"));
    if (fileStat.isSymbolicLink() && journalEntry) {
      hash.update(`${identity}\0symlink\0`);
      try {
        hash.update(await readlink(absolute));
      } catch {
        hash.update("unreadable");
      }
    } else if (fileStat.isFile()) {
      hash.update(`${identity}\0file\0`);
      try {
        hash.update(await readFile(absolute));
      } catch {
        hash.update("unreadable");
      }
    } else if (fileStat.isDirectory() && journalEntry) {
      hash.update(`${identity}\0directory\0`);
    } else if (journalEntry) {
      hash.update(`${identity}\0other\0`);
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

const MASWE_GIT_PATHSPEC_EXCLUDES = [".", ":(exclude).maswe", ":(exclude).maswe/**"] as const;

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
    ...MASWE_GIT_PATHSPEC_EXCLUDES,
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
    // Explicit pathspecs exclude `.maswe` from the Git plane so fingerprinting
    // does not depend on `.git/info/exclude` having been modified beforehand.
    // Authoritative `.maswe` state is hashed separately below.
    const commands = [
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...MASWE_GIT_PATHSPEC_EXCLUDES],
      ["diff", "--binary", "--", ...MASWE_GIT_PATHSPEC_EXCLUDES],
      ["diff", "--cached", "--binary", "--", ...MASWE_GIT_PATHSPEC_EXCLUDES],
    ];
    for (const args of commands) {
      const result = await run("git", args, cwd, timeoutMs);
      if (result.exitCode !== 0) throw gitFailure(args, result);
      hash.update(result.stdout);
      hash.update(result.stderr);
    }

    const untrackedArgs = [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ...MASWE_GIT_PATHSPEC_EXCLUDES,
    ];
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
  // read-only roles cannot mutate handoffs without detection. The Git-plane
  // probes above already pathspec-exclude `.maswe/`; do not double-count it.
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

/**
 * Sanitize a Git remote URL for durable provenance.
 * Removes username/password userinfo from parsed URLs. Preserves SCP-style
 * `git@host:path` remotes. Omits malformed credential-like values rather than
 * persisting raw secrets when parsing fails.
 */
export function sanitizeGitRemoteUrl(url: string): string | undefined {
  const trimmed = url.trim();
  if (!trimmed) return undefined;

  // SCP-style SSH: git@host:path (optional user@). Not equivalent to password userinfo.
  const scpStyle = /^(?:[\w.-]+@)?[\w.-]+:(?!\/\/).+$/;
  if (scpStyle.test(trimmed) && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return trimmed;
  }

  const looksCredentialBearing = /(?:\/\/|@)[^/@\s]*:[^/@\s]+@/.test(trimmed) || /:\/\/[^/@\s]+:[^/@\s]+@/.test(trimmed);

  try {
    const parsed = new URL(trimmed);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
      // URL() may leave an empty "://" userinfo marker; normalize away.
      return parsed.toString().replace(/^(https?:\/\/)@/i, "$1").replace(/^(ssh:\/\/)@/i, "$1");
    }
    return trimmed;
  } catch {
    if (looksCredentialBearing || /:\/\/[^/]*@/.test(trimmed)) {
      return undefined;
    }
    // Non-URL remotes without obvious credentials (e.g. local paths) stay as-is.
    return trimmed;
  }
}

export async function gitRemoteUrl(cwd: string, name = "origin"): Promise<string | undefined> {
  // Read the configured remote URL (not the insteadOf-rewritten effective URL)
  // so environment credential helpers cannot inject secrets into provenance.
  const result = await run("git", ["config", "--get", `remote.${name}.url`], cwd);
  if (result.exitCode !== 0) return undefined;
  const url = result.stdout.trim();
  return url.length > 0 ? sanitizeGitRemoteUrl(url) : undefined;
}

export async function gitChangedFiles(cwd: string, baseSha: string, headSha = "HEAD"): Promise<string[]> {
  const result = await run("git", ["diff", "--name-only", "-z", `${baseSha}...${headSha}`], cwd);
  if (result.exitCode !== 0) {
    throw new Error(`git diff failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.split("\0").filter(Boolean);
}
