import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";

export type LockKind = "data" | "admin" | "admin-recovery";

export interface LockRecoveryMetadata {
  mode: "admin-unlock";
  force: boolean;
  observedOwner?: string;
  observedState?: string;
}

export interface LockRecordV2 {
  format: 2;
  pid: number;
  owner: string;
  at: string;
  kind: LockKind;
  recovery: LockRecoveryMetadata | null;
}

export interface LockIdentity {
  dev: bigint;
  ino: bigint;
}

interface ClassifiedBase {
  lockPath: string;
  kind: LockKind;
}

interface DirectoryClassifiedBase extends ClassifiedBase {
  directoryIdentity: LockIdentity;
}

export type ClassifiedLock =
  | (ClassifiedBase & { state: "absent" })
  | (DirectoryClassifiedBase & { state: "incomplete-empty" })
  | (DirectoryClassifiedBase & {
      state: "incomplete-temporary";
      basename: string;
      entryIdentity: LockIdentity;
    })
  | (DirectoryClassifiedBase & {
      state: "valid-live" | "valid-dead";
      basename: string;
      entryIdentity: LockIdentity;
      record: LockRecordV2;
    })
  | (DirectoryClassifiedBase & {
      state: "corrupt";
      reason: string;
      basename?: string;
      entryIdentity?: LockIdentity;
    })
  | (DirectoryClassifiedBase & { state: "multiple"; entries: string[] })
  | (ClassifiedBase & {
      state: "unsafe";
      reason: string;
      directoryIdentity?: LockIdentity;
      basename?: string;
    })
  | (ClassifiedBase & {
      state: "legacy-live" | "legacy-dead";
      record: LegacyLockRecord;
      entryIdentity: LockIdentity;
    })
  | (ClassifiedBase & {
      state: "legacy-corrupt";
      reason: string;
      entryIdentity: LockIdentity;
    });

export type LockErrorCode =
  | "LOCK_LIVE_OWNER"
  | "LOCK_DEAD_OWNER"
  | "LOCK_CORRUPT"
  | "LOCK_INCOMPLETE"
  | "LOCK_UNSAFE_PATH_TYPE"
  | "LOCK_OWNERSHIP_LOST"
  | "ADMIN_RECOVERY_CONCURRENT"
  | "LOCK_DELETION_PENDING"
  | "LOCK_CLEANUP_FAILED"
  | "LOCK_UNSUPPORTED_FILESYSTEM";

export class LockProtocolError extends Error {
  readonly code: LockErrorCode;
  readonly state?: ClassifiedLock["state"];

  constructor(
    code: LockErrorCode,
    message: string,
    options: { cause?: unknown; state?: ClassifiedLock["state"] } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LockProtocolError";
    this.code = code;
    if (options.state !== undefined) this.state = options.state;
  }
}

interface LegacyLockRecord {
  pid: number;
  owner: string;
  at: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TEMP_RECORD_PATTERN = /^\.record-[0-9a-f-]+(?:-[0-9a-f-]+)?$/i;

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

export function sameIdentity(a: LockIdentity, b: LockIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function identityFromStat(
  stat: BigIntStats,
  lockPath: string,
): LockIdentity {
  if (stat.dev < 0n || stat.ino <= 0n) {
    throw new LockProtocolError(
      "LOCK_UNSUPPORTED_FILESYSTEM",
      `Stable filesystem identity is unavailable for lock path ${lockPath}`,
    );
  }
  return { dev: stat.dev, ino: stat.ino };
}

async function lstatBigInt(target: string): Promise<BigIntStats> {
  return lstat(target, { bigint: true });
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errno(error) === "EPERM";
  }
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function parseLegacy(value: unknown): LegacyLockRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (!Number.isInteger(candidate.pid) || (candidate.pid as number) <= 0) return undefined;
  if (typeof candidate.owner !== "string" || candidate.owner.length === 0) return undefined;
  if (!validTimestamp(candidate.at)) return undefined;
  return {
    pid: candidate.pid as number,
    owner: candidate.owner,
    at: candidate.at,
  };
}

function validRecoveryMetadata(
  value: unknown,
  kind: LockKind,
): value is LockRecordV2["recovery"] {
  if (kind !== "admin-recovery") return value === null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.mode !== "admin-unlock" || typeof candidate.force !== "boolean") return false;
  if (
    candidate.observedOwner !== undefined &&
    typeof candidate.observedOwner !== "string"
  ) return false;
  if (
    candidate.observedState !== undefined &&
    typeof candidate.observedState !== "string"
  ) return false;
  return true;
}

function parseV2(
  value: unknown,
  filename: string,
  expectedKind: LockKind,
): LockRecordV2 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.format !== 2) return undefined;
  if (!Number.isInteger(candidate.pid) || (candidate.pid as number) <= 0) return undefined;
  if (typeof candidate.owner !== "string" || !UUID_PATTERN.test(candidate.owner)) return undefined;
  if (filename !== candidate.owner) return undefined;
  if (!validTimestamp(candidate.at)) return undefined;
  if (candidate.kind !== expectedKind) return undefined;
  if (!validRecoveryMetadata(candidate.recovery, expectedKind)) return undefined;
  return candidate as unknown as LockRecordV2;
}

async function readRegularFileNoFollow(
  filePath: string,
  expectedIdentity: LockIdentity,
): Promise<string> {
  const noFollow = constants.O_NOFOLLOW;
  if (noFollow === undefined) {
    throw new LockProtocolError(
      "LOCK_UNSUPPORTED_FILESYSTEM",
      `Non-following file open is unavailable for lock entry ${filePath}`,
    );
  }
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (errno(error) === "ELOOP") {
      throw new LockProtocolError(
        "LOCK_UNSAFE_PATH_TYPE",
        `Lock entry ${filePath} changed to a symbolic link`,
        { cause: error },
      );
    }
    throw error;
  }
  try {
    const stat = await handle.stat({ bigint: true });
    const actualIdentity = identityFromStat(stat, filePath);
    if (!stat.isFile() || !sameIdentity(actualIdentity, expectedIdentity)) {
      throw new LockProtocolError(
        "LOCK_OWNERSHIP_LOST",
        `Lock entry identity changed while inspecting ${filePath}`,
      );
    }
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

async function classifyLegacy(
  lockPath: string,
  kind: LockKind,
  stat: BigIntStats,
): Promise<ClassifiedLock> {
  const entryIdentity = identityFromStat(stat, lockPath);
  let raw: string;
  try {
    raw = await readRegularFileNoFollow(lockPath, entryIdentity);
  } catch (error) {
    if (error instanceof LockProtocolError) throw error;
    return {
      state: "legacy-corrupt",
      lockPath,
      kind,
      entryIdentity,
      reason: `Legacy lock cannot be read: ${String(error)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      state: "legacy-corrupt",
      lockPath,
      kind,
      entryIdentity,
      reason: "Legacy lock record is not valid JSON",
    };
  }
  const record = parseLegacy(parsed);
  if (!record) {
    return {
      state: "legacy-corrupt",
      lockPath,
      kind,
      entryIdentity,
      reason: "Legacy lock record is incomplete or invalid",
    };
  }
  return {
    state: pidAlive(record.pid) ? "legacy-live" : "legacy-dead",
    lockPath,
    kind,
    record,
    entryIdentity,
  };
}

export async function classifyLockPath(
  lockPath: string,
  kind: LockKind,
): Promise<ClassifiedLock> {
  let canonicalStat: BigIntStats;
  try {
    canonicalStat = await lstatBigInt(lockPath);
  } catch (error) {
    if (errno(error) === "ENOENT") return { state: "absent", lockPath, kind };
    throw error;
  }

  if (canonicalStat.isSymbolicLink()) {
    return {
      state: "unsafe",
      lockPath,
      kind,
      reason: "Canonical lock path is a symbolic link, junction, or reparse point",
    };
  }
  if (canonicalStat.isFile()) {
    if (kind === "admin-recovery") {
      return {
        state: "unsafe",
        lockPath,
        kind,
        reason: "Administrative recovery marker cannot use the legacy regular-file format",
      };
    }
    return classifyLegacy(lockPath, kind, canonicalStat);
  }
  if (!canonicalStat.isDirectory()) {
    return {
      state: "unsafe",
      lockPath,
      kind,
      reason: "Canonical lock path is neither an ordinary directory nor a legacy regular file",
    };
  }

  const directoryIdentity = identityFromStat(canonicalStat, lockPath);
  let entries: string[];
  try {
    entries = await readdir(lockPath);
  } catch (error) {
    if (errno(error) === "ENOENT") return { state: "absent", lockPath, kind };
    throw error;
  }
  if (entries.length === 0) {
    return { state: "incomplete-empty", lockPath, kind, directoryIdentity };
  }
  if (entries.length !== 1) {
    return {
      state: "multiple",
      lockPath,
      kind,
      directoryIdentity,
      entries: [...entries].sort(),
    };
  }

  const basename = entries[0]!;
  const entryPath = path.join(lockPath, basename);
  let childStat: BigIntStats;
  try {
    childStat = await lstatBigInt(entryPath);
  } catch (error) {
    if (errno(error) === "ENOENT") {
      return {
        state: "incomplete-empty",
        lockPath,
        kind,
        directoryIdentity,
      };
    }
    throw error;
  }
  if (childStat.isSymbolicLink() || !childStat.isFile()) {
    return {
      state: "unsafe",
      lockPath,
      kind,
      directoryIdentity,
      basename,
      reason: "Lock directory contains a link, reparse point, or non-regular entry",
    };
  }
  const entryIdentity = identityFromStat(childStat, entryPath);

  if (TEMP_RECORD_PATTERN.test(basename)) {
    return {
      state: "incomplete-temporary",
      lockPath,
      kind,
      directoryIdentity,
      basename,
      entryIdentity,
    };
  }
  if (!UUID_PATTERN.test(basename)) {
    return {
      state: "corrupt",
      lockPath,
      kind,
      directoryIdentity,
      basename,
      entryIdentity,
      reason: "Final lock entry name is not a UUID",
    };
  }

  let raw: string;
  try {
    raw = await readRegularFileNoFollow(entryPath, entryIdentity);
  } catch (error) {
    if (error instanceof LockProtocolError) throw error;
    return {
      state: "corrupt",
      lockPath,
      kind,
      directoryIdentity,
      basename,
      entryIdentity,
      reason: `Lock record cannot be read: ${String(error)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      state: "corrupt",
      lockPath,
      kind,
      directoryIdentity,
      basename,
      entryIdentity,
      reason: "Lock record is not valid JSON",
    };
  }
  const record = parseV2(parsed, basename, kind);
  if (!record) {
    return {
      state: "corrupt",
      lockPath,
      kind,
      directoryIdentity,
      basename,
      entryIdentity,
      reason: "Lock record schema, owner filename, or kind is invalid",
    };
  }
  return {
    state: pidAlive(record.pid) ? "valid-live" : "valid-dead",
    lockPath,
    kind,
    directoryIdentity,
    basename,
    entryIdentity,
    record,
  };
}

export async function readLegacyLockForCompatibility(
  lockPath: string,
): Promise<LegacyLockRecord | undefined> {
  try {
    const raw = await readFile(lockPath, "utf8");
    return parseLegacy(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export type LockTransition =
  | "DIRECTORY_CLAIMED"
  | "TEMP_RECORD_CREATED"
  | "RECORD_PARTIALLY_WRITTEN"
  | "RECORD_SYNCED"
  | "TOKEN_PUBLISHED"
  | "OWNERSHIP_VALIDATED"
  | "OWNER_VALIDATED"
  | "TOKEN_REMOVED"
  | "DIRECTORY_EMPTY"
  | "RECOVERY_MARKER_OBSERVED"
  | "RECOVERY_MARKER_VALIDATED"
  | "RECOVERY_CLEANUP_COMPLETE"
  | "RECOVERY_CLAIM_COMPLETE"
  | "RECOVERY_ENTERED";

export interface LockOwnershipHandle {
  lockPath: string;
  kind: LockKind;
  owner: string;
  directoryIdentity: LockIdentity;
}

export interface AcquireDirectoryLockOptions {
  recovery?: LockRecoveryMetadata | null;
  transition?: (transition: LockTransition, owner: string) => Promise<void>;
}

function recoveryCommand(kind: LockKind, lockPath: string): string {
  const runId = path.basename(path.dirname(lockPath));
  return kind === "data"
    ? `maswe unlock ${runId}`
    : `maswe unlock-admin ${runId}`;
}

function errorForExisting(classified: ClassifiedLock): LockProtocolError {
  const command = recoveryCommand(classified.kind, classified.lockPath);
  switch (classified.state) {
    case "valid-live":
    case "legacy-live":
      return new LockProtocolError(
        "LOCK_LIVE_OWNER",
        `${classified.kind} lock at ${classified.lockPath} is held by live pid ${classified.record.pid}; refusing automatic reclaim`,
        { state: classified.state },
      );
    case "valid-dead":
    case "legacy-dead":
      return new LockProtocolError(
        "LOCK_DEAD_OWNER",
        `${classified.kind} lock at ${classified.lockPath} has a dead owner; recover explicitly with: ${command}`,
        { state: classified.state },
      );
    case "incomplete-empty":
    case "incomplete-temporary":
      return new LockProtocolError(
        "LOCK_INCOMPLETE",
        `${classified.kind} lock publication is incomplete at ${classified.lockPath}; fail closed and recover explicitly with: ${command}`,
        { state: classified.state },
      );
    case "unsafe":
      return new LockProtocolError(
        "LOCK_UNSAFE_PATH_TYPE",
        `${classified.kind} lock has an unsafe path type at ${classified.lockPath}: ${classified.reason}`,
        { state: classified.state },
      );
    case "corrupt":
    case "legacy-corrupt":
    case "multiple":
      return new LockProtocolError(
        "LOCK_CORRUPT",
        `${classified.kind} lock is corrupt at ${classified.lockPath}; refusing automatic reclaim; recover with: ${command}`,
        { state: classified.state },
      );
    case "absent":
      return new LockProtocolError(
        "LOCK_OWNERSHIP_LOST",
        `${classified.kind} lock disappeared while acquiring ${classified.lockPath}`,
        { state: classified.state },
      );
  }
}

async function currentDirectoryIdentity(lockPath: string): Promise<LockIdentity> {
  let stat: BigIntStats;
  try {
    stat = await lstatBigInt(lockPath);
  } catch (error) {
    if (errno(error) === "ENOENT") {
      throw new LockProtocolError(
        "LOCK_OWNERSHIP_LOST",
        `Claimed lock directory disappeared at ${lockPath}`,
        { cause: error },
      );
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new LockProtocolError(
      "LOCK_OWNERSHIP_LOST",
      `Claimed lock path changed type at ${lockPath}`,
    );
  }
  return identityFromStat(stat, lockPath);
}

async function requireDirectoryIdentity(
  lockPath: string,
  expected: LockIdentity,
): Promise<void> {
  const actual = await currentDirectoryIdentity(lockPath);
  if (!sameIdentity(actual, expected)) {
    throw new LockProtocolError(
      "LOCK_OWNERSHIP_LOST",
      `Claimed lock directory identity changed at ${lockPath}`,
    );
  }
}

async function requireSoleEntryIdentity(
  lockPath: string,
  directoryIdentity: LockIdentity,
  basename: string,
  entryIdentity: LockIdentity,
): Promise<void> {
  await requireDirectoryIdentity(lockPath, directoryIdentity);
  const entries = await readdir(lockPath);
  if (entries.length !== 1 || entries[0] !== basename) {
    throw new LockProtocolError(
      "LOCK_OWNERSHIP_LOST",
      `Lock publication namespace changed before token publication at ${lockPath}`,
    );
  }
  const entryPath = path.join(lockPath, basename);
  const stat = await lstatBigInt(entryPath);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    !sameIdentity(identityFromStat(stat, entryPath), entryIdentity)
  ) {
    throw new LockProtocolError(
      "LOCK_OWNERSHIP_LOST",
      `Temporary lock entry changed before token publication at ${entryPath}`,
    );
  }
}

async function cleanupOwnTemporary(
  lockPath: string,
  tempBasename: string,
  tempIdentity: LockIdentity | undefined,
): Promise<void> {
  if (!tempIdentity) return;
  await currentDirectoryIdentity(lockPath);
  const tempPath = path.join(lockPath, tempBasename);
  let stat: BigIntStats;
  try {
    stat = await lstatBigInt(tempPath);
  } catch (error) {
    if (errno(error) === "ENOENT") return;
    throw error;
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    !sameIdentity(identityFromStat(stat, tempPath), tempIdentity)
  ) {
    throw new LockProtocolError(
      "LOCK_OWNERSHIP_LOST",
      `Temporary lock entry identity changed at ${tempPath}`,
    );
  }
  await unlink(tempPath);
}

export async function acquireDirectoryLock(
  lockPath: string,
  kind: LockKind,
  options: AcquireDirectoryLockOptions = {},
): Promise<LockOwnershipHandle> {
  const owner = randomUUID();
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (errno(error) === "EEXIST") {
      throw errorForExisting(await classifyLockPath(lockPath, kind));
    }
    throw new LockProtocolError(
      "LOCK_UNSUPPORTED_FILESYSTEM",
      `Exclusive lock-directory claim failed for ${lockPath}`,
      { cause: error },
    );
  }

  let directoryIdentity: LockIdentity;
  try {
    directoryIdentity = await currentDirectoryIdentity(lockPath);
  } catch (error) {
    throw new LockProtocolError(
      "LOCK_OWNERSHIP_LOST",
      `Could not validate newly claimed lock directory ${lockPath}`,
      { cause: error },
    );
  }
  await options.transition?.("DIRECTORY_CLAIMED", owner);

  // Keep the unpublished owner UUID out of the temporary basename. Combined with a sole-entry
  // check immediately before rename, this preserves the approved collision-resistance invariant
  // without relying on a platform-specific no-replace rename primitive.
  const tempBasename = `.record-${randomUUID()}`;
  const tempPath = path.join(lockPath, tempBasename);
  let handle;
  let tempIdentity: LockIdentity | undefined;
  let handleClosed = false;
  try {
    handle = await open(tempPath, "wx", 0o600);
    const tempStat = await handle.stat({ bigint: true });
    if (!tempStat.isFile()) {
      throw new LockProtocolError(
        "LOCK_UNSAFE_PATH_TYPE",
        `Exclusive temporary lock entry is not a regular file at ${tempPath}`,
      );
    }
    tempIdentity = identityFromStat(tempStat, tempPath);
    await options.transition?.("TEMP_RECORD_CREATED", owner);

    // A remover can replace only the initially empty claimed directory. Verify immediately after
    // the exclusive child create and fail before writing if that create landed in a replacement.
    await requireDirectoryIdentity(lockPath, directoryIdentity);

    const recovery =
      kind === "admin-recovery"
        ? (options.recovery ?? { mode: "admin-unlock", force: false })
        : null;
    const record: LockRecordV2 = {
      format: 2,
      pid: process.pid,
      owner,
      at: new Date().toISOString(),
      kind,
      recovery,
    };
    const content = `${JSON.stringify(record)}\n`;
    const split = Math.max(1, Math.floor(content.length / 2));
    await handle.write(content.slice(0, split), undefined, "utf8");
    await options.transition?.("RECORD_PARTIALLY_WRITTEN", owner);
    await handle.write(content.slice(split), undefined, "utf8");
    await handle.sync();
    await handle.close();
    handleClosed = true;
    await options.transition?.("RECORD_SYNCED", owner);

    await requireSoleEntryIdentity(
      lockPath,
      directoryIdentity,
      tempBasename,
      tempIdentity,
    );
    await rename(tempPath, path.join(lockPath, owner));
    await options.transition?.("TOKEN_PUBLISHED", owner);

    const classified = await classifyLockPath(lockPath, kind);
    if (
      (classified.state !== "valid-live" && classified.state !== "valid-dead") ||
      classified.record.owner !== owner ||
      !sameIdentity(classified.directoryIdentity, directoryIdentity)
    ) {
      throw new LockProtocolError(
        "LOCK_OWNERSHIP_LOST",
        `Final ownership validation failed for ${kind} lock at ${lockPath}`,
        { state: classified.state },
      );
    }
    await options.transition?.("OWNERSHIP_VALIDATED", owner);
    return { lockPath, kind, owner, directoryIdentity };
  } catch (primaryError) {
    if (handle && !handleClosed) {
      try {
        await handle.close();
      } catch {
        // The exact cleanup error below remains authoritative.
      }
    }
    try {
      await cleanupOwnTemporary(
        lockPath,
        tempBasename,
        tempIdentity,
      );
      const cleanupIdentity = await currentDirectoryIdentity(lockPath);
      if (!sameIdentity(cleanupIdentity, directoryIdentity)) {
        throw new LockProtocolError(
          "LOCK_OWNERSHIP_LOST",
          `Claimed lock directory was replaced before temporary cleanup at ${lockPath}`,
        );
      }
      try {
        await rmdir(lockPath);
      } catch (cleanupDirectoryError) {
        if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(errno(cleanupDirectoryError) ?? "")) {
          throw cleanupDirectoryError;
        }
      }
    } catch (cleanupError) {
      const combined = new AggregateError(
        [primaryError, cleanupError],
        `Lock acquisition and exact temporary cleanup both failed at ${lockPath}`,
      );
      if (
        errno(primaryError) === "ENOENT" ||
        (primaryError instanceof LockProtocolError &&
          primaryError.code === "LOCK_OWNERSHIP_LOST") ||
        (cleanupError instanceof LockProtocolError &&
          cleanupError.code === "LOCK_OWNERSHIP_LOST")
      ) {
        throw new LockProtocolError(
          "LOCK_OWNERSHIP_LOST",
          `Claimed ${kind} lock namespace was replaced before ownership at ${lockPath}`,
          { cause: combined },
        );
      }
      throw new AggregateError(
        [primaryError, cleanupError],
        `Lock acquisition and exact temporary cleanup both failed at ${lockPath}`,
      );
    }
    throw primaryError;
  }
}

export interface ReleaseOwnedDirectoryOptions {
  transition?: (transition: LockTransition, owner: string) => Promise<void>;
  /** Platform-semantic test seam; production callers use non-recursive fs.rmdir. */
  removeEmptyDirectory?: (lockPath: string) => Promise<void>;
}

export async function removeOwnedDirectory(
  ownership: LockOwnershipHandle,
  options: ReleaseOwnedDirectoryOptions = {},
): Promise<void> {
  const classified = await classifyLockPath(ownership.lockPath, ownership.kind);
  if (
    (classified.state !== "valid-live" && classified.state !== "valid-dead") ||
    classified.record.owner !== ownership.owner ||
    classified.basename !== ownership.owner ||
    !sameIdentity(classified.directoryIdentity, ownership.directoryIdentity)
  ) {
    throw new LockProtocolError(
      "LOCK_OWNERSHIP_LOST",
      `${ownership.kind} lock ownership was lost at ${ownership.lockPath}; expected token ${ownership.owner} was not removed`,
      { state: classified.state },
    );
  }
  await options.transition?.("OWNER_VALIDATED", ownership.owner);

  const tokenPath = path.join(ownership.lockPath, ownership.owner);
  try {
    await unlink(tokenPath);
  } catch (error) {
    if (errno(error) === "ENOENT") {
      throw new LockProtocolError(
        "LOCK_OWNERSHIP_LOST",
        `${ownership.kind} lock token ${ownership.owner} disappeared before release`,
        { cause: error },
      );
    }
    throw new LockProtocolError(
      "LOCK_CLEANUP_FAILED",
      `Failed to unlink exact ${ownership.kind} lock token ${ownership.owner}`,
      { cause: error },
    );
  }
  await options.transition?.("TOKEN_REMOVED", ownership.owner);

  try {
    await (options.removeEmptyDirectory ?? rmdir)(ownership.lockPath);
    await options.transition?.("DIRECTORY_EMPTY", ownership.owner);
  } catch (error) {
    const code = errno(error);
    let current: ClassifiedLock | undefined;
    try {
      current = await classifyLockPath(ownership.lockPath, ownership.kind);
    } catch {
      // The original cleanup failure remains the cause.
    }
    if (
      current &&
      current.state !== "absent" &&
      "directoryIdentity" in current &&
      !sameIdentity(current.directoryIdentity, ownership.directoryIdentity)
    ) {
      throw new LockProtocolError(
        "LOCK_OWNERSHIP_LOST",
        `A replacement ${ownership.kind} lock survived delayed cleanup at ${ownership.lockPath}`,
        { cause: error, state: current.state },
      );
    }
    if (["EBUSY", "EPERM", "EACCES"].includes(code ?? "")) {
      throw new LockProtocolError(
        "LOCK_DELETION_PENDING",
        `${ownership.kind} lock directory deletion is pending or busy at ${ownership.lockPath}`,
        current
          ? { cause: error, state: current.state }
          : { cause: error },
      );
    }
    throw new LockProtocolError(
      "LOCK_CLEANUP_FAILED",
      `${ownership.kind} token was removed but its directory cleanup failed at ${ownership.lockPath}`,
      current
        ? { cause: error, state: current.state }
        : { cause: error },
    );
  }
}

async function removeObservedDirectoryEntry(
  classified:
    | Extract<ClassifiedLock, { state: "incomplete-temporary" }>
    | Extract<ClassifiedLock, { state: "corrupt" }>,
): Promise<void> {
  if (!classified.basename || !classified.entryIdentity) {
    throw new LockProtocolError(
      "LOCK_CORRUPT",
      `No exact regular singleton is eligible for cleanup at ${classified.lockPath}`,
      { state: classified.state },
    );
  }
  await requireDirectoryIdentity(classified.lockPath, classified.directoryIdentity);
  const entryPath = path.join(classified.lockPath, classified.basename);
  let current: BigIntStats;
  try {
    current = await lstatBigInt(entryPath);
  } catch (error) {
    throw new LockProtocolError(
      "LOCK_OWNERSHIP_LOST",
      `Observed singleton disappeared before cleanup at ${entryPath}`,
      { cause: error, state: classified.state },
    );
  }
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    !sameIdentity(identityFromStat(current, entryPath), classified.entryIdentity)
  ) {
    throw new LockProtocolError(
      "LOCK_OWNERSHIP_LOST",
      `Observed singleton identity changed before cleanup at ${entryPath}`,
      { state: classified.state },
    );
  }
  try {
    await unlink(entryPath);
  } catch (error) {
    throw new LockProtocolError(
      errno(error) === "ENOENT" ? "LOCK_OWNERSHIP_LOST" : "LOCK_CLEANUP_FAILED",
      `Exact observed singleton cleanup failed at ${entryPath}`,
      { cause: error, state: classified.state },
    );
  }
  try {
    await rmdir(classified.lockPath);
  } catch (error) {
    throw new LockProtocolError(
      "LOCK_CLEANUP_FAILED",
      `Observed singleton was removed but empty-directory cleanup failed at ${classified.lockPath}`,
      { cause: error, state: classified.state },
    );
  }
}

async function removeObservedEmptyDirectory(
  classified: Extract<ClassifiedLock, { state: "incomplete-empty" }>,
): Promise<void> {
  await requireDirectoryIdentity(classified.lockPath, classified.directoryIdentity);
  try {
    await rmdir(classified.lockPath);
  } catch (error) {
    throw new LockProtocolError(
      errno(error) === "ENOENT" ||
        errno(error) === "ENOTEMPTY" ||
        errno(error) === "EEXIST"
        ? "LOCK_OWNERSHIP_LOST"
        : "LOCK_CLEANUP_FAILED",
      `Empty-only recovery failed at ${classified.lockPath}`,
      { cause: error, state: classified.state },
    );
  }
}

async function removeObservedLegacy(
  classified:
    | Extract<ClassifiedLock, { state: "legacy-live" | "legacy-dead" }>
    | Extract<ClassifiedLock, { state: "legacy-corrupt" }>,
): Promise<void> {
  let current: BigIntStats;
  try {
    current = await lstatBigInt(classified.lockPath);
  } catch (error) {
    throw new LockProtocolError(
      "LOCK_OWNERSHIP_LOST",
      `Legacy lock disappeared before serialized recovery at ${classified.lockPath}`,
      { cause: error, state: classified.state },
    );
  }
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    !sameIdentity(identityFromStat(current, classified.lockPath), classified.entryIdentity)
  ) {
    throw new LockProtocolError(
      "LOCK_OWNERSHIP_LOST",
      `Legacy lock identity changed before serialized recovery at ${classified.lockPath}`,
      { state: classified.state },
    );
  }
  try {
    await unlink(classified.lockPath);
  } catch (error) {
    throw new LockProtocolError(
      errno(error) === "ENOENT" ? "LOCK_OWNERSHIP_LOST" : "LOCK_CLEANUP_FAILED",
      `Legacy lock cleanup failed at ${classified.lockPath}`,
      { cause: error, state: classified.state },
    );
  }
}

export async function recoverClassifiedLock(
  classified: ClassifiedLock,
  options: { force: boolean },
): Promise<void> {
  switch (classified.state) {
    case "absent":
      return;
    case "valid-live":
      if (!options.force) throw errorForExisting(classified);
      return removeOwnedDirectory({
        lockPath: classified.lockPath,
        kind: classified.kind,
        owner: classified.record.owner,
        directoryIdentity: classified.directoryIdentity,
      });
    case "valid-dead":
      return removeOwnedDirectory({
        lockPath: classified.lockPath,
        kind: classified.kind,
        owner: classified.record.owner,
        directoryIdentity: classified.directoryIdentity,
      });
    case "legacy-live":
      if (!options.force) throw errorForExisting(classified);
      return removeObservedLegacy(classified);
    case "legacy-dead":
      return removeObservedLegacy(classified);
    case "incomplete-empty":
      if (!options.force) throw errorForExisting(classified);
      return removeObservedEmptyDirectory(classified);
    case "incomplete-temporary":
      if (!options.force) throw errorForExisting(classified);
      return removeObservedDirectoryEntry(classified);
    case "corrupt":
      if (!options.force) throw errorForExisting(classified);
      return removeObservedDirectoryEntry(classified);
    case "legacy-corrupt":
      if (!options.force) throw errorForExisting(classified);
      return removeObservedLegacy(classified);
    case "unsafe":
    case "multiple":
      throw errorForExisting(classified);
  }
}
