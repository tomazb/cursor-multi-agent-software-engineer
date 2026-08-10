import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
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
  raw: string;
  record: DeliveryRecord;
}

interface DeliveryArtifact {
  attempt: string;
  kind: "staging" | "reclaim";
  name: string;
  path: string;
  digest: string;
  parsed?: ParsedDelivery;
}

interface DeliveryAttempt {
  attempt: string;
  staging?: DeliveryArtifact;
  reclaim?: DeliveryArtifact;
}

interface FailureSuppressionEvidence {
  attempt: string;
  kind: "staging" | "reclaim";
  path: string;
  digest: string;
}

interface FailureSuppressionBody {
  format: 1;
  record: "github-delivery-failure-suppression";
  publicationId: string;
  deliveryId: string;
  failedLeaseId: string;
  failedClaimedAt: string;
  failedCanonicalDigest: string;
  artifacts: FailureSuppressionEvidence[];
}

interface FailureSuppressionMarker extends FailureSuppressionBody {
  markerDigest: string;
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

function digest(bytes: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isCanonicalPublicationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
  return { raw, record };
}

function encodeFailureSuppression(
  publicationId: string,
  deliveryId: string,
  failed: ParsedDelivery,
  attempts: DeliveryAttempt[],
): { raw: string; marker: FailureSuppressionMarker } {
  const artifacts = attempts
    .flatMap((attempt) => [attempt.staging, attempt.reclaim])
    .filter((artifact): artifact is DeliveryArtifact => artifact !== undefined)
    .map((artifact) => ({
      attempt: artifact.attempt,
      kind: artifact.kind,
      path: artifact.name,
      digest: artifact.digest,
    }))
    .sort((left, right) => compareCanonicalText(left.path, right.path));
  const body: FailureSuppressionBody = {
    format: 1,
    record: "github-delivery-failure-suppression",
    publicationId,
    deliveryId,
    failedLeaseId: failed.record.leaseId,
    failedClaimedAt: failed.record.claimedAt,
    failedCanonicalDigest: digest(failed.raw),
    artifacts,
  };
  const markerDigest = digest(`${JSON.stringify(body)}\n`);
  const marker: FailureSuppressionMarker = { ...body, markerDigest };
  return { raw: `${JSON.stringify(marker)}\n`, marker };
}

function parseFailureSuppression(
  raw: string,
  deliveryId: string,
  canonicalBase: string,
  markerName: string,
): FailureSuppressionMarker | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (
    !exactKeys(parsed, [
      "format",
      "record",
      "publicationId",
      "deliveryId",
      "failedLeaseId",
      "failedClaimedAt",
      "failedCanonicalDigest",
      "artifacts",
      "markerDigest",
    ]) ||
    parsed.format !== 1 ||
    parsed.record !== "github-delivery-failure-suppression" ||
    !isCanonicalPublicationId(parsed.publicationId) ||
    markerName !== `${canonicalBase}.suppression.${parsed.publicationId}` ||
    parsed.deliveryId !== deliveryId ||
    typeof parsed.failedLeaseId !== "string" ||
    !parsed.failedLeaseId ||
    !isCanonicalTimestamp(parsed.failedClaimedAt) ||
    !validDigest(parsed.failedCanonicalDigest) ||
    !Array.isArray(parsed.artifacts) ||
    !validDigest(parsed.markerDigest)
  ) {
    return undefined;
  }

  const artifacts: FailureSuppressionEvidence[] = [];
  const seenPaths = new Set<string>();
  for (const candidate of parsed.artifacts) {
    if (
      !isRecord(candidate) ||
      !exactKeys(candidate, ["attempt", "kind", "path", "digest"]) ||
      typeof candidate.attempt !== "string" ||
      !candidate.attempt ||
      (candidate.kind !== "staging" && candidate.kind !== "reclaim") ||
      candidate.path !== `${canonicalBase}.${candidate.kind}.${candidate.attempt}` ||
      !validDigest(candidate.digest) ||
      seenPaths.has(candidate.path)
    ) {
      return undefined;
    }
    seenPaths.add(candidate.path);
    artifacts.push({
      attempt: candidate.attempt,
      kind: candidate.kind,
      path: candidate.path,
      digest: candidate.digest,
    });
  }
  if (
    artifacts.some(
      (artifact, index) =>
        index > 0 &&
        compareCanonicalText(artifacts[index - 1]!.path, artifact.path) >= 0,
    )
  ) {
    return undefined;
  }

  const body: FailureSuppressionBody = {
    format: 1,
    record: "github-delivery-failure-suppression",
    publicationId: parsed.publicationId,
    deliveryId,
    failedLeaseId: parsed.failedLeaseId,
    failedClaimedAt: parsed.failedClaimedAt,
    failedCanonicalDigest: parsed.failedCanonicalDigest,
    artifacts,
  };
  if (parsed.markerDigest !== digest(`${JSON.stringify(body)}\n`)) return undefined;
  const marker: FailureSuppressionMarker = {
    ...body,
    markerDigest: parsed.markerDigest,
  };
  return raw === `${JSON.stringify(marker)}\n` ? marker : undefined;
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const handle = await open(directoryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
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
  private readonly afterInitialClaimStaged?: (
    filePath: string,
    stagingPath: string,
  ) => Promise<void>;
  private readonly afterFailureSuppressionPublished?: (
    filePath: string,
    suppressionPath: string,
  ) => Promise<void>;
  private readonly syncDirectory: (directoryPath: string) => Promise<void>;
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
      /** Test hook after an initial claim is synced, before no-clobber publication. */
      afterInitialClaimStaged?: (
        filePath: string,
        stagingPath: string,
      ) => Promise<void>;
      /** Test hook after failure suppression is durably published, before canonical removal. */
      afterFailureSuppressionPublished?: (
        filePath: string,
        suppressionPath: string,
      ) => Promise<void>;
      /** Test seam for deterministic directory-durability failures. */
      syncDirectory?: (directoryPath: string) => Promise<void>;
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
    if (options.afterInitialClaimStaged) {
      this.afterInitialClaimStaged = options.afterInitialClaimStaged;
    }
    if (options.afterFailureSuppressionPublished) {
      this.afterFailureSuppressionPublished = options.afterFailureSuppressionPublished;
    }
    this.syncDirectory = options.syncDirectory ?? syncDirectory;
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
      let bytes: Buffer;
      try {
        bytes = await readFile(artifactPath);
        parsed = parseDelivery(bytes.toString("utf8"));
      } catch (error) {
        if (errno(error) === "ENOENT") continue;
        throw error;
      }
      const artifact: DeliveryArtifact = {
        attempt,
        kind,
        name,
        path: artifactPath,
        digest: digest(bytes),
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

  private async readFailureSuppressions(
    deliveryId: string,
  ): Promise<FailureSuppressionMarker[]> {
    const canonicalBase = path.basename(this.filePath(deliveryId));
    const prefix = `${canonicalBase}.suppression.`;
    let names: string[];
    try {
      names = (await readdir(this.deliveriesDir))
        .filter((name) => name.startsWith(prefix))
        .sort();
    } catch (error) {
      if (errno(error) === "ENOENT") return [];
      throw error;
    }
    const markers: FailureSuppressionMarker[] = [];
    for (const name of names) {
      let raw: string;
      try {
        raw = await readFile(path.join(this.deliveriesDir, name), "utf8");
      } catch (error) {
        if (errno(error) === "ENOENT") continue;
        throw error;
      }
      const marker = parseFailureSuppression(raw, deliveryId, canonicalBase, name);
      if (!marker) {
        throw new Error(`Invalid GitHub delivery failure-suppression marker for ${deliveryId}`);
      }
      markers.push(marker);
    }
    return markers;
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

  private pairIsSuppressed(
    attempt: DeliveryAttempt,
    markers: FailureSuppressionMarker[],
  ): boolean {
    const staging = attempt.staging;
    const reclaim = attempt.reclaim;
    if (!staging || !reclaim) return false;
    return markers.some((marker) => {
      const evidence = new Map(
        marker.artifacts.map((artifact) => [artifact.path, artifact.digest]),
      );
      return (
        evidence.get(staging.name) === staging.digest &&
        evidence.get(reclaim.name) === reclaim.digest
      );
    });
  }

  private async publishFailureSuppression(
    deliveryId: string,
    failed: ParsedDelivery,
    attempts: DeliveryAttempt[],
  ): Promise<void> {
    if (attempts.length === 0) return;
    const canonical = this.filePath(deliveryId);
    const publicationId = randomUUID();
    const stagingPath = `${canonical}.suppression-staging.${publicationId}`;
    const suppressionPath = `${canonical}.suppression.${publicationId}`;
    const { raw } = encodeFailureSuppression(publicationId, deliveryId, failed, attempts);
    const handle = await open(stagingPath, "wx", 0o600);
    try {
      await handle.writeFile(raw, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(stagingPath, suppressionPath);
    await unlinkExact(stagingPath);
    await this.syncDirectory(this.deliveriesDir);
    await this.afterFailureSuppressionPublished?.(canonical, suppressionPath);
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
    const suppressions = await this.readFailureSuppressions(deliveryId);

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

    const eligible = attempts.filter(
      (attempt) =>
        this.pairIsEligible(deliveryId, attempt) &&
        !this.pairIsSuppressed(attempt, suppressions),
    );
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
        const attempts = await this.readArtifacts(deliveryId);
        await this.publishFailureSuppression(deliveryId, existing, attempts);
        await unlink(this.filePath(deliveryId));
        await this.syncDirectory(this.deliveriesDir);
      }

      const leaseId = randomUUID();
      const record: DeliveryRecord = {
        deliveryId,
        status: "processing",
        leaseId,
        claimedAt: new Date(nowMs).toISOString(),
      };
      const canonicalPath = this.filePath(deliveryId);
      const stagingPath = `${canonicalPath}.claim-staging.${randomUUID()}`;
      const handle = await open(stagingPath, "wx", 0o600);
      try {
        await handle.writeFile(encodeRecord(record), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await this.afterInitialClaimStaged?.(canonicalPath, stagingPath);
        await link(stagingPath, canonicalPath);
      } finally {
        await unlinkExact(stagingPath);
      }
      await this.syncDirectory(this.deliveriesDir);
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
      const attempts = await this.readArtifacts(deliveryId);
      await this.publishFailureSuppression(deliveryId, existing, attempts);
      await unlink(this.filePath(deliveryId));
      await this.syncDirectory(this.deliveriesDir);
      void errorMessage;
      return { ok: true };
    });
  }
}
