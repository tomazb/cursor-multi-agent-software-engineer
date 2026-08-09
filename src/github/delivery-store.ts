import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { withGitHubJournal } from "./journal.ts";

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

interface ParsedDelivery {
  record: DeliveryRecord;
}

interface DeliveryArtifact {
  path: string;
  parsed?: ParsedDelivery;
}

interface DeliveryAttempt {
  attempt: string;
  staging?: DeliveryArtifact;
  reclaim?: DeliveryArtifact;
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function parseDelivery(raw: string): ParsedDelivery | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const allowed = new Set([
    "deliveryId",
    "status",
    "claimedAt",
    "leaseId",
    "completedAt",
    "lastError",
  ]);
  if (Object.keys(parsed).some((key) => !allowed.has(key))) return undefined;
  if (
    typeof parsed.deliveryId !== "string" ||
    !parsed.deliveryId ||
    !/^[A-Za-z0-9._-]+$/.test(parsed.deliveryId) ||
    (parsed.status !== "processing" && parsed.status !== "completed") ||
    typeof parsed.leaseId !== "string" ||
    !parsed.leaseId ||
    !isCanonicalTimestamp(parsed.claimedAt) ||
    (parsed.lastError !== undefined && typeof parsed.lastError !== "string")
  ) {
    return undefined;
  }
  if (parsed.status === "processing" && parsed.completedAt !== undefined) return undefined;
  if (
    parsed.status === "completed" &&
    (!isCanonicalTimestamp(parsed.completedAt) ||
      Date.parse(parsed.completedAt) < Date.parse(parsed.claimedAt))
  ) {
    return undefined;
  }
  const record: DeliveryRecord = {
    deliveryId: parsed.deliveryId,
    status: parsed.status,
    claimedAt: parsed.claimedAt,
    leaseId: parsed.leaseId,
    ...(typeof parsed.completedAt === "string"
      ? { completedAt: parsed.completedAt }
      : {}),
    ...(typeof parsed.lastError === "string" ? { lastError: parsed.lastError } : {}),
  };
  return { record };
}

function sameCompletion(left: DeliveryRecord, right: DeliveryRecord): boolean {
  return (
    left.deliveryId === right.deliveryId &&
    left.status === "completed" &&
    right.status === "completed" &&
    left.leaseId === right.leaseId &&
    left.claimedAt === right.claimedAt &&
    left.completedAt === right.completedAt &&
    left.lastError === right.lastError
  );
}

function completionMatchesProcessing(
  completed: DeliveryRecord,
  processing: DeliveryRecord,
): boolean {
  return (
    completed.status === "completed" &&
    processing.status === "processing" &&
    completed.deliveryId === processing.deliveryId &&
    completed.leaseId === processing.leaseId &&
    completed.claimedAt === processing.claimedAt
  );
}

async function unlinkExact(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error;
  }
}

/**
 * File-backed delivery ledger for `X-GitHub-Delivery` ids.
 * The canonical JSON is protected state. Immutable per-delivery journal claims
 * own all reads, recovery, and mutations; lease IDs fence logical webhook owners.
 */
export class GitHubDeliveryStore {
  private readonly githubRoot: string;
  private readonly deliveriesDir: string;
  private readonly staleProcessingMs: number;
  private readonly monitor: DeliveryStoreMonitor;
  private readonly afterLeaseValidated?: (
    op: DeliveryLeaseValidatedOp,
    deliveryId: string,
  ) => Promise<void>;
  private readonly afterCompletionStaged?: (
    filePath: string,
    stagingPath: string,
  ) => Promise<void>;
  private staleReclaims = 0;
  private ownerMismatchAttempts = 0;

  constructor(
    githubRoot: string,
    options: {
      staleProcessingMs?: number;
      onStaleReclaim?: DeliveryStoreMonitor["onStaleReclaim"];
      onOwnerMismatch?: DeliveryStoreMonitor["onOwnerMismatch"];
      /** Test hook after lease validation while the delivery journal is owned. */
      afterLeaseValidated?: (
        op: DeliveryLeaseValidatedOp,
        deliveryId: string,
      ) => Promise<void>;
      /** Test hook after completion staging is synced and closed, before replacement. */
      afterCompletionStaged?: (
        filePath: string,
        stagingPath: string,
      ) => Promise<void>;
    } = {},
  ) {
    this.githubRoot = githubRoot;
    this.deliveriesDir = path.join(githubRoot, "deliveries");
    this.staleProcessingMs = options.staleProcessingMs ?? DEFAULT_STALE_PROCESSING_MS;
    this.monitor = {};
    if (options.onStaleReclaim) this.monitor.onStaleReclaim = options.onStaleReclaim;
    if (options.onOwnerMismatch) this.monitor.onOwnerMismatch = options.onOwnerMismatch;
    if (options.afterLeaseValidated) this.afterLeaseValidated = options.afterLeaseValidated;
    if (options.afterCompletionStaged) {
      this.afterCompletionStaged = options.afterCompletionStaged;
    }
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

  private async readCanonical(
    deliveryId: string,
  ): Promise<{ state: "missing" } | { state: "invalid" } | { state: "valid"; value: ParsedDelivery }> {
    try {
      const raw = await readFile(this.filePath(deliveryId), "utf8");
      const parsed = parseDelivery(raw);
      if (!parsed || parsed.record.deliveryId !== deliveryId) return { state: "invalid" };
      return { state: "valid", value: parsed };
    } catch (error) {
      if (errno(error) === "ENOENT") return { state: "missing" };
      throw error;
    }
  }

  private async readArtifacts(deliveryId: string): Promise<DeliveryAttempt[]> {
    const canonical = this.filePath(deliveryId);
    const base = path.basename(canonical);
    let entries: string[];
    try {
      entries = (await readdir(this.deliveriesDir)).sort();
    } catch (error) {
      if (errno(error) === "ENOENT") return [];
      throw error;
    }
    const byAttempt = new Map<string, DeliveryAttempt>();
    for (const name of entries) {
      let kind: "staging" | "reclaim" | undefined;
      let attempt = "";
      for (const candidate of ["staging", "reclaim"] as const) {
        const prefix = `${base}.${candidate}.`;
        if (name.startsWith(prefix)) {
          kind = candidate;
          attempt = name.slice(prefix.length);
          break;
        }
      }
      if (!kind || !attempt) continue;
      const artifactPath = path.join(this.deliveriesDir, name);
      let parsed: ParsedDelivery | undefined;
      try {
        parsed = parseDelivery(await readFile(artifactPath, "utf8"));
      } catch (error) {
        if (errno(error) === "ENOENT") continue;
        throw error;
      }
      const artifact: DeliveryArtifact = {
        path: artifactPath,
        ...(parsed ? { parsed } : {}),
      };
      const group = byAttempt.get(attempt) ?? { attempt };
      if (kind === "staging") group.staging = artifact;
      else group.reclaim = artifact;
      byAttempt.set(attempt, group);
    }
    return [...byAttempt.values()].sort((left, right) =>
      left.attempt.localeCompare(right.attempt),
    );
  }

  private pairIsEligible(deliveryId: string, attempt: DeliveryAttempt): boolean {
    const staging = attempt.staging?.parsed?.record;
    const reclaim = attempt.reclaim?.parsed?.record;
    return (
      staging?.deliveryId === deliveryId &&
      reclaim?.deliveryId === deliveryId &&
      completionMatchesProcessing(staging, reclaim)
    );
  }

  private async cleanupWinner(
    winner: DeliveryRecord,
    attempts: DeliveryAttempt[],
  ): Promise<void> {
    for (const attempt of attempts) {
      const staging = attempt.staging?.parsed?.record;
      if (!staging || !sameCompletion(staging, winner)) continue;
      await unlinkExact(attempt.staging!.path);
      const reclaim = attempt.reclaim?.parsed?.record;
      if (reclaim && completionMatchesProcessing(staging, reclaim)) {
        await unlinkExact(attempt.reclaim!.path);
      }
    }
  }

  private async installCompleted(
    winner: DeliveryArtifact,
    attempts: DeliveryAttempt[],
  ): Promise<ParsedDelivery> {
    const parsed = winner.parsed!;
    await rename(winner.path, this.filePath(parsed.record.deliveryId));
    await this.cleanupWinner(parsed.record, attempts);
    return parsed;
  }

  private async recover(deliveryId: string): Promise<ParsedDelivery | undefined> {
    const canonical = await this.readCanonical(deliveryId);
    const attempts = await this.readArtifacts(deliveryId);

    if (canonical.state === "valid") {
      const current = canonical.value.record;
      if (current.status === "completed") {
        await this.cleanupWinner(current, attempts);
        return canonical.value;
      }

      const matching = attempts
        .map((attempt) => attempt.staging)
        .filter((artifact): artifact is DeliveryArtifact => {
          const staging = artifact?.parsed?.record;
          return Boolean(
            staging?.deliveryId === deliveryId &&
              completionMatchesProcessing(staging, current),
          );
        });
      if (matching.length === 0) return canonical.value;
      const winner = matching[0]!;
      if (
        matching.some(
          (candidate) => !sameCompletion(candidate.parsed!.record, winner.parsed!.record),
        )
      ) {
        throw new Error(`Conflicting GitHub delivery recovery artifacts for ${deliveryId}`);
      }
      return this.installCompleted(winner, attempts);
    }

    const eligible = attempts.filter((attempt) => this.pairIsEligible(deliveryId, attempt));
    if (eligible.length > 0) {
      const winner = eligible[0]!.staging!;
      if (
        eligible.some(
          (attempt) =>
            !sameCompletion(attempt.staging!.parsed!.record, winner.parsed!.record),
        )
      ) {
        throw new Error(`Conflicting GitHub delivery recovery artifacts for ${deliveryId}`);
      }
      return this.installCompleted(winner, attempts);
    }
    if (canonical.state === "invalid") {
      throw new Error(`Invalid canonical GitHub delivery record for ${deliveryId}`);
    }
    return undefined;
  }

  private isStaleProcessing(record: DeliveryRecord, nowMs: number): boolean {
    return (
      record.status === "processing" &&
      nowMs - Date.parse(record.claimedAt) >= this.staleProcessingMs
    );
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
    return withGitHubJournal(this.githubRoot, "delivery", deliveryId, async () => {
      await mkdir(this.deliveriesDir, { recursive: true });
      const existing = await this.recover(deliveryId);
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
        await unlink(this.filePath(deliveryId));
      }

      const leaseId = randomUUID();
      const record: DeliveryRecord = {
        deliveryId,
        status: "processing",
        leaseId,
        claimedAt: new Date(nowMs).toISOString(),
      };
      await writeFile(this.filePath(deliveryId), encodeRecord(record), {
        encoding: "utf8",
        flag: "wx",
      });
      return { claimed: true, duplicate: false, status: "processing", leaseId };
    });
  }

  async complete(deliveryId: string, leaseId: string): Promise<DeliveryMutationResult> {
    assertSafeDeliveryId(deliveryId);
    return withGitHubJournal(this.githubRoot, "delivery", deliveryId, async () => {
      await mkdir(this.deliveriesDir, { recursive: true });
      if (!leaseId) {
        this.noteOwnerMismatch("complete", deliveryId, leaseId, undefined);
        return { ok: false, reason: "owner_mismatch" };
      }
      const existing = await this.recover(deliveryId);
      if (!existing) return { ok: false, reason: "not_found" };
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
        completedAt: new Date(
          Math.max(Date.now(), Date.parse(existing.record.claimedAt)),
        ).toISOString(),
      };
      delete completed.lastError;
      const stagingPath = `${this.filePath(deliveryId)}.staging.${randomUUID()}`;
      const handle = await open(stagingPath, "wx", 0o600);
      try {
        await handle.writeFile(encodeRecord(completed), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.afterCompletionStaged?.(this.filePath(deliveryId), stagingPath);
      await rename(stagingPath, this.filePath(deliveryId));
      return { ok: true };
    });
  }

  async fail(
    deliveryId: string,
    errorMessage: string,
    leaseId: string,
  ): Promise<DeliveryMutationResult> {
    assertSafeDeliveryId(deliveryId);
    return withGitHubJournal(this.githubRoot, "delivery", deliveryId, async () => {
      await mkdir(this.deliveriesDir, { recursive: true });
      if (!leaseId) {
        this.noteOwnerMismatch("fail", deliveryId, leaseId, undefined);
        return { ok: false, reason: "owner_mismatch" };
      }
      const existing = await this.recover(deliveryId);
      if (!existing) return { ok: false, reason: "not_found" };
      if (existing.record.leaseId !== leaseId) {
        this.noteOwnerMismatch("fail", deliveryId, leaseId, existing.record.leaseId);
        return { ok: false, reason: "owner_mismatch" };
      }
      if (existing.record.status === "completed") {
        return { ok: false, reason: "already_completed" };
      }

      await this.afterLeaseValidated?.("fail", deliveryId);
      await unlink(this.filePath(deliveryId));
      void errorMessage;
      return { ok: true };
    });
  }
}
