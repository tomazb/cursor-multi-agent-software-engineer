import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  compareAndSwapFile,
  unlinkIfBytesMatch,
  type BytesMatchHooks,
  type CompareAndSwapHooks,
} from "./lock-ownership.ts";

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

export type DeliveryLeaseValidatedOp = "complete" | "fail" | "claim-reclaim";

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

function encodeRecord(record: DeliveryRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/**
 * File-backed delivery ledger for `X-GitHub-Delivery` ids.
 * Claims start as `processing`; only `completed` deliveries are terminal duplicates.
 * complete/fail fence with leaseId and compare-and-swap unlink so a successor
 * inserted after the lease check cannot be overwritten or deleted.
 */
export class GitHubDeliveryStore {
  private readonly deliveriesDir: string;
  private readonly staleProcessingMs: number;
  private readonly monitor: DeliveryStoreMonitor;
  private readonly afterLeaseValidated?: (
    op: DeliveryLeaseValidatedOp,
    deliveryId: string,
  ) => Promise<void>;
  private readonly casHooks: CompareAndSwapHooks;
  private staleReclaims = 0;
  private ownerMismatchAttempts = 0;

  constructor(
    githubRoot: string,
    options: {
      staleProcessingMs?: number;
      onStaleReclaim?: DeliveryStoreMonitor["onStaleReclaim"];
      onOwnerMismatch?: DeliveryStoreMonitor["onOwnerMismatch"];
      /** Test hook after lease validation, before CAS mutate. */
      afterLeaseValidated?: (
        op: DeliveryLeaseValidatedOp,
        deliveryId: string,
      ) => Promise<void>;
      /** Test hooks for rename-based compare-and-swap. */
      afterPathMoved?: BytesMatchHooks["afterPathMoved"];
      beforeInstall?: CompareAndSwapHooks["beforeInstall"];
    } = {},
  ) {
    this.deliveriesDir = path.join(githubRoot, "deliveries");
    this.staleProcessingMs = options.staleProcessingMs ?? DEFAULT_STALE_PROCESSING_MS;
    this.monitor = {};
    if (options.onStaleReclaim) this.monitor.onStaleReclaim = options.onStaleReclaim;
    if (options.onOwnerMismatch) this.monitor.onOwnerMismatch = options.onOwnerMismatch;
    if (options.afterLeaseValidated) this.afterLeaseValidated = options.afterLeaseValidated;
    this.casHooks = {};
    if (options.afterPathMoved) this.casHooks.afterPathMoved = options.afterPathMoved;
    if (options.beforeInstall) this.casHooks.beforeInstall = options.beforeInstall;
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

  private async readRaw(
    deliveryId: string,
  ): Promise<{ raw: string; record: DeliveryRecord } | undefined> {
    try {
      const raw = await readFile(this.filePath(deliveryId), "utf8");
      return { raw, record: JSON.parse(raw) as DeliveryRecord };
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
    const existing = await this.readRaw(deliveryId);
    if (existing?.record.status === "completed") {
      return { claimed: false, duplicate: true, status: "completed" };
    }
    if (existing?.record.status === "processing") {
      if (!this.isStaleProcessing(existing.record, nowMs)) {
        return { claimed: false, duplicate: true, status: "processing" };
      }
      this.staleReclaims += 1;
      this.monitor.onStaleReclaim?.(deliveryId, existing.record.leaseId);
      await this.afterLeaseValidated?.("claim-reclaim", deliveryId);
      const removed = await unlinkIfBytesMatch(
        this.filePath(deliveryId),
        existing.raw,
        this.casHooks,
      );
      if (!removed) {
        const raced = await this.readRaw(deliveryId);
        return {
          claimed: false,
          duplicate: true,
          ...(raced?.record.status ? { status: raced.record.status } : { status: "processing" }),
        };
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
      await writeFile(this.filePath(deliveryId), encodeRecord(record), {
        encoding: "utf8",
        flag: "wx",
      });
      return { claimed: true, duplicate: false, status: "processing", leaseId };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        const raced = await this.readRaw(deliveryId);
        return {
          claimed: false,
          duplicate: true,
          ...(raced?.record.status ? { status: raced.record.status } : {}),
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
    const existing = await this.readRaw(deliveryId);
    if (!existing) {
      return { ok: false, reason: "not_found" };
    }
    if (existing.record.status === "completed") {
      if (existing.record.leaseId === leaseId) return { ok: true };
      this.noteOwnerMismatch("complete", deliveryId, leaseId, existing.record.leaseId);
      return { ok: false, reason: "already_completed" };
    }
    if (existing.record.leaseId !== leaseId) {
      this.noteOwnerMismatch("complete", deliveryId, leaseId, existing.record.leaseId);
      return { ok: false, reason: "owner_mismatch" };
    }

    await this.afterLeaseValidated?.("complete", deliveryId);

    const completed: DeliveryRecord = {
      ...existing.record,
      status: "completed",
      completedAt: new Date().toISOString(),
    };
    delete completed.lastError;
    const swapped = await compareAndSwapFile(
      this.filePath(deliveryId),
      existing.raw,
      encodeRecord(completed),
      this.casHooks,
    );
    if (!swapped) {
      this.noteOwnerMismatch("complete", deliveryId, leaseId, undefined);
      return { ok: false, reason: "owner_mismatch" };
    }
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
    const existing = await this.readRaw(deliveryId);
    if (!existing) {
      return { ok: false, reason: "not_found" };
    }
    if (existing.record.leaseId !== leaseId) {
      this.noteOwnerMismatch("fail", deliveryId, leaseId, existing.record.leaseId);
      return { ok: false, reason: "owner_mismatch" };
    }
    if (existing.record.status === "completed") {
      return { ok: false, reason: "already_completed" };
    }

    await this.afterLeaseValidated?.("fail", deliveryId);

    const removed = await unlinkIfBytesMatch(
      this.filePath(deliveryId),
      existing.raw,
      this.casHooks,
    );
    if (!removed) {
      this.noteOwnerMismatch("fail", deliveryId, leaseId, undefined);
      return { ok: false, reason: "owner_mismatch" };
    }
    void errorMessage;
    return { ok: true };
  }
}
