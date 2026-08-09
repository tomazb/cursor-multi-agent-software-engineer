import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type DeliveryStatus = "processing" | "completed";

export interface DeliveryClaimResult {
  claimed: boolean;
  duplicate: boolean;
  status?: DeliveryStatus;
  /** Present when claimed === true; required for complete/fail fencing. */
  leaseId?: string;
}

export type DeliveryMutationResult =
  | { ok: true }
  | { ok: false; reason: "owner_mismatch" | "not_found" | "already_completed" };

export interface DeliveryRecord {
  deliveryId: string;
  status: DeliveryStatus;
  claimedAt: string;
  /** Lease nonce for the current processing owner. */
  leaseId: string;
  completedAt?: string;
  lastError?: string;
}

export interface DeliveryStoreMonitor {
  onStaleReclaim?: (deliveryId: string, previousLeaseId: string | undefined) => void;
  onOwnerMismatch?: (
    op: "complete" | "fail",
    deliveryId: string,
    providedLeaseId: string,
    currentLeaseId: string | undefined,
  ) => void;
}

/** Default: reclaim processing claims older than 5 minutes (crash recovery). */
export const DEFAULT_STALE_PROCESSING_MS = 5 * 60 * 1000;

function assertSafeDeliveryId(deliveryId: string): void {
  if (!deliveryId || typeof deliveryId !== "string") {
    throw new Error("GitHub delivery id is required");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(deliveryId)) {
    throw new Error("GitHub delivery id contains invalid characters");
  }
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, filePath);
}

/**
 * File-backed delivery ledger for `X-GitHub-Delivery` ids.
 * Claims start as `processing`; only `completed` deliveries are terminal duplicates.
 * Failed processing releases the claim. Stale `processing` claims (crash) are reclaimable.
 * complete/fail require the claim leaseId so an expired owner cannot fence a successor.
 */
export class GitHubDeliveryStore {
  private readonly deliveriesDir: string;
  private readonly staleProcessingMs: number;
  private readonly monitor: DeliveryStoreMonitor;
  private staleReclaims = 0;
  private ownerMismatchAttempts = 0;

  constructor(
    githubRoot: string,
    options: {
      staleProcessingMs?: number;
      onStaleReclaim?: DeliveryStoreMonitor["onStaleReclaim"];
      onOwnerMismatch?: DeliveryStoreMonitor["onOwnerMismatch"];
    } = {},
  ) {
    this.deliveriesDir = path.join(githubRoot, "deliveries");
    this.staleProcessingMs = options.staleProcessingMs ?? DEFAULT_STALE_PROCESSING_MS;
    this.monitor = {};
    if (options.onStaleReclaim) this.monitor.onStaleReclaim = options.onStaleReclaim;
    if (options.onOwnerMismatch) this.monitor.onOwnerMismatch = options.onOwnerMismatch;
  }

  /** Counters for reclaim/mismatch monitoring (tests and operators). */
  diagnostics(): { staleReclaims: number; ownerMismatchAttempts: number } {
    return {
      staleReclaims: this.staleReclaims,
      ownerMismatchAttempts: this.ownerMismatchAttempts,
    };
  }

  private filePath(deliveryId: string): string {
    return path.join(this.deliveriesDir, `${deliveryId}.json`);
  }

  private async read(deliveryId: string): Promise<DeliveryRecord | undefined> {
    try {
      const raw = await readFile(this.filePath(deliveryId), "utf8");
      return JSON.parse(raw) as DeliveryRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private isStaleProcessing(record: DeliveryRecord, nowMs: number): boolean {
    if (record.status !== "processing") return false;
    const claimedAt = Date.parse(record.claimedAt);
    if (!Number.isFinite(claimedAt)) return true;
    return nowMs - claimedAt >= this.staleProcessingMs;
  }

  private noteOwnerMismatch(
    op: "complete" | "fail",
    deliveryId: string,
    providedLeaseId: string,
    currentLeaseId: string | undefined,
  ): void {
    this.ownerMismatchAttempts += 1;
    this.monitor.onOwnerMismatch?.(op, deliveryId, providedLeaseId, currentLeaseId);
  }

  async claim(deliveryId: string, nowMs = Date.now()): Promise<DeliveryClaimResult> {
    assertSafeDeliveryId(deliveryId);
    await mkdir(this.deliveriesDir, { recursive: true });
    const existing = await this.read(deliveryId);
    if (existing?.status === "completed") {
      return { claimed: false, duplicate: true, status: "completed" };
    }
    if (existing?.status === "processing") {
      if (!this.isStaleProcessing(existing, nowMs)) {
        return { claimed: false, duplicate: true, status: "processing" };
      }
      this.staleReclaims += 1;
      this.monitor.onStaleReclaim?.(deliveryId, existing.leaseId);
      try {
        await unlink(this.filePath(deliveryId));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    const leaseId = randomUUID();
    const record: DeliveryRecord = {
      deliveryId,
      status: "processing",
      leaseId,
      claimedAt: new Date(nowMs).toISOString(),
    };
    try {
      await writeFile(this.filePath(deliveryId), `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      return { claimed: true, duplicate: false, status: "processing", leaseId };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        const raced = await this.read(deliveryId);
        return {
          claimed: false,
          duplicate: true,
          ...(raced?.status ? { status: raced.status } : {}),
        };
      }
      throw error;
    }
  }

  async complete(deliveryId: string, leaseId: string): Promise<DeliveryMutationResult> {
    assertSafeDeliveryId(deliveryId);
    if (!leaseId) {
      this.noteOwnerMismatch("complete", deliveryId, leaseId, undefined);
      return { ok: false, reason: "owner_mismatch" };
    }
    const existing = await this.read(deliveryId);
    if (!existing) {
      return { ok: false, reason: "not_found" };
    }
    if (existing.status === "completed") {
      if (existing.leaseId === leaseId) return { ok: true };
      this.noteOwnerMismatch("complete", deliveryId, leaseId, existing.leaseId);
      return { ok: false, reason: "already_completed" };
    }
    if (existing.leaseId !== leaseId) {
      this.noteOwnerMismatch("complete", deliveryId, leaseId, existing.leaseId);
      return { ok: false, reason: "owner_mismatch" };
    }
    const record: DeliveryRecord = {
      ...existing,
      status: "completed",
      completedAt: new Date().toISOString(),
    };
    delete record.lastError;
    await writeAtomic(this.filePath(deliveryId), `${JSON.stringify(record)}\n`);
    return { ok: true };
  }

  async fail(
    deliveryId: string,
    errorMessage: string,
    leaseId: string,
  ): Promise<DeliveryMutationResult> {
    assertSafeDeliveryId(deliveryId);
    if (!leaseId) {
      this.noteOwnerMismatch("fail", deliveryId, leaseId, undefined);
      return { ok: false, reason: "owner_mismatch" };
    }
    const existing = await this.read(deliveryId);
    if (!existing) {
      return { ok: false, reason: "not_found" };
    }
    if (existing.leaseId !== leaseId) {
      this.noteOwnerMismatch("fail", deliveryId, leaseId, existing.leaseId);
      return { ok: false, reason: "owner_mismatch" };
    }
    if (existing.status === "completed") {
      return { ok: false, reason: "already_completed" };
    }
    try {
      await unlink(this.filePath(deliveryId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    void errorMessage;
    return { ok: true };
  }
}
