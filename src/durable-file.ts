import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const MAX_AUTHORITATIVE_FILE_BYTES = 1024 * 1024;

export interface BoundedReadOptions {
  /** Dependency seam used to prove fail-closed behavior on platforms without O_NOFOLLOW. */
  noFollowFlag?: number | null;
  /** Runs after the open handle is statted; useful for detecting concurrent file growth. */
  afterStat?: () => Promise<void>;
}

export class DurableAtomicWriteOutcomeUnknownError extends Error {
  readonly code = "DURABLE_ATOMIC_WRITE_OUTCOME_UNKNOWN";
  readonly published = true;

  constructor(label: string, cause: unknown) {
    super(`${label} was published but its directory sync failed`, { cause });
    this.name = "DurableAtomicWriteOutcomeUnknownError";
  }
}

/** Find an indeterminate durable publication through nested/cyclic error wrappers. */
export function containsDurableAtomicWriteOutcomeUnknown(error: unknown): boolean {
  const pending: unknown[] = [error];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (candidate instanceof DurableAtomicWriteOutcomeUnknownError) return true;
    if (
      (typeof candidate !== "object" || candidate === null) &&
      typeof candidate !== "function"
    ) {
      continue;
    }
    if (visited.has(candidate)) continue;
    visited.add(candidate);
    if (candidate instanceof AggregateError) pending.push(...candidate.errors);
    if (candidate instanceof Error && candidate.cause !== undefined) {
      pending.push(candidate.cause);
    }
  }
  return false;
}

export interface DurableFileOptions {
  syncFile?: (handle: FileHandle, filePath: string) => Promise<void>;
  syncDirectory?: (directoryPath: string) => Promise<void>;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function throwWithCleanup(
  primary: unknown,
  cleanupErrors: unknown[],
  message: string,
): void {
  if (primary !== undefined) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError([primary, ...cleanupErrors], message, { cause: primary });
    }
    throw primary;
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, message);
}

function sameIdentity(
  first: { dev: number | bigint; ino: number | bigint },
  second: { dev: number | bigint; ino: number | bigint },
): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

async function defaultSyncDirectory(directoryPath: string): Promise<void> {
  const handle = await open(directoryPath, "r");
  let primary: unknown;
  try {
    await handle.sync();
  } catch (error) {
    primary = error;
  }
  const cleanupErrors: unknown[] = [];
  try {
    await handle.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  throwWithCleanup(primary, cleanupErrors, `Directory sync cleanup failed for ${directoryPath}`);
}

/** Reject namespace substitution through a symlink or non-directory local object. */
export async function requireOrdinaryDirectory(
  directoryPath: string,
  label: string,
): Promise<void> {
  const stat = await lstat(directoryPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be an ordinary local directory`);
  }
}

/** Create one directory level and order its directory entry before dependent writes. */
export async function ensureOrdinaryDirectory(
  directoryPath: string,
  label: string,
  options: DurableFileOptions = {},
): Promise<void> {
  try {
    await requireOrdinaryDirectory(directoryPath, label);
    return;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const parent = path.dirname(directoryPath);
  await requireOrdinaryDirectory(parent, `${label} parent`);
  try {
    await mkdir(directoryPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await requireOrdinaryDirectory(directoryPath, label);
  await syncDurableDirectory(parent, options);
}

/** Durably order a directory update through the shared sync seam. */
export async function syncDurableDirectory(
  directoryPath: string,
  options: DurableFileOptions = {},
): Promise<void> {
  await (options.syncDirectory ?? defaultSyncDirectory)(directoryPath);
}

/** Remove one ordinary file and durably order the containing-directory update. */
export async function removeDurableFile(
  filePath: string,
  label: string,
  options: DurableFileOptions = {},
): Promise<void> {
  const directory = path.dirname(filePath);
  await requireOrdinaryDirectory(directory, `${label} namespace`);
  const target = await lstat(filePath);
  if (target.isSymbolicLink() || !target.isFile()) {
    throw new Error(`${label} must be an ordinary local file`);
  }
  await unlink(filePath);
  await syncDurableDirectory(directory, options);
}

/** Read one regular file without following its final path and without unbounded allocation. */
export async function readBoundedOrdinaryFile(
  filePath: string,
  label: string,
  maxBytes = MAX_AUTHORITATIVE_FILE_BYTES,
  options: BoundedReadOptions = {},
): Promise<string> {
  const before = await lstat(filePath);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`${label} must be an ordinary local file`);
  }
  if (before.size > maxBytes) {
    throw new Error(`${label} exceeds the bounded ${maxBytes}-byte limit`);
  }
  const noFollow = options.noFollowFlag === undefined
    ? constants.O_NOFOLLOW
    : options.noFollowFlag;
  if (typeof noFollow !== "number" || noFollow === 0) {
    throw new Error(`${label} cannot be read safely: no-follow support is unavailable`);
  }
  let handle: FileHandle;
  try {
    handle = await open(filePath, constants.O_RDONLY | noFollow);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(`${label} must be an ordinary local file`, { cause: error });
    }
    throw error;
  }
  let result: string | undefined;
  let primary: unknown;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !sameIdentity(before, stat)) {
      throw new Error(`${label} changed identity while opening`);
    }
    if (stat.size > maxBytes) {
      throw new Error(`${label} exceeds the bounded ${maxBytes}-byte limit`);
    }
    await options.afterStat?.();
    const bytes = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < bytes.length) {
      const chunk = await handle.read(bytes, total, bytes.length - total, null);
      if (chunk.bytesRead === 0) break;
      total += chunk.bytesRead;
    }
    if (total > maxBytes) {
      throw new Error(`${label} exceeds the bounded ${maxBytes}-byte limit`);
    }
    result = bytes.subarray(0, total).toString("utf8");
    const after = await lstat(filePath);
    if (after.isSymbolicLink() || !after.isFile() || !sameIdentity(stat, after)) {
      throw new Error(`${label} changed identity while reading`);
    }
  } catch (error) {
    primary = error;
  }
  const cleanupErrors: unknown[] = [];
  try {
    await handle.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  throwWithCleanup(primary, cleanupErrors, `${label} read and cleanup both failed`);
  return result as string;
}

/** Publish bytes only after syncing the temp file and the containing directory. */
export async function writeDurableAtomic(
  filePath: string,
  content: string,
  label: string,
  options: DurableFileOptions = {},
): Promise<void> {
  const directory = path.dirname(filePath);
  await ensureOrdinaryDirectory(directory, `${label} namespace`, options);
  try {
    const target = await lstat(filePath);
    if (target.isSymbolicLink() || !target.isFile()) {
      throw new Error(`${label} must be an ordinary local file`);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const tempPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  let published = false;
  let primary: unknown;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await (options.syncFile ?? ((candidate) => candidate.sync()))(handle, tempPath);
    await handle.close();
    handle = undefined;
    await rename(tempPath, filePath);
    published = true;
    await syncDurableDirectory(directory, options);
  } catch (error) {
    primary = error;
  }
  const cleanupErrors: unknown[] = [];
  if (handle) {
    try {
      await handle.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (!published) {
    try {
      await unlink(tempPath);
    } catch (error) {
      if (!isMissing(error)) cleanupErrors.push(error);
    }
  }
  if (primary !== undefined && published) {
    primary = new DurableAtomicWriteOutcomeUnknownError(label, primary);
  }
  throwWithCleanup(primary, cleanupErrors, `${label} write and cleanup both failed`);
}
