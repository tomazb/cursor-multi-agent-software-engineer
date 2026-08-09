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

/**
 * Restore moved bytes only when `filePath` is absent.
 * Never `rename` onto an existing destination — on POSIX rename replaces and
 * would destroy a newer successor.
 */
export async function restoreMoved(
  reclaimPath: string,
  filePath: string,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(reclaimPath, "utf8");
  } catch {
    return false;
  }
  try {
    await writeFile(filePath, raw, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (errno(error) === "EEXIST") {
      try {
        await unlink(reclaimPath);
      } catch {
        /* ignore */
      }
      return false;
    }
    // Leave reclaimPath for recovery.
    return false;
  }
  try {
    await unlink(reclaimPath);
  } catch {
    /* ignore */
  }
  return true;
}

function stagingPathFor(filePath: string): string {
  return `${filePath}.staging`;
}

function reclaimPathFor(filePath: string): string {
  return `${filePath}.reclaim`;
}

/**
 * Unlink `filePath` only if its bytes are still exactly `expectedRaw`.
 * Renames the path aside atomically, verifies the moved bytes, then deletes the
 * reclaim copy. Mismatch recovery uses wx-only restore (never rename-over).
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
 *
 * Crash-safe protocol:
 * 1. Durably write `filePath.staging` with `newRaw` while canonical still exists.
 * 2. Move canonical aside to `filePath.reclaim` and verify bytes.
 * 3. Install via `wx` write (never rename-over a successor).
 * 4. Delete staging + reclaim.
 *
 * A crash after step 1 leaves staging+canonical (safe). A crash after step 2
 * leaves staging+reclaim with an empty canonical — callers must recover via
 * {@link recoverCompareAndSwapArtifacts}.
 */
export async function compareAndSwapFile(
  filePath: string,
  expectedRaw: string,
  newRaw: string,
  hooks: CompareAndSwapHooks = {},
): Promise<boolean> {
  const stagingPath = stagingPathFor(filePath);
  const reclaimPath = reclaimPathFor(filePath);

  try {
    await writeFile(stagingPath, newRaw, { encoding: "utf8" });
  } catch {
    return false;
  }

  try {
    const current = await readFile(filePath, "utf8");
    if (current !== expectedRaw) {
      try {
        await unlink(stagingPath);
      } catch {
        /* ignore */
      }
      return false;
    }
  } catch {
    try {
      await unlink(stagingPath);
    } catch {
      /* ignore */
    }
    return false;
  }

  try {
    await rename(filePath, reclaimPath);
  } catch {
    try {
      await unlink(stagingPath);
    } catch {
      /* ignore */
    }
    return false;
  }

  try {
    await hooks.afterPathMoved?.(filePath, reclaimPath);
    const movedRaw = await readFile(reclaimPath, "utf8");
    if (movedRaw !== expectedRaw) {
      await restoreMoved(reclaimPath, filePath);
      try {
        await unlink(stagingPath);
      } catch {
        /* ignore */
      }
      return false;
    }

    await hooks.beforeInstall?.(filePath, reclaimPath);

    try {
      await writeFile(filePath, newRaw, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (errno(error) === "EEXIST") {
        try {
          await unlink(stagingPath);
        } catch {
          /* ignore */
        }
        try {
          await unlink(reclaimPath);
        } catch {
          /* ignore */
        }
        return false;
      }
      await restoreMoved(reclaimPath, filePath);
      try {
        await unlink(stagingPath);
      } catch {
        /* ignore */
      }
      return false;
    }

    try {
      await unlink(stagingPath);
    } catch {
      /* ignore */
    }
    try {
      await unlink(reclaimPath);
    } catch {
      /* ignore */
    }
    return true;
  } catch {
    await restoreMoved(reclaimPath, filePath);
    try {
      await unlink(stagingPath);
    } catch {
      /* ignore */
    }
    return false;
  }
}

export type CompareAndSwapRecovery =
  | { kind: "none" }
  | { kind: "installed"; raw: string }
  | { kind: "restored"; raw: string }
  | { kind: "canonical"; raw: string };

/**
 * Finish or roll back a crashed {@link compareAndSwapFile} attempt.
 * Prefer installing durable staging when the canonical path is empty.
 */
export async function recoverCompareAndSwapArtifacts(
  filePath: string,
): Promise<CompareAndSwapRecovery> {
  const stagingPath = stagingPathFor(filePath);
  const reclaimPath = reclaimPathFor(filePath);

  let canonical: string | undefined;
  try {
    canonical = await readFile(filePath, "utf8");
  } catch {
    canonical = undefined;
  }

  if (canonical !== undefined) {
    // Canonical won; drop leftover artifacts from a prior attempt.
    try {
      await unlink(stagingPath);
    } catch {
      /* ignore */
    }
    try {
      await unlink(reclaimPath);
    } catch {
      /* ignore */
    }
    return { kind: "canonical", raw: canonical };
  }

  let staging: string | undefined;
  try {
    staging = await readFile(stagingPath, "utf8");
  } catch {
    staging = undefined;
  }

  if (staging !== undefined) {
    try {
      await writeFile(filePath, staging, { encoding: "utf8", flag: "wx" });
      try {
        await unlink(stagingPath);
      } catch {
        /* ignore */
      }
      try {
        await unlink(reclaimPath);
      } catch {
        /* ignore */
      }
      return { kind: "installed", raw: staging };
    } catch (error) {
      if (errno(error) === "EEXIST") {
        try {
          const raw = await readFile(filePath, "utf8");
          try {
            await unlink(stagingPath);
          } catch {
            /* ignore */
          }
          try {
            await unlink(reclaimPath);
          } catch {
            /* ignore */
          }
          return { kind: "canonical", raw };
        } catch {
          return { kind: "none" };
        }
      }
      // Fall through to reclaim restore.
    }
  }

  let reclaim: string | undefined;
  try {
    reclaim = await readFile(reclaimPath, "utf8");
  } catch {
    reclaim = undefined;
  }
  if (reclaim !== undefined) {
    const restored = await restoreMoved(reclaimPath, filePath);
    if (restored) {
      try {
        await unlink(stagingPath);
      } catch {
        /* ignore */
      }
      return { kind: "restored", raw: reclaim };
    }
  }

  return { kind: "none" };
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
