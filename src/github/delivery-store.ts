import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type DeliveryStatus = "processing" | "completed";

export interface DeliveryClaimResult {
  claimed: boolean;
  duplicate: boolean;
  status?: DeliveryStatus;
}

export interface DeliveryRecord {
  deliveryId: string;
  status: DeliveryStatus;
  claimedAt: string;
  completedAt?: string;
  lastError?: string;
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
 */
export class GitHubDeliveryStore {
  private readonly deliveriesDir: string;
  private readonly staleProcessingMs: number;

  constructor(
    githubRoot: string,
    options: { staleProcessingMs?: number } = {},
  ) {
    this.deliveriesDir = path.join(githubRoot, "deliveries");
    this.staleProcessingMs = options.staleProcessingMs ?? DEFAULT_STALE_PROCESSING_MS;
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
      try {
        await unlink(this.filePath(deliveryId));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    const record: DeliveryRecord = {
      deliveryId,
      status: "processing",
      claimedAt: new Date(nowMs).toISOString(),
    };
    try {
      await writeFile(this.filePath(deliveryId), `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      return { claimed: true, duplicate: false, status: "processing" };
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

  async complete(deliveryId: string): Promise<void> {
    assertSafeDeliveryId(deliveryId);
    const existing = await this.read(deliveryId);
    if (!existing) {
      throw new Error(`Cannot complete unknown delivery ${deliveryId}`);
    }
    const record: DeliveryRecord = {
      ...existing,
      status: "completed",
      completedAt: new Date().toISOString(),
    };
    delete record.lastError;
    await writeAtomic(this.filePath(deliveryId), `${JSON.stringify(record)}\n`);
  }

  async fail(deliveryId: string, errorMessage: string): Promise<void> {
    assertSafeDeliveryId(deliveryId);
    try {
      await unlink(this.filePath(deliveryId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    void errorMessage;
  }
}
