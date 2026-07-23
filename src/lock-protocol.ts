import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  open,
  readFile,
  readdir,
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
  const entries = await readdir(lockPath);
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
        state: "corrupt",
        lockPath,
        kind,
        directoryIdentity,
        reason: "Lock entry disappeared during classification",
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
