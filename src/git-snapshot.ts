import { createHash, type Hash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { isCanonicalJournalFingerprintEntry } from "./lock-journal.ts";
import {
  RUN_MUTATION_JOURNAL_DIRECTORY,
  runMutationJournalRoot,
} from "./run-mutation.ts";
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
function isRunJournalPath(segments: string[]): boolean {
  return (
    segments.length >= 3 &&
    segments[0] === "runs" &&
    segments[1] !== "" &&
    segments[2] === ".lock-journal-v3"
  );
}

function isRunMutationJournalPath(segments: string[]): boolean {
  return (
    segments.length >= 3 &&
    segments[0] === "runs" &&
    segments[1] !== "" &&
    segments[2] === RUN_MUTATION_JOURNAL_DIRECTORY
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
 * - canonical entries in exact
 *   `runs/<run-id>/.mutation-journal-v1/.lock-journal-v3/` journals
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
    .map((entry) => (path.sep === "\\" ? entry.replace(/\\/g, "/") : entry))
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
    const segments = relative.split("/");
    const base = path.posix.basename(relative);
    const journalEntry = isRunJournalPath(segments);
    const mutationJournalEntry = isRunMutationJournalPath(segments);
    if (
      journalEntry &&
      await isCanonicalJournalFingerprintEntry(
        path.join(masweRoot, "runs", segments[1]!),
        segments.slice(3),
      )
    ) {
      continue;
    }
    if (mutationJournalEntry) {
      const mutationRoot = runMutationJournalRoot(cwd, segments[1]!);
      if (segments.length === 3) {
        if (fileStat.isDirectory() && !fileStat.isSymbolicLink()) continue;
      } else if (
        segments[3] === ".lock-journal-v3" &&
        await isCanonicalJournalFingerprintEntry(mutationRoot, segments.slice(4))
      ) {
        continue;
      }
    }
    if (
      !journalEntry &&
      fileStat.isFile() &&
      (MASWE_EPHEMERAL_BASENAMES.has(base) || base.endsWith(".tmp"))
    ) {
      continue;
    }
    if (fileStat.isSymbolicLink()) {
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
    } else if (fileStat.isDirectory()) {
      hash.update(`${identity}\0directory\0`);
    } else {
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

const WORKSPACE_SOURCE_FINGERPRINT_NAMESPACE = "maswe:workspace-source-fingerprint:v1\0";

function updateLengthFramed(hash: Hash, value: string | Uint8Array): void {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  hash.update(length);
  hash.update(bytes);
}

/** Fixed three-field records make path/type/payload concatenation injective. */
function updateSourceRecord(
  hash: Hash,
  identity: string,
  type: string,
  payload: string | Uint8Array = "",
): void {
  updateLengthFramed(hash, identity);
  updateLengthFramed(hash, type);
  updateLengthFramed(hash, payload);
}

async function hashLegacyGitWorkspaceSource(
  cwd: string,
  hash: Hash,
  timeoutMs: number,
): Promise<void> {
  // Explicit pathspecs exclude `.maswe` from the Git plane so source identity
  // does not depend on `.git/info/exclude` having been modified beforehand.
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
}

async function hashFramedGitWorkspaceSource(
  cwd: string,
  hash: Hash,
  timeoutMs: number,
): Promise<void> {
  const commands = [
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...MASWE_GIT_PATHSPEC_EXCLUDES],
    ["diff", "--binary", "--", ...MASWE_GIT_PATHSPEC_EXCLUDES],
    ["diff", "--cached", "--binary", "--", ...MASWE_GIT_PATHSPEC_EXCLUDES],
  ];
  for (const args of commands) {
    const result = await run("git", args, cwd, timeoutMs);
    if (result.exitCode !== 0) throw gitFailure(args, result);
    const identity = JSON.stringify(args);
    updateSourceRecord(hash, identity, "stdout", result.stdout);
    updateSourceRecord(hash, identity, "stderr", result.stderr);
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
      updateSourceRecord(hash, relative, "file", await readFile(path.join(cwd, relative)));
    } catch {
      updateSourceRecord(hash, relative, "unreadable");
    }
  }
}

async function hashNonGitWorkspaceSource(cwd: string, hash: Hash): Promise<void> {
  // Root enumeration is authoritative for a non-Git source tree. Propagate any
  // failure rather than hashing an inaccessible tree as though it were empty.
  const entries = await readdir(cwd, { recursive: true });

  const relativePaths = entries
    .map((entry) => (path.sep === "\\" ? entry.replace(/\\/g, "/") : entry))
    .filter((entry) => entry !== ".maswe" && !entry.startsWith(".maswe/"))
    .sort();

  for (const relative of relativePaths) {
    const absolute = path.join(cwd, relative);
    let fileStat;
    try {
      fileStat = await lstat(absolute);
    } catch {
      updateSourceRecord(hash, relative, "unreadable");
      continue;
    }

    if (fileStat.isSymbolicLink()) {
      try {
        updateSourceRecord(hash, relative, "symlink", await readlink(absolute));
      } catch {
        updateSourceRecord(hash, relative, "symlink-unreadable");
      }
    } else if (fileStat.isFile()) {
      try {
        updateSourceRecord(hash, relative, "file", await readFile(absolute));
      } catch {
        updateSourceRecord(hash, relative, "file-unreadable");
      }
    } else if (fileStat.isDirectory()) {
      updateSourceRecord(hash, relative, "directory");
    } else {
      updateSourceRecord(hash, relative, "other");
    }
  }
}

/**
 * Deterministic source-only workspace identity for bootstrap decisions.
 *
 * This intentionally excludes all `.maswe` state. Read-only enforcement must
 * use `gitWorkspaceFingerprint()` so authoritative handoffs remain covered.
 */
export async function captureWorkspaceSourceFingerprint(
  cwd: string,
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<string> {
  const hash = createHash("sha256");
  hash.update(WORKSPACE_SOURCE_FINGERPRINT_NAMESPACE);

  if (await isGitRepository(cwd, timeoutMs)) {
    await hashFramedGitWorkspaceSource(cwd, hash, timeoutMs);
  } else {
    hash.update(NON_GIT_FINGERPRINT_NAMESPACE);
    await hashNonGitWorkspaceSource(cwd, hash);
  }

  return hash.digest("hex");
}

export async function gitWorkspaceFingerprint(
  cwd: string,
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<string> {
  const hash = createHash("sha256");
  if (await isGitRepository(cwd, timeoutMs)) {
    // Schema-v1 compatibility contract: keep the historical raw Git probe and
    // untracked-file bytes as the authoritative fingerprint input. The
    // separately namespaced source-only digest is intentionally not nested
    // here because doing so changes every persisted Git workspace fingerprint.
    await hashLegacyGitWorkspaceSource(cwd, hash, timeoutMs);
  } else {
    // Preserve the read-only non-Git contract: ordinary source files are not
    // authoritative state. Bootstrap source identity above still includes them.
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
