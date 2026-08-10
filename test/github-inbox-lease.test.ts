import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitHubDeliveryInbox } from "../src/github/delivery-inbox.ts";
import type { GitHubInternalEvent } from "../src/github/types.ts";

const RECEIVED_AT = "2026-08-10T00:00:00.000Z";
const BODY_DIGEST = `sha256:${"a".repeat(64)}`;

function event(deliveryId: string): GitHubInternalEvent {
  return {
    eventId: deliveryId,
    type: "push",
    repository: "owner/repo",
    installationId: 44,
    headSha: "sha",
    branch: "feature",
    receivedAt: RECEIVED_AT,
  };
}

async function enqueue(inbox: GitHubDeliveryInbox, deliveryId: string): Promise<void> {
  assert.equal(
    (await inbox.enqueue({
      deliveryId,
      eventName: "push",
      receivedAt: RECEIVED_AT,
      rawBodyDigest: BODY_DIGEST,
      event: event(deliveryId),
    })).outcome,
    "enqueued",
  );
}

test("heartbeat extends a lease and stale reclaim issues one successor lease", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-inbox-heartbeat-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const inbox = new GitHubDeliveryInbox(root, { leaseMs: 1_000 });
  await enqueue(inbox, "lease-heartbeat");
  const base = Date.now() + 1;

  const first = await inbox.claimNext(base);
  assert.ok(first);
  assert.equal(await inbox.heartbeat("lease-heartbeat", first.record.leaseId, base + 500), true);
  assert.equal(await inbox.claimNext(base + 1_100), undefined);
  const successor = await inbox.claimNext(base + 1_501);
  assert.ok(successor);
  assert.notEqual(successor.record.leaseId, first.record.leaseId);
  assert.equal(await inbox.complete("lease-heartbeat", first.record.leaseId, base + 1_600), false);
  assert.equal(await inbox.complete("lease-heartbeat", successor.record.leaseId, base + 1_600), true);
});

test("retry backoff prevents an immediate redispatch", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-inbox-backoff-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const inbox = new GitHubDeliveryInbox(root);
  await enqueue(inbox, "retry-backoff");
  const base = Date.now() + 1;
  const first = await inbox.claimNext(base);
  assert.ok(first);
  assert.equal(await inbox.retry("retry-backoff", first.record.leaseId, base), true);
  assert.equal(await inbox.claimNext(base + 249), undefined);
  const retry = await inbox.claimNext(base + 250);
  assert.ok(retry);
  assert.equal(retry.record.attempt, 2);
});

test("concurrent claimers publish exactly one processing lease", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-inbox-concurrent-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const firstInbox = new GitHubDeliveryInbox(root);
  const secondInbox = new GitHubDeliveryInbox(root);
  await enqueue(firstInbox, "concurrent-lease");

  const claims = await Promise.all([
    firstInbox.claimNext(Date.now() + 1),
    secondInbox.claimNext(Date.now() + 1),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.ok(claims.find(Boolean)?.record.leaseId);
});
