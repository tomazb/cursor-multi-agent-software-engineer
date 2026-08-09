import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import {
  LockJournalError,
  initializeLockJournal,
  publishClaimRelease,
  publishLockClaim,
  recoverCurrentLock,
  validateClaimOwnership,
  type ClaimOperation,
  type JournalTransition,
  type JournalTransitionContext,
} from "../lock-journal.ts";

export type GitHubJournalKind = "association" | "check-create" | "delivery";

export type GitHubJournalErrorCode =
  | "GITHUB_JOURNAL_INVALID_OPTIONS"
  | "GITHUB_JOURNAL_INITIALIZATION_FAILED"
  | "GITHUB_JOURNAL_LEGACY_BLOCKED"
  | "GITHUB_JOURNAL_LEGACY_CHANGED"
  | "GITHUB_JOURNAL_TIMEOUT"
  | "GITHUB_JOURNAL_OWNERSHIP_FAILED"
  | "GITHUB_JOURNAL_RELEASE_FAILED";

export class GitHubJournalError extends Error {
  readonly code: GitHubJournalErrorCode;
  readonly kind: GitHubJournalKind;

  constructor(
    code: GitHubJournalErrorCode,
    kind: GitHubJournalKind,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GitHubJournalError";
    this.code = code;
    this.kind = kind;
  }
}

type LinkFile = typeof link;

export interface GitHubJournalOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  linkFile?: LinkFile;
  transition?: (
    event: JournalTransition,
    context: JournalTransitionContext,
  ) => Promise<void>;
  /** Deterministic test seam between the first and exact legacy observations. */
  afterLegacyObserved?: (legacyPath: string) => Promise<void>;
}

interface LegacyEvidence {
  path: string;
  relativePath: string;
  legacyType: "file" | "directory";
  evidenceBytes: Buffer;
  evidenceDigest: string;
  state: "dead" | "live" | "empty" | "malformed";
}

interface FileSnapshot {
  bytes: Buffer;
  identity: string;
}

interface LegacyMigrationRecord {
  format: 1;
  record: "github-legacy-lock-migration";
  kind: GitHubJournalKind;
  logicalKeyDigest: string;
  legacyPath: string;
  legacyType: "file" | "directory";
  evidenceDigest: string;
  migrationDigest: string;
}

const ASSOCIATION_KEY = "associations";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 10;
const MAX_POLL_INTERVAL_MS = 1_000;
const MAX_LEGACY_BYTES = 1024 * 1024;
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });
const JOURNAL_KINDS: GitHubJournalKind[] = [
  "association",
  "check-create",
  "delivery",
];
const OPERATION_BY_KIND: Record<GitHubJournalKind, ClaimOperation> = {
  association: "github-association",
  "check-create": "github-check-create",
  delivery: "github-delivery",
};

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function digest(bytes: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function logicalKeyDigest(logicalKey: string): string {
  return createHash("sha256").update(logicalKey).digest("hex");
}

function journalDirectory(
  githubRoot: string,
  kind: GitHubJournalKind,
  logicalKey: string,
): string {
  return path.join(githubRoot, "journals", kind, logicalKeyDigest(logicalKey));
}

function publicError(
  code: GitHubJournalErrorCode,
  kind: GitHubJournalKind,
  message: string,
  cause?: unknown,
): GitHubJournalError {
  return new GitHubJournalError(
    code,
    kind,
    message,
    cause === undefined ? {} : { cause },
  );
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  );
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function fileIdentity(stat: BigIntStats): string {
  if (stat.dev < 0n || stat.ino <= 0n) {
    throw new Error("stable filesystem identity is unavailable");
  }
  return `${stat.dev}:${stat.ino}`;
}

function directoryIdentity(stat: BigIntStats): string {
  if (stat.dev < 0n || stat.ino <= 0n || stat.ctimeNs <= 0n || stat.birthtimeNs < 0n) {
    throw new Error("stable filesystem identity is unavailable");
  }
  return `${stat.dev}:${stat.ino}:${stat.ctimeNs}:${stat.birthtimeNs}`;
}

async function readHandleExactly(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
): Promise<Buffer> {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(bytes, offset, size - offset, offset);
    if (result.bytesRead === 0) throw new Error("legacy ownership was truncated");
    offset += result.bytesRead;
  }
  return bytes;
}

async function readStableFile(filePath: string): Promise<FileSnapshot> {
  const noFollow = constants.O_NOFOLLOW;
  const nonBlock = constants.O_NONBLOCK;
  if (
    typeof noFollow !== "number" ||
    noFollow === 0 ||
    typeof nonBlock !== "number"
  ) {
    throw new Error("non-following legacy ownership reads are unavailable");
  }
  const before = await lstat(filePath, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error("legacy ownership is not an ordinary regular file");
  }
  const handle = await open(filePath, constants.O_RDONLY | noFollow | nonBlock);
  try {
    const firstStat = await handle.stat({ bigint: true });
    if (
      !firstStat.isFile() ||
      fileIdentity(firstStat) !== fileIdentity(before) ||
      firstStat.size < 0n ||
      firstStat.size > BigInt(MAX_LEGACY_BYTES)
    ) {
      throw new Error("legacy ownership changed before stable read");
    }
    const size = Number(firstStat.size);
    const first = await readHandleExactly(handle, size);
    const second = await readHandleExactly(handle, size);
    const secondStat = await handle.stat({ bigint: true });
    const after = await lstat(filePath, { bigint: true });
    if (
      !first.equals(second) ||
      fileIdentity(secondStat) !== fileIdentity(firstStat) ||
      secondStat.size !== firstStat.size ||
      after.isSymbolicLink() ||
      !after.isFile() ||
      fileIdentity(after) !== fileIdentity(firstStat)
    ) {
      throw new Error("legacy ownership changed during stable read");
    }
    return { bytes: first, identity: fileIdentity(firstStat) };
  } finally {
    await handle.close();
  }
}

function parseLegacyOwner(bytes: Buffer): { pid: number } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(STRICT_UTF8.decode(bytes));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const candidate = parsed as Record<string, unknown>;
  const hasToken = Object.hasOwn(candidate, "token");
  if (
    !exactKeys(candidate, hasToken ? ["pid", "token", "at"] : ["pid", "at"]) ||
    !Number.isSafeInteger(candidate.pid) ||
    (candidate.pid as number) <= 0 ||
    !validTimestamp(candidate.at) ||
    (hasToken &&
      (typeof candidate.token !== "string" || candidate.token.length === 0))
  ) {
    return undefined;
  }
  return { pid: candidate.pid as number };
}

function processDefinitelyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return errno(error) === "ESRCH";
  }
}

function sameEvidence(left: LegacyEvidence, right: LegacyEvidence): boolean {
  return (
    left.path === right.path &&
    left.relativePath === right.relativePath &&
    left.legacyType === right.legacyType &&
    left.evidenceDigest === right.evidenceDigest &&
    left.evidenceBytes.equals(right.evidenceBytes) &&
    left.state === right.state
  );
}

async function inspectLegacyDirectory(
  legacyPath: string,
  relativePath: string,
  before: BigIntStats,
): Promise<LegacyEvidence> {
  const beforeIdentity = directoryIdentity(before);
  const firstEntries = (await readdir(legacyPath)).sort();
  if (
    firstEntries.length > 1 ||
    (firstEntries.length === 1 && firstEntries[0] !== "owner.json")
  ) {
    return {
      path: legacyPath,
      relativePath,
      legacyType: "directory",
      evidenceBytes: Buffer.from("malformed-directory\n", "utf8"),
      evidenceDigest: digest("malformed-directory\n"),
      state: "malformed",
    };
  }

  let owner: FileSnapshot | undefined;
  if (firstEntries.length === 1) {
    try {
      owner = await readStableFile(path.join(legacyPath, "owner.json"));
    } catch {
      return {
        path: legacyPath,
        relativePath,
        legacyType: "directory",
        evidenceBytes: Buffer.from("unstable-directory\n", "utf8"),
        evidenceDigest: digest("unstable-directory\n"),
        state: "malformed",
      };
    }
  }

  const secondEntries = (await readdir(legacyPath)).sort();
  const after = await lstat(legacyPath, { bigint: true });
  if (
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    directoryIdentity(after) !== beforeIdentity ||
    firstEntries.join("\0") !== secondEntries.join("\0")
  ) {
    throw new Error("legacy directory identity changed during inspection");
  }

  const evidenceBytes = Buffer.from(
    `${JSON.stringify({
      format: 1,
      record: "github-legacy-directory-evidence",
      identity: beforeIdentity,
      ownerIdentity: owner?.identity ?? null,
      ownerDigest: owner ? digest(owner.bytes) : null,
    })}\n`,
    "utf8",
  );
  if (!owner) {
    return {
      path: legacyPath,
      relativePath,
      legacyType: "directory",
      evidenceBytes,
      evidenceDigest: digest(evidenceBytes),
      state: "empty",
    };
  }
  const parsed = parseLegacyOwner(owner.bytes);
  return {
    path: legacyPath,
    relativePath,
    legacyType: "directory",
    evidenceBytes,
    evidenceDigest: digest(evidenceBytes),
    state: parsed
      ? processDefinitelyDead(parsed.pid)
        ? "dead"
        : "live"
      : "malformed",
  };
}

async function inspectLegacy(
  legacyPath: string,
  relativePath: string,
): Promise<LegacyEvidence | undefined> {
  let stat: BigIntStats;
  try {
    stat = await lstat(legacyPath, { bigint: true });
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error("legacy ownership path is a symbolic link");
  if (stat.isDirectory()) {
    return inspectLegacyDirectory(legacyPath, relativePath, stat);
  }
  if (!stat.isFile()) throw new Error("legacy ownership path has an unsafe type");
  let snapshot: FileSnapshot;
  try {
    snapshot = await readStableFile(legacyPath);
  } catch (error) {
    throw new Error("legacy ownership changed during inspection", { cause: error });
  }
  const parsed = parseLegacyOwner(snapshot.bytes);
  return {
    path: legacyPath,
    relativePath,
    legacyType: "file",
    evidenceBytes: snapshot.bytes,
    evidenceDigest: digest(snapshot.bytes),
    state: parsed
      ? processDefinitelyDead(parsed.pid)
        ? "dead"
        : "live"
      : "malformed",
  };
}

function canonicalMigration(
  kind: GitHubJournalKind,
  logicalDigest: string,
  evidence: LegacyEvidence,
): { record: LegacyMigrationRecord; bytes: string } {
  const withoutDigest = {
    format: 1 as const,
    record: "github-legacy-lock-migration" as const,
    kind,
    logicalKeyDigest: `sha256:${logicalDigest}`,
    legacyPath: evidence.relativePath,
    legacyType: evidence.legacyType,
    evidenceDigest: evidence.evidenceDigest,
  };
  const migrationDigest = digest(`${JSON.stringify(withoutDigest)}\n`);
  const record: LegacyMigrationRecord = { ...withoutDigest, migrationDigest };
  return { record, bytes: `${JSON.stringify(record)}\n` };
}

function parseMigration(
  bytes: string,
  expected: { record: LegacyMigrationRecord; bytes: string },
): LegacyMigrationRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch (error) {
    throw new Error("legacy migration marker is not valid JSON", { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("legacy migration marker is not an object");
  }
  if (
    !exactKeys(parsed as Record<string, unknown>, [
      "format",
      "record",
      "kind",
      "logicalKeyDigest",
      "legacyPath",
      "legacyType",
      "evidenceDigest",
      "migrationDigest",
    ]) ||
    bytes !== expected.bytes
  ) {
    throw new Error("legacy migration marker conflicts with current evidence");
  }
  return expected.record;
}

async function createOrValidateDirectory(directory: string): Promise<void> {
  try {
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("GitHub journal path is not an ordinary directory");
    }
    return;
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error;
  }
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (errno(error) !== "EEXIST") throw error;
  }
  const stat = await lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("GitHub journal path is not an ordinary directory");
  }
}

async function prepareJournalDirectory(
  githubRoot: string,
  kind: GitHubJournalKind,
  logicalKey: string,
): Promise<string> {
  await mkdir(githubRoot, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(githubRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("GitHub state root is not an ordinary directory");
  }
  const journals = path.join(githubRoot, "journals");
  const kindDirectory = path.join(journals, kind);
  const target = journalDirectory(githubRoot, kind, logicalKey);
  await createOrValidateDirectory(journals);
  await createOrValidateDirectory(kindDirectory);
  await createOrValidateDirectory(target);
  return target;
}

function legacyLocation(
  githubRoot: string,
  kind: GitHubJournalKind,
  logicalDigest: string,
): { path: string; relativePath: string } | undefined {
  if (kind === "association") {
    return {
      path: path.join(githubRoot, "associations.lock"),
      relativePath: "associations.lock",
    };
  }
  if (kind === "check-create") {
    const relativePath = path.join(
      "side-effect-create-locks",
      `${logicalDigest}.json.lock`,
    );
    return { path: path.join(githubRoot, relativePath), relativePath };
  }
  return undefined;
}

async function readMarker(markerPath: string): Promise<string | undefined> {
  try {
    const stat = await lstat(markerPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("legacy migration marker is not an ordinary file");
    }
    return STRICT_UTF8.decode((await readStableFile(markerPath)).bytes);
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function publishMigration(
  journalRoot: string,
  expected: { record: LegacyMigrationRecord; bytes: string },
  linkFile: LinkFile,
): Promise<void> {
  const markerPath = path.join(journalRoot, "legacy-migration.json");
  const temporaryPath = path.join(
    journalRoot,
    `.legacy-migration.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  let primaryError: unknown;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    created = true;
    await handle.writeFile(expected.bytes, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await chmod(temporaryPath, 0o400);
    } catch {
      // Permission modes are advisory on some supported platforms.
    }
    const prepared = STRICT_UTF8.decode((await readStableFile(temporaryPath)).bytes);
    if (prepared !== expected.bytes) throw new Error("prepared migration bytes changed");
    try {
      await linkFile(temporaryPath, markerPath);
    } catch (error) {
      const existing = await readMarker(markerPath);
      if (existing === undefined) {
        throw new Error("hard-link migration publication failed", { cause: error });
      }
      parseMigration(existing, expected);
    }
    const published = await readMarker(markerPath);
    if (published === undefined) throw new Error("migration marker disappeared");
    parseMigration(published, expected);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        if (primaryError === undefined) throw error;
      }
    }
    if (created) {
      try {
        await unlink(temporaryPath);
      } catch (error) {
        if (errno(error) !== "ENOENT" && primaryError === undefined) throw error;
      }
    }
  }
}

async function migrateLegacy(
  githubRoot: string,
  journalRoot: string,
  kind: GitHubJournalKind,
  logicalKey: string,
  options: GitHubJournalOptions,
): Promise<void> {
  const logicalDigest = logicalKeyDigest(logicalKey);
  const location = legacyLocation(githubRoot, kind, logicalDigest);
  if (!location) return;
  let observed: LegacyEvidence | undefined;
  try {
    observed = await inspectLegacy(location.path, location.relativePath);
  } catch (error) {
    throw publicError(
      "GITHUB_JOURNAL_LEGACY_CHANGED",
      kind,
      `GitHub ${kind} journal migration evidence changed`,
      error,
    );
  }
  const markerPath = path.join(journalRoot, "legacy-migration.json");
  if (!observed) {
    if ((await readMarker(markerPath)) !== undefined) {
      throw publicError(
        "GITHUB_JOURNAL_LEGACY_CHANGED",
        kind,
        `GitHub ${kind} journal migration evidence changed`,
      );
    }
    return;
  }
  if (observed.state === "live") {
    throw publicError(
      "GITHUB_JOURNAL_LEGACY_BLOCKED",
      kind,
      `GitHub ${kind} journal migration is blocked by legacy ownership`,
    );
  }
  if (observed.state === "malformed") {
    throw publicError(
      "GITHUB_JOURNAL_LEGACY_BLOCKED",
      kind,
      `GitHub ${kind} journal migration is blocked by malformed legacy ownership`,
    );
  }

  await options.afterLegacyObserved?.(location.path);
  let exact: LegacyEvidence | undefined;
  try {
    exact = await inspectLegacy(location.path, location.relativePath);
  } catch (error) {
    throw publicError(
      "GITHUB_JOURNAL_LEGACY_CHANGED",
      kind,
      `GitHub ${kind} journal migration evidence changed`,
      error,
    );
  }
  if (!exact || !sameEvidence(observed, exact)) {
    throw publicError(
      "GITHUB_JOURNAL_LEGACY_CHANGED",
      kind,
      `GitHub ${kind} journal migration evidence changed`,
    );
  }

  const canonical = canonicalMigration(kind, logicalDigest, exact);
  try {
    await publishMigration(journalRoot, canonical, options.linkFile ?? link);
  } catch (error) {
    throw publicError(
      "GITHUB_JOURNAL_INITIALIZATION_FAILED",
      kind,
      `GitHub ${kind} journal initialization failed`,
      error,
    );
  }
  let after: LegacyEvidence | undefined;
  try {
    after = await inspectLegacy(location.path, location.relativePath);
  } catch (error) {
    throw publicError(
      "GITHUB_JOURNAL_LEGACY_CHANGED",
      kind,
      `GitHub ${kind} journal migration evidence changed`,
      error,
    );
  }
  if (!after || !sameEvidence(exact, after)) {
    throw publicError(
      "GITHUB_JOURNAL_LEGACY_CHANGED",
      kind,
      `GitHub ${kind} journal migration evidence changed`,
    );
  }
}

async function initializeOne(
  githubRoot: string,
  kind: GitHubJournalKind,
  logicalKey: string,
  options: GitHubJournalOptions,
): Promise<string> {
  let target: string;
  try {
    target = await prepareJournalDirectory(githubRoot, kind, logicalKey);
    await initializeLockJournal(
      target,
      options.linkFile ? { linkFile: options.linkFile } : {},
    );
  } catch (error) {
    if (error instanceof GitHubJournalError) throw error;
    throw publicError(
      "GITHUB_JOURNAL_INITIALIZATION_FAILED",
      kind,
      `GitHub ${kind} journal initialization failed`,
      error,
    );
  }
  await migrateLegacy(githubRoot, target, kind, logicalKey, options);
  return target;
}

export async function initializeGitHubJournals(
  githubRoot: string,
  options: GitHubJournalOptions = {},
): Promise<void> {
  await initializeOne(githubRoot, "association", ASSOCIATION_KEY, options);
}

function validateOptions(
  kind: GitHubJournalKind,
  options: GitHubJournalOptions,
): { timeoutMs: number; pollIntervalMs: number } {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > MAX_TIMEOUT_MS ||
    !Number.isInteger(pollIntervalMs) ||
    pollIntervalMs < 1 ||
    pollIntervalMs > MAX_POLL_INTERVAL_MS
  ) {
    throw publicError(
      "GITHUB_JOURNAL_INVALID_OPTIONS",
      kind,
      `GitHub ${kind} journal options are invalid`,
    );
  }
  return { timeoutMs, pollIntervalMs };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isWaitingError(error: unknown): boolean {
  return (
    error instanceof LockJournalError &&
    (error.code === "LOCK_QUEUED" ||
      error.code === "LOCK_LIVE_OWNER" ||
      error.code === "LOCK_DEAD_OWNER")
  );
}

export async function withGitHubJournal<T>(
  githubRoot: string,
  kind: GitHubJournalKind,
  logicalKey: string,
  callback: () => Promise<T>,
  options: GitHubJournalOptions = {},
): Promise<T> {
  if (!JOURNAL_KINDS.includes(kind) || typeof logicalKey !== "string" || !logicalKey) {
    throw publicError(
      "GITHUB_JOURNAL_INVALID_OPTIONS",
      kind,
      `GitHub ${kind} journal options are invalid`,
    );
  }
  const { timeoutMs, pollIntervalMs } = validateOptions(kind, options);
  await initializeGitHubJournals(githubRoot, options);
  const target =
    kind === "association"
      ? journalDirectory(githubRoot, kind, logicalKey)
      : await initializeOne(githubRoot, kind, logicalKey, options);
  const publishOptions = {
    ...(options.linkFile ? { linkFile: options.linkFile } : {}),
    ...(options.transition ? { transition: options.transition } : {}),
  };
  let handle;
  try {
    handle = await publishLockClaim(
      target,
      "data",
      OPERATION_BY_KIND[kind],
      publishOptions,
    );
  } catch (error) {
    throw publicError(
      "GITHUB_JOURNAL_OWNERSHIP_FAILED",
      kind,
      `GitHub ${kind} journal ownership failed`,
      error,
    );
  }

  const started = Date.now();
  let primaryError: unknown;
  try {
    for (;;) {
      try {
        await validateClaimOwnership(handle, publishOptions);
      } catch (error) {
        if (!(error instanceof LockJournalError) || error.code !== "LOCK_QUEUED") {
          throw publicError(
            "GITHUB_JOURNAL_OWNERSHIP_FAILED",
            kind,
            `GitHub ${kind} journal ownership failed`,
            error,
          );
        }
        try {
          await recoverCurrentLock(target, "data", {
            force: false,
            ...(options.linkFile ? { linkFile: options.linkFile } : {}),
            ...(options.transition ? { transition: options.transition } : {}),
          });
        } catch (recoveryError) {
          if (!isWaitingError(recoveryError)) {
            throw publicError(
              "GITHUB_JOURNAL_OWNERSHIP_FAILED",
              kind,
              `GitHub ${kind} journal ownership failed`,
              recoveryError,
            );
          }
        }

        if (Date.now() - started >= timeoutMs) {
          throw publicError(
            "GITHUB_JOURNAL_TIMEOUT",
            kind,
            `Timed out acquiring GitHub ${kind} journal`,
          );
        }
        await sleep(pollIntervalMs);
        continue;
      }
      return await callback();
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await publishClaimRelease(handle, publishOptions);
    } catch (error) {
      const releaseError = publicError(
        "GITHUB_JOURNAL_RELEASE_FAILED",
        kind,
        `GitHub ${kind} journal release failed`,
        error,
      );
      if (primaryError !== undefined) {
        throw new AggregateError(
          [primaryError, releaseError],
          `GitHub ${kind} journal operation and release both failed`,
        );
      }
      throw releaseError;
    }
  }
}
