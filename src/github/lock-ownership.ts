import {
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
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
  afterPathMoved?: (filePath: string, reclaimPath: string) => Promise<void>;
}

export interface ReclaimHooks {
  afterDeadConfirmed?: (lockPath: string) => Promise<void>;
}

export interface CompareAndSwapHooks extends BytesMatchHooks {
  beforeInstall?: (filePath: string, reclaimPath: string) => Promise<void>;
}

export interface DirLockOptions extends ReclaimHooks {
  timeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryParseJson(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Delivery ledger records must parse and carry status + leaseId. */
export function isValidDeliveryLedgerRaw(raw: string): boolean {
  const parsed = tryParseJson(raw);
  if (!isObjectRecord(parsed)) return false;
  return typeof parsed.status === "string" && typeof parsed.leaseId === "string";
}

/**
 * Publish `content` at `filePath` only when absent.
 * Writes a temp file to completion first, then `link`s into place so readers never
 * observe a truncated canonical. Fails closed if link is unsupported.
 */
export async function installExclusive(
  filePath: string,
  content: string,
): Promise<boolean> {
  const tmpPath = `${filePath}.${randomUUID()}.install`;
  try {
    await writeFile(tmpPath, content, "utf8");
  } catch {
    return false;
  }
  try {
    await link(tmpPath, filePath);
  } catch (error) {
    try {
      await unlink(tmpPath);
    } catch {
      /* ignore */
    }
    if (errno(error) === "EEXIST") return false;
    return false;
  }
  try {
    await unlink(tmpPath);
  } catch {
    /* ignore */
  }
  return true;
}

/**
 * Restore moved bytes only when `filePath` is absent (wx/link install).
 * Never `rename` onto an existing destination.
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
  const installed = await installExclusive(filePath, raw);
  if (!installed) {
    try {
      // Destination occupied by a newer successor — drop obsolete reclaim.
      const existing = await readFile(filePath, "utf8");
      if (existing.length > 0) {
        try {
          await unlink(reclaimPath);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* leave reclaim if destination missing/unreadable */
    }
    return false;
  }
  try {
    await unlink(reclaimPath);
  } catch {
    /* ignore */
  }
  return true;
}

/**
 * Unlink `filePath` only if its bytes are still exactly `expectedRaw`.
 */
export async function unlinkIfBytesMatch(
  filePath: string,
  expectedRaw: string,
  hooks: BytesMatchHooks = {},
): Promise<boolean> {
  const reclaimPath = `${filePath}.${randomUUID()}.reclaim`;
  try {
    await rename(filePath, reclaimPath);
  } catch {
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

async function listAttemptArtifacts(
  filePath: string,
  kind: "staging" | "reclaim",
): Promise<string[]> {
  const directory = path.dirname(filePath);
  const base = path.basename(filePath);
  const prefix = `${base}.${kind}.`;
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.startsWith(prefix))
    .map((name) => path.join(directory, name));
}

async function unlinkQuiet(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    /* ignore */
  }
}

/**
 * Replace `filePath` with `newRaw` only if current bytes still equal `expectedRaw`.
 * Uses attempt-scoped staging/reclaim names and link-based exclusive install.
 */
export async function compareAndSwapFile(
  filePath: string,
  expectedRaw: string,
  newRaw: string,
  hooks: CompareAndSwapHooks = {},
): Promise<boolean> {
  const attemptId = randomUUID();
  const stagingPath = `${filePath}.staging.${attemptId}`;
  const reclaimPath = `${filePath}.reclaim.${attemptId}`;

  try {
    await writeFile(stagingPath, newRaw, { encoding: "utf8" });
  } catch {
    return false;
  }

  try {
    const current = await readFile(filePath, "utf8");
    if (current !== expectedRaw) {
      await unlinkQuiet(stagingPath);
      return false;
    }
  } catch {
    await unlinkQuiet(stagingPath);
    return false;
  }

  try {
    await rename(filePath, reclaimPath);
  } catch {
    await unlinkQuiet(stagingPath);
    return false;
  }

  try {
    await hooks.afterPathMoved?.(filePath, reclaimPath);
    const movedRaw = await readFile(reclaimPath, "utf8");
    if (movedRaw !== expectedRaw) {
      await restoreMoved(reclaimPath, filePath);
      await unlinkQuiet(stagingPath);
      return false;
    }

    await hooks.beforeInstall?.(filePath, reclaimPath);

    const installed = await installExclusive(filePath, newRaw);
    if (!installed) {
      await restoreMoved(reclaimPath, filePath);
      await unlinkQuiet(stagingPath);
      return false;
    }

    await unlinkQuiet(stagingPath);
    await unlinkQuiet(reclaimPath);
    return true;
  } catch {
    await restoreMoved(reclaimPath, filePath);
    await unlinkQuiet(stagingPath);
    return false;
  }
}

export type CompareAndSwapRecovery =
  | { kind: "none" }
  | { kind: "installed"; raw: string }
  | { kind: "restored"; raw: string }
  | { kind: "canonical"; raw: string }
  | { kind: "finished"; raw: string };

/**
 * Finish or roll back crashed {@link compareAndSwapFile} attempts.
 * Never treats truncated/invalid canonical bytes as authoritative, and never
 * deletes staging/reclaim until a valid ledger is installed.
 */
export async function recoverCompareAndSwapArtifacts(
  filePath: string,
): Promise<CompareAndSwapRecovery> {
  const stagings = await listAttemptArtifacts(filePath, "staging");
  const reclaims = await listAttemptArtifacts(filePath, "reclaim");

  let canonicalRaw: string | undefined;
  try {
    canonicalRaw = await readFile(filePath, "utf8");
  } catch {
    canonicalRaw = undefined;
  }

  const canonicalValid =
    canonicalRaw !== undefined && isValidDeliveryLedgerRaw(canonicalRaw)
      ? canonicalRaw
      : undefined;

  if (canonicalRaw !== undefined && canonicalValid === undefined) {
    // Truncated/corrupt canonical — remove so staging can install; keep artifacts.
    await unlinkQuiet(filePath);
    canonicalRaw = undefined;
  }

  // Prefer a durable completed staging that matches an in-progress lease.
  for (const stagingPath of stagings) {
    let stagingRaw: string;
    try {
      stagingRaw = await readFile(stagingPath, "utf8");
    } catch {
      continue;
    }
    if (!isValidDeliveryLedgerRaw(stagingRaw)) continue;
    const staging = JSON.parse(stagingRaw) as {
      status: string;
      leaseId: string;
    };
    if (staging.status !== "completed") continue;

    if (canonicalValid !== undefined) {
      const canonical = JSON.parse(canonicalValid) as {
        status: string;
        leaseId: string;
      };
      if (canonical.status === "completed") {
        await unlinkQuiet(stagingPath);
        continue;
      }
      if (
        canonical.status === "processing" &&
        canonical.leaseId === staging.leaseId
      ) {
        const swapped = await compareAndSwapFile(
          filePath,
          canonicalValid,
          stagingRaw,
        );
        if (swapped) {
          for (const p of [...stagings, ...reclaims]) await unlinkQuiet(p);
          return { kind: "finished", raw: stagingRaw };
        }
      }
      continue;
    }

    const installed = await installExclusive(filePath, stagingRaw);
    if (installed) {
      for (const p of [...stagings, ...reclaims]) await unlinkQuiet(p);
      return { kind: "installed", raw: stagingRaw };
    }
  }

  if (canonicalValid !== undefined) {
    for (const p of [...stagings, ...reclaims]) await unlinkQuiet(p);
    return { kind: "canonical", raw: canonicalValid };
  }

  for (const reclaimPath of reclaims) {
    let reclaimRaw: string;
    try {
      reclaimRaw = await readFile(reclaimPath, "utf8");
    } catch {
      continue;
    }
    if (!isValidDeliveryLedgerRaw(reclaimRaw)) continue;
    const restored = await restoreMoved(reclaimPath, filePath);
    if (restored) {
      for (const p of stagings) await unlinkQuiet(p);
      for (const p of reclaims) await unlinkQuiet(p);
      return { kind: "restored", raw: reclaimRaw };
    }
  }

  return { kind: "none" };
}

interface DirLockMeta {
  pid: number;
  token: string;
  at: string;
}

async function readDirLockMeta(
  lockDir: string,
): Promise<{ raw: string; meta: DirLockMeta } | undefined> {
  try {
    const raw = await readFile(path.join(lockDir, "owner.json"), "utf8");
    const parsed = tryParseJson(raw);
    if (!isObjectRecord(parsed)) return undefined;
    if (typeof parsed.pid !== "number" || typeof parsed.token !== "string") {
      return undefined;
    }
    return {
      raw,
      meta: {
        pid: parsed.pid,
        token: parsed.token,
        at: typeof parsed.at === "string" ? parsed.at : "",
      },
    };
  } catch {
    return undefined;
  }
}

/**
 * Reclaim a directory lock only when owner death is proven (ESRCH) and the
 * owner.json bytes are unchanged after the death check. Never creates an
 * absence window against a live owner.
 */
export async function reclaimDeadOwnerDir(
  lockDir: string,
  hooks: ReclaimHooks = {},
): Promise<boolean> {
  const observed = await readDirLockMeta(lockDir);
  if (!observed) return false;
  if (!processDefinitelyDead(observed.meta.pid)) return false;

  await hooks.afterDeadConfirmed?.(lockDir);

  const again = await readDirLockMeta(lockDir);
  if (!again || again.raw !== observed.raw) return false;
  if (!processDefinitelyDead(again.meta.pid)) return false;

  try {
    await rm(lockDir, { recursive: true, force: false });
    return true;
  } catch {
    return false;
  }
}

export async function releaseDirLock(
  lockDir: string,
  token: string,
): Promise<boolean> {
  const observed = await readDirLockMeta(lockDir);
  if (!observed || observed.meta.token !== token) return false;
  try {
    await rm(lockDir, { recursive: true, force: false });
    return true;
  } catch {
    return false;
  }
}

/**
 * Exclusive mkdir-based lock with identity-bound release and dead-owner reclaim.
 * Live owners never lose the directory name while inside the critical section.
 */
export async function withDirLock<T>(
  lockDir: string,
  fn: () => Promise<T>,
  options: DirLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const token = randomUUID();
  const started = Date.now();
  await mkdir(path.dirname(lockDir), { recursive: true });

  for (;;) {
    try {
      await mkdir(lockDir);
      const meta: DirLockMeta = {
        pid: process.pid,
        token,
        at: new Date().toISOString(),
      };
      await writeFile(
        path.join(lockDir, "owner.json"),
        `${JSON.stringify(meta)}\n`,
        "utf8",
      );
      break;
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error;
      await reclaimDeadOwnerDir(lockDir, options);
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Timed out acquiring directory lock at ${lockDir}`);
      }
      await sleep(10);
    }
  }

  try {
    return await fn();
  } finally {
    await releaseDirLock(lockDir, token);
  }
}

/** @deprecated file-lock reclaim retained for delivery CAS helpers only */
export async function reclaimDeadOwnerLock(
  lockPath: string,
  hooks: ReclaimHooks & BytesMatchHooks = {},
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
