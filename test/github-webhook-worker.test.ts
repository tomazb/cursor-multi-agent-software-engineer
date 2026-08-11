import assert from "node:assert/strict";
import test from "node:test";
import type { GitHubDeliveryInbox } from "../src/github/delivery-inbox.ts";
import { GitHubWebhookWorker } from "../src/github/webhook-worker.ts";

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function withWatchdog<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("an immediate wake requested during a scan runs before the existing delay", async (t) => {
  const firstScanStarted = deferred();
  const releaseFirstScan = deferred();
  const secondScanStarted = deferred();
  let claimCalls = 0;
  const inbox = {
    async claimNextPage() {
      claimCalls += 1;
      if (claimCalls === 1) {
        firstScanStarted.resolve();
        await releaseFirstScan.promise;
      } else if (claimCalls === 2) {
        secondScanStarted.resolve();
      }
      return { scanned: 0 };
    },
    async pendingCount() {
      return 0;
    },
  } as unknown as GitHubDeliveryInbox;
  const worker = new GitHubWebhookWorker({
    inbox,
    dispatch: async () => undefined,
  });
  t.after(async () => worker.stop({ drainMs: 0 }));

  worker.start();
  await firstScanStarted.promise;
  worker.wake(0);
  releaseFirstScan.resolve();

  await withWatchdog(
    secondScanStarted.promise,
    250,
    "active worker lost its immediate wake",
  );
  assert.equal(claimCalls, 2);
});

test("retry persistence failure backs off before another queue scan", async (t) => {
  let claimCalls = 0;
  let resolveScheduled!: (delayMs: number) => void;
  const scheduled = new Promise<number>((resolve) => {
    resolveScheduled = resolve;
  });
  const inbox = {
    async claimNextPage() {
      claimCalls += 1;
      if (claimCalls === 1) {
        return {
          scanned: 1,
          claimed: {
            record: {
              format: 2,
              record: "github-delivery-inbox",
              deliveryId: "retry-write-failure",
              eventName: "push",
              receivedAt: "2026-08-10T00:00:00.000Z",
              rawBodyDigest: `sha256:${"a".repeat(64)}`,
              status: "processing",
              attempt: 1,
              leaseId: "lease-1",
              leaseExpiresAt: "2026-08-10T00:00:30.000Z",
              event: {
                eventId: "retry-write-failure",
                type: "push",
                repository: "owner/repo",
                installationId: 1,
                headSha: "head",
                branch: "feature",
                receivedAt: "2026-08-10T00:00:00.000Z",
              },
            },
          },
        };
      }
      return { scanned: 0 };
    },
    async heartbeat() {
      return true;
    },
    async retry() {
      throw new Error("simulated retry fsync failure");
    },
    async pendingCount() {
      return 1;
    },
  } as unknown as GitHubDeliveryInbox;
  const worker = new GitHubWebhookWorker({
    inbox,
    dispatch: async () => {
      throw new Error("simulated dispatch failure");
    },
    onSchedule: resolveScheduled,
  });
  t.after(async () => worker.stop({ drainMs: 0 }));

  worker.start();
  const delayMs = await withWatchdog(
    scheduled,
    1_000,
    "worker retry backoff was not scheduled",
  );

  assert.equal(claimCalls, 1, "retry persistence failure rescanned before backoff");
  assert.ok(delayMs >= 250, `retry persistence failure scheduled only ${delayMs}ms backoff`);
});

test("claim failure backs off before another queue scan", async (t) => {
  let claimCalls = 0;
  let resolveScheduled!: (delayMs: number) => void;
  const scheduled = new Promise<number>((resolve) => {
    resolveScheduled = resolve;
  });
  const inbox = {
    async claimNextPage() {
      claimCalls += 1;
      if (claimCalls === 1) throw new Error("simulated queue scan failure");
      return { scanned: 0 };
    },
    async pendingCount() {
      return 1;
    },
  } as unknown as GitHubDeliveryInbox;
  const worker = new GitHubWebhookWorker({
    inbox,
    dispatch: async () => undefined,
    onSchedule: resolveScheduled,
  });
  t.after(async () => worker.stop({ drainMs: 0 }));

  worker.start();
  const delayMs = await withWatchdog(
    scheduled,
    1_000,
    "worker scan backoff was not scheduled",
  );

  assert.equal(claimCalls, 1, "failed queue scan repeated before backoff");
  assert.ok(delayMs >= 250, `queue scan failure scheduled only ${delayMs}ms backoff`);
});

test("durable completion failure is not mislabeled as dispatch failure", async (t) => {
  const diagnostics: Array<{ code?: unknown }> = [];
  let claimCalls = 0;
  let resolveScheduled!: (delayMs: number) => void;
  const scheduled = new Promise<number>((resolve) => {
    resolveScheduled = resolve;
  });
  const inbox = {
    async claimNextPage() {
      claimCalls += 1;
      if (claimCalls > 1) return { scanned: 0 };
      return {
        scanned: 1,
        claimed: {
          record: {
            format: 2,
            record: "github-delivery-inbox",
            deliveryId: "completion-write-failure",
            eventName: "push",
            receivedAt: "2026-08-10T00:00:00.000Z",
            rawBodyDigest: `sha256:${"b".repeat(64)}`,
            status: "processing",
            attempt: 1,
            leaseId: "lease-complete",
            leaseExpiresAt: "2026-08-10T00:00:30.000Z",
            event: {
              eventId: "completion-write-failure",
              type: "push",
              repository: "owner/repo",
              installationId: 1,
              headSha: "head",
              branch: "feature",
              receivedAt: "2026-08-10T00:00:00.000Z",
            },
          },
        },
      };
    },
    async heartbeat() {
      return true;
    },
    async complete() {
      throw new Error("simulated completion fsync failure");
    },
    async retry() {
      return true;
    },
    async pendingCount() {
      return 1;
    },
  } as unknown as GitHubDeliveryInbox;
  const worker = new GitHubWebhookWorker({
    inbox,
    dispatch: async () => undefined,
    onDiagnostic: (error) => diagnostics.push(error as { code?: unknown }),
    onSchedule: resolveScheduled,
  });
  t.after(async () => worker.stop({ drainMs: 0 }));

  worker.start();
  await withWatchdog(
    scheduled,
    1_000,
    "completion failure schedule was not exposed",
  );

  assert.equal(diagnostics.some(({ code }) => code === "GITHUB_WEBHOOK_DISPATCH_FAILED"), false);
  assert.equal(diagnostics.some(({ code }) => code === "GITHUB_WEBHOOK_COMPLETION_FAILED"), true);
});
