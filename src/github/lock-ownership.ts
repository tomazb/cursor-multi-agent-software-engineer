import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * True only when the kernel reports the pid does not exist (ESRCH).
 * EPERM and every other probe error fail closed as "not proven dead".
 */
export function processDefinitelyDead(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return errno(error) === "ESRCH";
  }
}

/** Treat the owner as still holding the lock unless death is proven via ESRCH. */
export function processAliveConservative(pid: number): boolean {
  return !processDefinitelyDead(pid);
}

export interface BytesMatchHooks {
  /**
   * After `filePath` has been renamed aside to `reclaimPath`, before verifying bytes.
   * Used for fault injection of a successor at `filePath`.
   */
  afterPathMoved?: (filePath: string, reclaimPath: string) => Promise<void>;
}

export interface ReclaimHooks extends BytesMatchHooks {
  /** Test hook after the owner is confirmed dead, before bytes-matched reclaim. */
  afterDeadConfirmed?: (lockPath: string) => Promise<void>;
}

export interface CompareAndSwapHooks extends BytesMatchHooks {
  /** After expected bytes are verified in reclaim, before installing `newRaw`. */
  beforeInstall?: (filePath: string, reclaimPath: string) => Promise<void>;
}

async function restoreMoved(reclaimPath: string, filePath: string): Promise<boolean> {
  try {
    await rename(reclaimPath, filePath);
    return true;
  } catch (error) {
    if (errno(error) === "EEXIST") {
      // A successor already occupies filePath; the moved copy is obsolete.
      try {
        await unlink(reclaimPath);
      } catch {
        /* ignore */
      }
      return false;
    }
    // Leave reclaimPath in place — never delete the only remaining copy on
    // ambiguous restore failures (EACCES, etc.).
    return false;
  }
}

/**
 * Unlink `filePath` only if its bytes are still exactly `expectedRaw`.
 * Renames the path aside atomically, verifies the moved bytes, then deletes the
 * reclaim copy — never unlinks a pathname after a separate inode check.
 * Failures fail closed (restore when possible, return false; never throw for
 * ordinary races / unsupported operations).
 */
export async function unlinkIfBytesMatch(
  filePath: string,
  expectedRaw: string,
  hooks: BytesMatchHooks = {},
): Promise<boolean> {
  const reclaimPath = `${filePath}.${randomUUID()}.reclaim`;
  try {
    await rename(filePath, reclaimPath);
  } catch (error) {
    if (errno(error) === "ENOENT") return false;
    // EXDEV / EPERM / etc.: fail closed so callers retry via lock timeout.
    return false;
  }

  try {
    await hooks.afterPathMoved?.(filePath, reclaimPath);
    const movedRaw = await readFile(reclaimPath, "utf8");
    if (movedRaw !== expectedRaw) {
      await restoreMoved(reclaimPath, filePath);
      return false;
    }
    try {
      await unlink(reclaimPath);
      return true;
    } catch {
      await restoreMoved(reclaimPath, filePath);
      return false;
    }
  } catch {
    await restoreMoved(reclaimPath, filePath);
    return false;
  }
}

/**
 * Replace `filePath` with `newRaw` only if current bytes still equal `expectedRaw`.
 * Keeps the old bytes in a reclaim file until the new file is installed with `wx`,
 * so a failed install restores the ledger instead of leaving a gap.
 */
export async function compareAndSwapFile(
  filePath: string,
  expectedRaw: string,
  newRaw: string,
  hooks: CompareAndSwapHooks = {},
): Promise<boolean> {
  const reclaimPath = `${filePath}.${randomUUID()}.reclaim`;
  try {
    await rename(filePath, reclaimPath);
  } catch (error) {
    if (errno(error) === "ENOENT") return false;
    return false;
  }

  try {
    await hooks.afterPathMoved?.(filePath, reclaimPath);
    const movedRaw = await readFile(reclaimPath, "utf8");
    if (movedRaw !== expectedRaw) {
      await restoreMoved(reclaimPath, filePath);
      return false;
    }

    await hooks.beforeInstall?.(filePath, reclaimPath);

    try {
      await writeFile(filePath, newRaw, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (errno(error) === "EEXIST") {
        // Successor installed while we held the old bytes aside — keep successor.
        try {
          await unlink(reclaimPath);
        } catch {
          /* ignore */
        }
        return false;
      }
      await restoreMoved(reclaimPath, filePath);
      return false;
    }

    try {
      await unlink(reclaimPath);
    } catch {
      /* orphan reclaim is harmless; new file is authoritative */
    }
    return true;
  } catch {
    await restoreMoved(reclaimPath, filePath);
    return false;
  }
}

/**
 * Reclaim a lock file only when its owner pid is proven dead (ESRCH) and the
 * on-disk bytes still match the observed dead-owner record.
 * Malformed JSON is never reclaimed (cannot confirm owner death).
 * Filesystem errors fail closed without deletion.
 */
export async function reclaimDeadOwnerLock(
  lockPath: string,
  hooks: ReclaimHooks = {},
): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch {
    return false;
  }

  let meta: { pid?: number; token?: string };
  try {
    meta = JSON.parse(raw) as { pid?: number; token?: string };
  } catch {
    // Cannot confirm owner death from a malformed lock.
    return false;
  }

  const pid = typeof meta.pid === "number" ? meta.pid : -1;
  if (!processDefinitelyDead(pid)) return false;

  await hooks.afterDeadConfirmed?.(lockPath);
  return unlinkIfBytesMatch(lockPath, raw, hooks);
}

/**
 * Identity-bound release: unlink only if the lock bytes still embed `token`.
 */
export async function releaseLockIfToken(
  lockPath: string,
  token: string,
  hooks: BytesMatchHooks = {},
): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch {
    return false;
  }
  try {
    const meta = JSON.parse(raw) as { token?: string };
    if (meta.token !== token) return false;
  } catch {
    return false;
  }
  return unlinkIfBytesMatch(lockPath, raw, hooks);
}
