import { link, readFile, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Conservative liveness probe matching the lock-journal policy:
 * ESRCH (and similar) ⇒ dead; EPERM ⇒ alive (pid exists but is not signalable).
 */
export function processAliveConservative(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errno(error) === "EPERM";
  }
}

export interface ReclaimHooks {
  /** Test hook after the owner is confirmed dead, before bytes-matched unlink. */
  afterDeadConfirmed?: (lockPath: string) => Promise<void>;
}

/**
 * Unlink `filePath` only if its bytes are still exactly `expectedRaw`.
 * Uses a hardlink snapshot + inode check so a successor replacement is not deleted.
 */
export async function unlinkIfBytesMatch(
  filePath: string,
  expectedRaw: string,
): Promise<boolean> {
  const snapPath = `${filePath}.${randomUUID()}.snap`;
  try {
    await link(filePath, snapPath);
  } catch (error) {
    if (errno(error) === "ENOENT") return false;
    throw error;
  }

  try {
    const snapRaw = await readFile(snapPath, "utf8");
    if (snapRaw !== expectedRaw) return false;

    let pathStat;
    let snapStat;
    try {
      [pathStat, snapStat] = await Promise.all([stat(filePath), stat(snapPath)]);
    } catch (error) {
      if (errno(error) === "ENOENT") return false;
      throw error;
    }
    if (pathStat.ino !== snapStat.ino || pathStat.dev !== snapStat.dev) {
      return false;
    }
    try {
      await unlink(filePath);
      return true;
    } catch (error) {
      if (errno(error) === "ENOENT") return false;
      throw error;
    }
  } finally {
    try {
      await unlink(snapPath);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Reclaim a lock file only when its owner pid is confirmed dead and the on-disk
 * bytes are still the observed dead-owner record. Never deletes on ambiguous
 * filesystem errors. Malformed JSON is reclaimable only via bytes-match unlink
 * of the exact observed corrupt payload (not a blind pathname delete).
 */
export async function reclaimDeadOwnerLock(
  lockPath: string,
  hooks: ReclaimHooks = {},
): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (error) {
    if (errno(error) === "ENOENT") return false;
    // Non-ENOENT read errors must not authorize deletion.
    return false;
  }

  let meta: { pid?: number; token?: string };
  try {
    meta = JSON.parse(raw) as { pid?: number; token?: string };
  } catch {
    await hooks.afterDeadConfirmed?.(lockPath);
    return unlinkIfBytesMatch(lockPath, raw);
  }

  const pid = typeof meta.pid === "number" ? meta.pid : -1;
  if (processAliveConservative(pid)) return false;

  await hooks.afterDeadConfirmed?.(lockPath);
  return unlinkIfBytesMatch(lockPath, raw);
}

/**
 * Identity-bound release: unlink only if the lock bytes still embed `token`.
 */
export async function releaseLockIfToken(
  lockPath: string,
  token: string,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (error) {
    if (errno(error) === "ENOENT") return false;
    return false;
  }
  try {
    const meta = JSON.parse(raw) as { token?: string };
    if (meta.token !== token) return false;
  } catch {
    return false;
  }
  return unlinkIfBytesMatch(lockPath, raw);
}
