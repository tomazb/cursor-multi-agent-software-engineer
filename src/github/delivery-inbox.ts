import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, mkdir, readFile, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { withGitHubJournal } from "./journal.ts";
import type { GitHubInternalEvent } from "./types.ts";
import { isSafeGitHubDeliveryId } from "./delivery-id.ts";
import {
  HASH_PATTERN,
  RECORD_KIND,
  STATE_FORMAT,
  parseLegacyCanonicalRecord,
  parseRecord,
  validEvent,
  type ClaimedInboxDelivery,
  type InboxClaimPage,
  type InboxDeliveryRecord,
  type InboxEnqueueResult,
} from "./delivery-inbox-record.ts";
export type {
  ClaimedInboxDelivery,
  InboxClaimPage,
  InboxDeliveryRecord,
  InboxDeliveryStatus,
  InboxEnqueueResult,
} from "./delivery-inbox-record.ts";

const DEFAULT_QUEUE_SCAN_PAGE = 128;
const MAX_QUEUE_SCAN_PAGE = 256;
const MAX_INBOX_STATE_BYTES = 1024 * 1024;
const MAX_LEASE_ID = "00000000-0000-4000-8000-000000000000";
const MAX_ISO_TIMESTAMP = "+275760-09-13T00:00:00.000Z";

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function deliveryHash(deliveryId: string): string {
  return createHash("sha256").update(deliveryId).digest("hex");
}


async function syncDirectory(directoryPath: string): Promise<void> {
  const handle = await open(directoryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function createDirectory(directoryPath: string): Promise<boolean> {
  try {
    const stat = await lstat(directoryPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("GitHub durable inbox path is not an ordinary directory");
    }
    return false;
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error;
  }
  try {
    await mkdir(directoryPath, { mode: 0o700 });
  } catch (error) {
    if (errno(error) !== "EEXIST") throw error;
  }
  const stat = await lstat(directoryPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("GitHub durable inbox path is not an ordinary directory");
  }
  return true;
}

function requireNoFollowFlag(noFollow: number | null | undefined): number {
  if (typeof noFollow !== "number" || noFollow === 0) {
    throw new Error("Non-following GitHub inbox reads are unavailable");
  }
  return noFollow;
}

async function readOrdinaryFile(
  filePath: string,
  noFollow = requireNoFollowFlag(constants.O_NOFOLLOW),
  afterStat?: (filePath: string) => Promise<void>,
): Promise<Buffer> {
  const handle = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_INBOX_STATE_BYTES) {
      throw new Error("GitHub durable inbox evidence is not an ordinary bounded file");
    }
    await afterStat?.(filePath);
    const bytes = Buffer.alloc(MAX_INBOX_STATE_BYTES + 1);
    let total = 0;
    while (total < bytes.length) {
      const chunk = await handle.read(bytes, total, bytes.length - total, null);
      if (chunk.bytesRead === 0) break;
      total += chunk.bytesRead;
    }
    if (total > MAX_INBOX_STATE_BYTES) {
      throw new Error("GitHub durable inbox evidence exceeds its bounded file limit");
    }
    return bytes.subarray(0, total);
  } finally {
    await handle.close();
  }
}

export class GitHubDeliveryInbox {
  private readonly githubRoot: string;
  private readonly inboxRoot: string;
  private readonly stateRoot: string;
  private readonly queueRoot: string;
  private readonly legacyRoot: string;
  private readonly leaseMs: number;
  private readonly noFollowFlag: number;
  private readonly syncFile: (
    handle: Awaited<ReturnType<typeof open>>,
    filePath: string,
  ) => Promise<void>;
  private readonly syncDirectoryPath: (directoryPath: string) => Promise<void>;
  private readonly afterStateStat: ((statePath: string) => Promise<void>) | undefined;
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
      noFollowFlag?: number | null;
      /** Deterministic test seam for proving bounded reads across post-stat growth. */
      afterStateStat?: (statePath: string) => Promise<void>;
    } = {},
  ) {
    this.githubRoot = githubRoot;
    this.inboxRoot = path.join(githubRoot, "inbox");
    this.stateRoot = path.join(this.inboxRoot, "state");
    this.queueRoot = path.join(this.inboxRoot, "queue");
    this.legacyRoot = path.join(this.inboxRoot, "legacy");
    this.leaseMs = options.leaseMs ?? 30_000;
    this.noFollowFlag = requireNoFollowFlag(
      options.noFollowFlag === undefined ? constants.O_NOFOLLOW : options.noFollowFlag,
    );
    this.syncFile = options.syncFile ?? (async (handle) => handle.sync());
    this.syncDirectoryPath = options.syncDirectory ?? syncDirectory;
    this.afterStateStat = options.afterStateStat;
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
    const stateRoot = path.dirname(this.githubRoot);
    if (await createDirectory(stateRoot)) {
      await this.syncDirectoryPath(path.dirname(stateRoot));
    }
    if (await createDirectory(this.githubRoot)) {
      await this.syncDirectoryPath(stateRoot);
    }
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
        await createDirectory(prefixPath);
        for (const hash of (await readdir(prefixPath)).sort()) {
          if (!HASH_PATTERN.test(hash) || !hash.startsWith(prefix)) {
            throw new Error("Invalid GitHub durable inbox state entry");
          }
          const paths = this.pathsForHash(hash);
          await createDirectory(paths.stateDirectory);
          let record: InboxDeliveryRecord;
          try {
            record = parseRecord(
              (await readOrdinaryFile(
                paths.statePath,
                this.noFollowFlag,
                this.afterStateStat,
              )).toString("utf8"),
            );
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
      const stat = await lstat(deliveriesRoot);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("GitHub durable inbox path is not an ordinary directory");
      }
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
      if (!isSafeGitHubDeliveryId(deliveryId)) {
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
          const parsed = parseLegacyCanonicalRecord(
            (await readOrdinaryFile(canonicalPath, this.noFollowFlag)).toString("utf8"),
            deliveryId,
          );
          claimedAt = parsed.claimedAt;
          if (parsed.status === "completed") {
            status = "legacy-completed";
            completedAt = parsed.completedAt;
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
        readOrdinaryFile(sourcePath, this.noFollowFlag),
        readOrdinaryFile(targetPath, this.noFollowFlag),
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
      const record = parseRecord(
        (await readOrdinaryFile(
          this.paths(deliveryId).statePath,
          this.noFollowFlag,
          this.afterStateStat,
        )).toString("utf8"),
      );
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
    const content = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(content, "utf8") > MAX_INBOX_STATE_BYTES) {
      throw new Error(
        `GitHub durable inbox state exceeds its bounded ${MAX_INBOX_STATE_BYTES}-byte capacity`,
      );
    }
    if (record.status === "queued") {
      const largestProcessing: InboxDeliveryRecord = {
        ...record,
        status: "processing",
        attempt: Number.MAX_SAFE_INTEGER,
        leaseId: MAX_LEASE_ID,
        leaseExpiresAt: MAX_ISO_TIMESTAMP,
      };
      delete largestProcessing.nextAttemptAt;
      if (
        Buffer.byteLength(`${JSON.stringify(largestProcessing)}\n`, "utf8") >
        MAX_INBOX_STATE_BYTES
      ) {
        throw new Error(
          "GitHub durable inbox state exceeds lifecycle capacity after lease expansion",
        );
      }
    }
    await createDirectory(path.dirname(paths.stateDirectory));
    await this.syncDirectoryPath(this.stateRoot);
    await createDirectory(paths.stateDirectory);
    await this.syncDirectoryPath(path.dirname(paths.stateDirectory));
    const temporaryPath = path.join(paths.stateDirectory, `.state.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(content, "utf8");
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
      handle = await open(paths.queuePath, constants.O_RDONLY | this.noFollowFlag);
      if (!(await handle.stat()).isFile()) {
        throw new Error("GitHub durable inbox queue marker is not an ordinary file");
      }
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
    if (!isSafeGitHubDeliveryId(input.deliveryId)) {
      throw new Error("Invalid GitHub delivery id");
    }
    await this.initialize();
    if (!validEvent(input.event, input.deliveryId, input.receivedAt, input.eventName)) {
      throw new Error("Invalid GitHub durable inbox event");
    }
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
    if (!isSafeGitHubDeliveryId(input.deliveryId)) {
      throw new Error("Invalid GitHub delivery id");
    }
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
      const prefixPath = path.join(this.queueRoot, prefix);
      await createDirectory(prefixPath);
      for (const name of (await readdir(prefixPath)).sort()) {
        const hash = name.endsWith(".queued") ? name.slice(0, -7) : "";
        if (!HASH_PATTERN.test(hash) || !hash.startsWith(prefix)) {
          throw new Error("Invalid GitHub durable inbox queue entry");
        }
        hashes.push(hash);
      }
    }
    return hashes;
  }

  private async queuedHashPage(
    cursor: string | undefined,
    limit: number,
  ): Promise<{ hashes: string[]; nextCursor?: string }> {
    if (cursor !== undefined && !HASH_PATTERN.test(cursor)) {
      throw new Error("Invalid GitHub durable inbox queue cursor");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_QUEUE_SCAN_PAGE) {
      throw new Error(`GitHub durable inbox queue page limit must be 1-${MAX_QUEUE_SCAN_PAGE}`);
    }
    let prefixes: string[];
    try {
      prefixes = (await readdir(this.queueRoot)).sort();
    } catch (error) {
      if (errno(error) === "ENOENT") return { hashes: [] };
      throw error;
    }
    const hashes: string[] = [];
    let hasMore = false;
    scan: for (const prefix of prefixes) {
      if (!/^[0-9a-f]{2}$/.test(prefix)) {
        throw new Error("Invalid GitHub durable inbox queue entry");
      }
      if (cursor !== undefined && prefix < cursor.slice(0, 2)) continue;
      const prefixPath = path.join(this.queueRoot, prefix);
      await createDirectory(prefixPath);
      for (const name of (await readdir(prefixPath)).sort()) {
        const hash = name.endsWith(".queued") ? name.slice(0, -7) : "";
        if (!HASH_PATTERN.test(hash) || !hash.startsWith(prefix)) {
          throw new Error("Invalid GitHub durable inbox queue entry");
        }
        if (cursor !== undefined && hash <= cursor) continue;
        if (hashes.length === limit) {
          hasMore = true;
          break scan;
        }
        hashes.push(hash);
      }
    }
    return {
      hashes,
      ...(hasMore ? { nextCursor: hashes.at(-1)! } : {}),
    };
  }

  async claimNext(nowMs = Date.now()): Promise<ClaimedInboxDelivery | undefined> {
    let cursor: string | undefined;
    do {
      const page = await this.claimNextPage(nowMs, {
        ...(cursor !== undefined ? { cursor } : {}),
      });
      if (page.claimed) return page.claimed;
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return undefined;
  }

  async claimNextPage(
    nowMs = Date.now(),
    options: { cursor?: string; limit?: number } = {},
  ): Promise<InboxClaimPage> {
    await this.initialize();
    const observedQueue: Array<{ hash: string; record: InboxDeliveryRecord }> = [];
    const queuePage = await this.queuedHashPage(
      options.cursor,
      options.limit ?? DEFAULT_QUEUE_SCAN_PAGE,
    );
    for (const hash of queuePage.hashes) {
      const statePath = this.pathsForHash(hash).statePath;
      try {
        observedQueue.push({
          hash,
          record: parseRecord(
            (await readOrdinaryFile(
              statePath,
              this.noFollowFlag,
              this.afterStateStat,
            )).toString("utf8"),
          ),
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
    let nextAttemptAt: number | undefined;
    for (const { hash, record: observed } of observedQueue) {
      const outcome = await withGitHubJournal(
        this.githubRoot,
        "delivery",
        observed.deliveryId,
        async () => {
          const current = await this.readState(observed.deliveryId);
          if (
            !current ||
            current.status === "completed" ||
            current.status === "awaiting-redelivery" ||
            current.status === "legacy-completed"
          ) {
            await this.removeQueueMarker(hash);
            return undefined;
          }
          if (
            current.status === "processing" &&
            Date.parse(current.leaseExpiresAt!) > nowMs
          ) {
            return { deferredUntil: Date.parse(current.leaseExpiresAt!) } as const;
          }
          if (
            current.status === "queued" &&
            Date.parse(current.nextAttemptAt!) > nowMs
          ) {
            return { deferredUntil: Date.parse(current.nextAttemptAt!) } as const;
          }
          if (current.attempt >= Number.MAX_SAFE_INTEGER) {
            throw new Error("GitHub durable inbox delivery attempt limit is exhausted");
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
            claimed: {
              record: processing as ClaimedInboxDelivery["record"],
            },
          } as const;
        },
      );
      if (outcome && "claimed" in outcome) {
        return {
          claimed: outcome.claimed,
          scanned: queuePage.hashes.length,
          ...(queuePage.nextCursor ? { nextCursor: queuePage.nextCursor } : {}),
        };
      }
      if (outcome && "deferredUntil" in outcome) {
        nextAttemptAt = nextAttemptAt === undefined
          ? outcome.deferredUntil
          : Math.min(nextAttemptAt, outcome.deferredUntil);
      }
    }
    return {
      scanned: queuePage.hashes.length,
      ...(nextAttemptAt !== undefined ? { nextAttemptAt } : {}),
      ...(queuePage.nextCursor ? { nextCursor: queuePage.nextCursor } : {}),
    };
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
