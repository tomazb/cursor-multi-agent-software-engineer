import { createHash, randomUUID } from "node:crypto";
import { link, lstat, open, mkdir, readFile, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { withGitHubJournal } from "./journal.ts";
import type { GitHubInternalEvent } from "./types.ts";

const STATE_FORMAT = 2;
const RECORD_KIND = "github-delivery-inbox";
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export type InboxDeliveryStatus =
  | "queued"
  | "processing"
  | "completed"
  | "awaiting-redelivery"
  | "legacy-completed";

export interface InboxDeliveryRecord {
  format: 2;
  record: "github-delivery-inbox";
  deliveryId: string;
  eventName?: string;
  receivedAt: string;
  rawBodyDigest?: string;
  legacy?: true;
  status: InboxDeliveryStatus;
  attempt: number;
  nextAttemptAt?: string;
  leaseId?: string;
  leaseExpiresAt?: string;
  completedAt?: string;
  event?: GitHubInternalEvent;
}

export type InboxEnqueueResult =
  | { outcome: "enqueued"; status: "queued" | "completed" }
  | { outcome: "duplicate"; status: InboxDeliveryStatus }
  | { outcome: "conflict"; status: InboxDeliveryStatus };

export interface ClaimedInboxDelivery {
  record: InboxDeliveryRecord & {
    status: "processing";
    event: GitHubInternalEvent;
    leaseId: string;
    leaseExpiresAt: string;
  };
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function deliveryHash(deliveryId: string): string {
  return createHash("sha256").update(deliveryId).digest("hex");
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const EVENT_TYPES = new Set<string>([
  "pull_request.opened",
  "pull_request.synchronize",
  "pull_request.reopened",
  "pull_request.ready_for_review",
  "pull_request.closed",
  "push",
  "installation.created",
  "installation.deleted",
  "installation_repositories.added",
  "installation_repositories.removed",
  "workflow_run.completed",
  "check_run.completed",
  "check_suite.completed",
]);

function validEvent(value: unknown, deliveryId: string, receivedAt: string): value is GitHubInternalEvent {
  if (!isRecord(value)) return false;
  const allowed = new Set([
    "eventId",
    "type",
    "repository",
    "repositories",
    "installationId",
    "pullRequestNumber",
    "headSha",
    "baseSha",
    "branch",
    "observeOnly",
    "receivedAt",
    "rawAction",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (
    value.eventId !== deliveryId ||
    value.receivedAt !== receivedAt ||
    typeof value.type !== "string" ||
    !EVENT_TYPES.has(value.type)
  ) {
    return false;
  }
  for (const key of ["repository", "headSha", "baseSha", "branch", "rawAction"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || !value[key])) return false;
  }
  for (const key of ["installationId", "pullRequestNumber"] as const) {
    if (
      value[key] !== undefined &&
      (!Number.isSafeInteger(value[key]) || Number(value[key]) <= 0)
    ) {
      return false;
    }
  }
  if (
    value.repositories !== undefined &&
    (!Array.isArray(value.repositories) ||
      value.repositories.some((repository) => typeof repository !== "string" || !repository))
  ) {
    return false;
  }
  return value.observeOnly === undefined || typeof value.observeOnly === "boolean";
}

function parseRecord(raw: string): InboxDeliveryRecord {
  const parsed = JSON.parse(raw) as unknown;
  if (
    !isRecord(parsed) ||
    parsed.format !== STATE_FORMAT ||
    parsed.record !== RECORD_KIND ||
    typeof parsed.deliveryId !== "string" ||
    !/^[A-Za-z0-9._-]+$/.test(parsed.deliveryId) ||
    !validTimestamp(parsed.receivedAt) ||
    (parsed.status !== "queued" &&
      parsed.status !== "processing" &&
      parsed.status !== "completed" &&
      parsed.status !== "awaiting-redelivery" &&
      parsed.status !== "legacy-completed") ||
    !Number.isSafeInteger(parsed.attempt) ||
    Number(parsed.attempt) < 0
  ) {
    throw new Error("Invalid GitHub durable inbox record");
  }
  const result = parsed as unknown as InboxDeliveryRecord;
  const allowedRecordKeys = new Set([
    "format",
    "record",
    "deliveryId",
    "eventName",
    "receivedAt",
    "rawBodyDigest",
    "status",
    "attempt",
    "nextAttemptAt",
    "leaseId",
    "leaseExpiresAt",
    "completedAt",
    "event",
    "legacy",
  ]);
  if (Object.keys(parsed).some((key) => !allowedRecordKeys.has(key))) {
    throw new Error("Invalid GitHub durable inbox record fields");
  }
  if (result.status === "awaiting-redelivery" || result.status === "legacy-completed") {
    if (
      result.legacy !== true ||
      result.eventName !== undefined ||
      result.rawBodyDigest !== undefined ||
      result.event !== undefined
    ) {
      throw new Error("Invalid legacy GitHub durable inbox record");
    }
  } else if (
    typeof result.eventName !== "string" ||
    !result.eventName ||
    !DIGEST_PATTERN.test(String(result.rawBodyDigest)) ||
    result.legacy !== undefined
  ) {
    throw new Error("Invalid GitHub durable inbox identity");
  }
  if (result.status === "completed" || result.status === "legacy-completed") {
    if (
      !validTimestamp(result.completedAt) ||
      result.event !== undefined ||
      result.nextAttemptAt !== undefined ||
      result.leaseId !== undefined ||
      result.leaseExpiresAt !== undefined
    ) {
      throw new Error("Invalid GitHub durable inbox tombstone");
    }
    return result;
  }
  if (result.status === "awaiting-redelivery") {
    if (
      result.event !== undefined ||
      result.nextAttemptAt !== undefined ||
      result.leaseId !== undefined ||
      result.leaseExpiresAt !== undefined ||
      result.completedAt !== undefined
    ) {
      throw new Error("Invalid GitHub awaiting-redelivery record");
    }
    return result;
  }
  if (!validEvent(result.event, result.deliveryId, result.receivedAt)) {
    throw new Error("Invalid GitHub durable inbox event");
  }
  if (result.status === "processing") {
    if (
      !result.leaseId ||
      !validTimestamp(result.leaseExpiresAt) ||
      result.nextAttemptAt !== undefined ||
      result.completedAt !== undefined
    ) {
      throw new Error("Invalid GitHub durable inbox lease");
    }
  } else if (
    !validTimestamp(result.nextAttemptAt) ||
    result.leaseId !== undefined ||
    result.leaseExpiresAt !== undefined ||
    result.completedAt !== undefined
  ) {
    throw new Error("Invalid GitHub durable inbox retry time");
  }
  return result;
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const handle = await open(directoryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function createDirectory(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
}

export class GitHubDeliveryInbox {
  private readonly githubRoot: string;
  private readonly inboxRoot: string;
  private readonly stateRoot: string;
  private readonly queueRoot: string;
  private readonly legacyRoot: string;
  private readonly leaseMs: number;
  private readonly syncFile: (
    handle: Awaited<ReturnType<typeof open>>,
    filePath: string,
  ) => Promise<void>;
  private readonly syncDirectoryPath: (directoryPath: string) => Promise<void>;
  private initialization: Promise<void> | undefined;

  constructor(
    githubRoot: string,
    options: {
      leaseMs?: number;
      syncFile?: (
        handle: Awaited<ReturnType<typeof open>>,
        filePath: string,
      ) => Promise<void>;
      syncDirectory?: (directoryPath: string) => Promise<void>;
    } = {},
  ) {
    this.githubRoot = githubRoot;
    this.inboxRoot = path.join(githubRoot, "inbox");
    this.stateRoot = path.join(this.inboxRoot, "state");
    this.queueRoot = path.join(this.inboxRoot, "queue");
    this.legacyRoot = path.join(this.inboxRoot, "legacy");
    this.leaseMs = options.leaseMs ?? 30_000;
    this.syncFile = options.syncFile ?? (async (handle) => handle.sync());
    this.syncDirectoryPath = options.syncDirectory ?? syncDirectory;
  }

  private pathsForHash(hash: string): {
    stateDirectory: string;
    statePath: string;
    queueDirectory: string;
    queuePath: string;
  } {
    const prefix = hash.slice(0, 2);
    const stateDirectory = path.join(this.stateRoot, prefix, hash);
    const queueDirectory = path.join(this.queueRoot, prefix);
    return {
      stateDirectory,
      statePath: path.join(stateDirectory, "state.json"),
      queueDirectory,
      queuePath: path.join(queueDirectory, `${hash}.queued`),
    };
  }

  private paths(deliveryId: string): ReturnType<GitHubDeliveryInbox["pathsForHash"]> {
    return this.pathsForHash(deliveryHash(deliveryId));
  }

  async initialize(): Promise<void> {
    this.initialization ??= this.initializeOnce();
    try {
      await this.initialization;
    } catch (error) {
      this.initialization = undefined;
      throw error;
    }
  }

  private async initializeOnce(): Promise<void> {
    await createDirectory(this.inboxRoot);
    await this.syncDirectoryPath(this.githubRoot);
    await createDirectory(this.stateRoot);
    await createDirectory(this.queueRoot);
    await createDirectory(this.legacyRoot);
    await this.syncDirectoryPath(this.inboxRoot);
    await withGitHubJournal(this.githubRoot, "delivery", "inbox-startup", async () => {
      await this.migrateLegacyDeliveries();
      const stateHashes = new Set<string>();
      let prefixes: string[] = [];
      try {
        prefixes = await readdir(this.stateRoot);
      } catch (error) {
        if (errno(error) !== "ENOENT") throw error;
      }
      for (const prefix of prefixes.sort()) {
        if (!/^[0-9a-f]{2}$/.test(prefix)) {
          throw new Error("Invalid GitHub durable inbox state entry");
        }
        const prefixPath = path.join(this.stateRoot, prefix);
        for (const hash of (await readdir(prefixPath)).sort()) {
          if (!HASH_PATTERN.test(hash) || !hash.startsWith(prefix)) {
            throw new Error("Invalid GitHub durable inbox state entry");
          }
          const paths = this.pathsForHash(hash);
          let record: InboxDeliveryRecord;
          try {
            record = parseRecord(await readFile(paths.statePath, "utf8"));
          } catch (error) {
            if (errno(error) === "ENOENT") continue;
            throw error;
          }
          if (deliveryHash(record.deliveryId) !== hash) {
            throw new Error("GitHub durable inbox hash does not match delivery id");
          }
          stateHashes.add(hash);
          if (record.status === "processing") {
            const recovered: InboxDeliveryRecord = {
              ...record,
              status: "queued",
              nextAttemptAt: new Date().toISOString(),
            };
            delete recovered.leaseId;
            delete recovered.leaseExpiresAt;
            await this.writeState(recovered);
            await this.ensureQueueMarker(hash);
          } else if (record.status === "queued") {
            await this.ensureQueueMarker(hash);
          } else {
            await this.removeQueueMarker(hash);
          }
        }
      }
      for (const hash of await this.queuedHashes()) {
        if (!stateHashes.has(hash)) await this.removeQueueMarker(hash);
      }
    });
  }

  private async migrateLegacyDeliveries(): Promise<void> {
    const deliveriesRoot = path.join(this.githubRoot, "deliveries");
    let names: string[];
    try {
      names = (await readdir(deliveriesRoot)).sort();
    } catch (error) {
      if (errno(error) === "ENOENT") return;
      throw error;
    }
    const groups = new Map<string, string[]>();
    for (const name of names) {
      const separator = name.lastIndexOf(".json.");
      const deliveryId = name.endsWith(".json")
        ? name.slice(0, -5)
        : separator > 0
          ? name.slice(0, separator)
          : "";
      if (!/^[A-Za-z0-9._-]+$/.test(deliveryId)) {
        throw new Error("Invalid legacy GitHub delivery filename");
      }
      const group = groups.get(deliveryId) ?? [];
      group.push(name);
      groups.set(deliveryId, group);
    }
    for (const [deliveryId, group] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
      const hash = deliveryHash(deliveryId);
      const canonicalName = `${deliveryId}.json`;
      const canonicalPath = path.join(deliveriesRoot, canonicalName);
      const existing = await this.readState(deliveryId);
      if (!existing) {
        let status: "awaiting-redelivery" | "legacy-completed" = "awaiting-redelivery";
        let claimedAt = new Date().toISOString();
        let completedAt: string | undefined;
        if (group.includes(canonicalName)) {
          const parsed = JSON.parse(await readFile(canonicalPath, "utf8")) as Record<string, unknown>;
          if (parsed.deliveryId !== deliveryId || !validTimestamp(parsed.claimedAt)) {
            throw new Error("Invalid legacy GitHub delivery canonical record");
          }
          claimedAt = parsed.claimedAt;
          if (parsed.status === "completed" && validTimestamp(parsed.completedAt)) {
            status = "legacy-completed";
            completedAt = parsed.completedAt;
          } else if (parsed.status !== "processing") {
            throw new Error("Invalid legacy GitHub delivery status");
          }
        }
        await this.writeState({
          format: STATE_FORMAT,
          record: RECORD_KIND,
          deliveryId,
          receivedAt: claimedAt,
          legacy: true,
          status,
          attempt: 0,
          ...(completedAt ? { completedAt } : {}),
        });
      }
      const targetDirectory = path.join(this.legacyRoot, hash.slice(0, 2), hash);
      await createDirectory(path.dirname(targetDirectory));
      await this.syncDirectoryPath(this.legacyRoot);
      await createDirectory(targetDirectory);
      await this.syncDirectoryPath(path.dirname(targetDirectory));
      for (const name of group) {
        await this.retainLegacyFile(
          path.join(deliveriesRoot, name),
          path.join(targetDirectory, name),
        );
      }
      await this.syncDirectoryPath(targetDirectory);
      await this.syncDirectoryPath(deliveriesRoot);
    }
    await this.syncDirectoryPath(deliveriesRoot);
  }

  private async retainLegacyFile(sourcePath: string, targetPath: string): Promise<void> {
    const sourceStat = await lstat(sourcePath);
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
      throw new Error("Legacy GitHub delivery evidence is not an ordinary file");
    }
    try {
      await link(sourcePath, targetPath);
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error;
      const targetStat = await lstat(targetPath);
      if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
        throw new Error("Conflicting legacy delivery evidence");
      }
      const [sourceBytes, targetBytes] = await Promise.all([
        readFile(sourcePath),
        readFile(targetPath),
      ]);
      if (!sourceBytes.equals(targetBytes)) {
        throw new Error("Conflicting legacy delivery evidence");
      }
    }
    await this.syncDirectoryPath(path.dirname(targetPath));
    await unlink(sourcePath);
    await this.syncDirectoryPath(path.dirname(sourcePath));
  }

  private async readState(deliveryId: string): Promise<InboxDeliveryRecord | undefined> {
    try {
      const record = parseRecord(await readFile(this.paths(deliveryId).statePath, "utf8"));
      if (record.deliveryId !== deliveryId) {
        throw new Error("GitHub durable inbox delivery id mismatch");
      }
      return record;
    } catch (error) {
      if (errno(error) === "ENOENT") return undefined;
      throw error;
    }
  }

  private async writeState(record: InboxDeliveryRecord): Promise<void> {
    const hash = deliveryHash(record.deliveryId);
    const paths = this.pathsForHash(hash);
    await createDirectory(path.dirname(paths.stateDirectory));
    await this.syncDirectoryPath(this.stateRoot);
    await createDirectory(paths.stateDirectory);
    await this.syncDirectoryPath(path.dirname(paths.stateDirectory));
    const temporaryPath = path.join(paths.stateDirectory, `.state.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await this.syncFile(handle, temporaryPath);
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, paths.statePath);
      await this.syncDirectoryPath(paths.stateDirectory);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async ensureQueueMarker(hash: string): Promise<void> {
    const paths = this.pathsForHash(hash);
    await createDirectory(paths.queueDirectory);
    await this.syncDirectoryPath(this.queueRoot);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(paths.queuePath, "wx", 0o600);
      await this.syncFile(handle, paths.queuePath);
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error;
      await handle?.close().catch(() => undefined);
      handle = await open(paths.queuePath, "r");
      await this.syncFile(handle, paths.queuePath);
    } finally {
      await handle?.close();
    }
    await this.syncDirectoryPath(paths.queueDirectory);
  }

  private async removeQueueMarker(hash: string): Promise<void> {
    const paths = this.pathsForHash(hash);
    try {
      await unlink(paths.queuePath);
      await this.syncDirectoryPath(paths.queueDirectory);
    } catch (error) {
      if (errno(error) !== "ENOENT") throw error;
    }
  }

  async enqueue(input: {
    deliveryId: string;
    eventName: string;
    receivedAt: string;
    rawBodyDigest: string;
    event: GitHubInternalEvent;
  }): Promise<InboxEnqueueResult> {
    await this.initialize();
    return withGitHubJournal(this.githubRoot, "delivery", input.deliveryId, async () => {
      const current = await this.readState(input.deliveryId);
      if (current) {
        await this.syncDirectoryPath(this.paths(input.deliveryId).stateDirectory);
        if (current.status === "legacy-completed") {
          return { outcome: "duplicate", status: current.status };
        }
        if (current.status === "awaiting-redelivery") {
          const queued: InboxDeliveryRecord = {
            format: STATE_FORMAT,
            record: RECORD_KIND,
            deliveryId: input.deliveryId,
            eventName: input.eventName,
            receivedAt: input.receivedAt,
            rawBodyDigest: input.rawBodyDigest,
            status: "queued",
            attempt: 0,
            nextAttemptAt: new Date().toISOString(),
            event: input.event,
          };
          await this.writeState(queued);
          await this.ensureQueueMarker(deliveryHash(input.deliveryId));
          return { outcome: "enqueued", status: "queued" };
        }
        if (
          current.eventName !== input.eventName ||
          current.rawBodyDigest !== input.rawBodyDigest
        ) {
          return { outcome: "conflict", status: current.status };
        }
        if (current.status !== "completed") {
          await this.ensureQueueMarker(deliveryHash(input.deliveryId));
        }
        return { outcome: "duplicate", status: current.status };
      }
      const queued: InboxDeliveryRecord = {
        format: STATE_FORMAT,
        record: RECORD_KIND,
        deliveryId: input.deliveryId,
        eventName: input.eventName,
        receivedAt: input.receivedAt,
        rawBodyDigest: input.rawBodyDigest,
        status: "queued",
        attempt: 0,
        nextAttemptAt: new Date().toISOString(),
        event: input.event,
      };
      await this.writeState(queued);
      await this.ensureQueueMarker(deliveryHash(input.deliveryId));
      return { outcome: "enqueued", status: "queued" };
    });
  }

  async completeWithoutDispatch(input: {
    deliveryId: string;
    eventName: string;
    receivedAt: string;
    rawBodyDigest: string;
  }): Promise<InboxEnqueueResult> {
    await this.initialize();
    return withGitHubJournal(this.githubRoot, "delivery", input.deliveryId, async () => {
      const current = await this.readState(input.deliveryId);
      if (current) {
        await this.syncDirectoryPath(this.paths(input.deliveryId).stateDirectory);
        if (current.status === "legacy-completed") {
          return { outcome: "duplicate", status: current.status };
        }
        if (current.status === "awaiting-redelivery") {
          const completed: InboxDeliveryRecord = {
            format: STATE_FORMAT,
            record: RECORD_KIND,
            deliveryId: input.deliveryId,
            eventName: input.eventName,
            receivedAt: input.receivedAt,
            rawBodyDigest: input.rawBodyDigest,
            status: "completed",
            attempt: 0,
            completedAt: new Date().toISOString(),
          };
          await this.writeState(completed);
          return { outcome: "enqueued", status: "completed" };
        }
        if (
          current.eventName !== input.eventName ||
          current.rawBodyDigest !== input.rawBodyDigest
        ) {
          return { outcome: "conflict", status: current.status };
        }
        return { outcome: "duplicate", status: current.status };
      }
      const completed: InboxDeliveryRecord = {
        format: STATE_FORMAT,
        record: RECORD_KIND,
        deliveryId: input.deliveryId,
        eventName: input.eventName,
        receivedAt: input.receivedAt,
        rawBodyDigest: input.rawBodyDigest,
        status: "completed",
        attempt: 0,
        completedAt: new Date().toISOString(),
      };
      await this.writeState(completed);
      return { outcome: "enqueued", status: "completed" };
    });
  }

  private async queuedHashes(): Promise<string[]> {
    const hashes: string[] = [];
    let prefixes: string[] = [];
    try {
      prefixes = await readdir(this.queueRoot);
    } catch (error) {
      if (errno(error) === "ENOENT") return [];
      throw error;
    }
    for (const prefix of prefixes.sort()) {
      if (!/^[0-9a-f]{2}$/.test(prefix)) {
        throw new Error("Invalid GitHub durable inbox queue entry");
      }
      for (const name of (await readdir(path.join(this.queueRoot, prefix))).sort()) {
        const hash = name.endsWith(".queued") ? name.slice(0, -7) : "";
        if (!HASH_PATTERN.test(hash) || !hash.startsWith(prefix)) {
          throw new Error("Invalid GitHub durable inbox queue entry");
        }
        hashes.push(hash);
      }
    }
    return hashes;
  }

  async claimNext(nowMs = Date.now()): Promise<ClaimedInboxDelivery | undefined> {
    await this.initialize();
    const observedQueue: Array<{ hash: string; record: InboxDeliveryRecord }> = [];
    for (const hash of await this.queuedHashes()) {
      const statePath = this.pathsForHash(hash).statePath;
      try {
        observedQueue.push({
          hash,
          record: parseRecord(await readFile(statePath, "utf8")),
        });
      } catch (error) {
        if (errno(error) === "ENOENT") {
          await this.removeQueueMarker(hash);
          continue;
        }
        throw error;
      }
    }
    observedQueue.sort(
      (left, right) =>
        left.record.receivedAt.localeCompare(right.record.receivedAt) ||
        left.record.deliveryId.localeCompare(right.record.deliveryId),
    );
    for (const { hash, record: observed } of observedQueue) {
      const claimed = await withGitHubJournal(
        this.githubRoot,
        "delivery",
        observed.deliveryId,
        async () => {
          const current = await this.readState(observed.deliveryId);
          if (!current || current.status === "completed") {
            await this.removeQueueMarker(hash);
            return undefined;
          }
          if (
            current.status === "processing" &&
            Date.parse(current.leaseExpiresAt!) > nowMs
          ) {
            return undefined;
          }
          if (
            current.status === "queued" &&
            Date.parse(current.nextAttemptAt!) > nowMs
          ) {
            return undefined;
          }
          const leaseId = randomUUID();
          const processing: InboxDeliveryRecord = {
            ...current,
            status: "processing",
            attempt: current.attempt + 1,
            leaseId,
            leaseExpiresAt: new Date(nowMs + this.leaseMs).toISOString(),
          };
          delete processing.nextAttemptAt;
          await this.writeState(processing);
          return {
            record: processing as ClaimedInboxDelivery["record"],
          };
        },
      );
      if (claimed) return claimed;
    }
    return undefined;
  }

  async heartbeat(deliveryId: string, leaseId: string, nowMs = Date.now()): Promise<boolean> {
    return withGitHubJournal(this.githubRoot, "delivery", deliveryId, async () => {
      const current = await this.readState(deliveryId);
      if (current?.status !== "processing" || current.leaseId !== leaseId) return false;
      current.leaseExpiresAt = new Date(nowMs + this.leaseMs).toISOString();
      await this.writeState(current);
      return true;
    });
  }

  async complete(deliveryId: string, leaseId: string, nowMs = Date.now()): Promise<boolean> {
    return withGitHubJournal(this.githubRoot, "delivery", deliveryId, async () => {
      const current = await this.readState(deliveryId);
      if (current?.status === "completed") return true;
      if (current?.status !== "processing" || current.leaseId !== leaseId) return false;
      const completed: InboxDeliveryRecord = {
        format: STATE_FORMAT,
        record: RECORD_KIND,
        deliveryId: current.deliveryId,
        eventName: current.eventName!,
        receivedAt: current.receivedAt,
        rawBodyDigest: current.rawBodyDigest!,
        status: "completed",
        attempt: current.attempt,
        completedAt: new Date(nowMs).toISOString(),
      };
      await this.writeState(completed);
      await this.removeQueueMarker(deliveryHash(deliveryId));
      return true;
    });
  }

  async retry(deliveryId: string, leaseId: string, nowMs = Date.now()): Promise<boolean> {
    return withGitHubJournal(this.githubRoot, "delivery", deliveryId, async () => {
      const current = await this.readState(deliveryId);
      if (current?.status !== "processing" || current.leaseId !== leaseId) return false;
      const delayMs = Math.min(250 * 2 ** Math.max(0, current.attempt - 1), 30_000);
      const queued: InboxDeliveryRecord = {
        ...current,
        status: "queued",
        nextAttemptAt: new Date(nowMs + delayMs).toISOString(),
      };
      delete queued.leaseId;
      delete queued.leaseExpiresAt;
      await this.writeState(queued);
      await this.ensureQueueMarker(deliveryHash(deliveryId));
      return true;
    });
  }

  async pendingCount(): Promise<number> {
    await this.initialize();
    return (await this.queuedHashes()).length;
  }
}
