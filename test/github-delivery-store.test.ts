import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitHubDeliveryStore } from "../src/github/delivery-store.ts";

test("delivery store claims a new delivery id once until completed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-delivery-"));
  const store = new GitHubDeliveryStore(root);
  const first = await store.claim("delivery-1");
  assert.equal(first.claimed, true);
  assert.equal(first.duplicate, false);
  assert.ok(first.leaseId);

  const inFlight = await store.claim("delivery-1");
  assert.equal(inFlight.claimed, false);
  assert.equal(inFlight.duplicate, true);
  assert.equal(inFlight.status, "processing");

  await store.complete("delivery-1", first.leaseId!);
  const replay = await store.claim("delivery-1");
  assert.equal(replay.claimed, false);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.status, "completed");
});

test("delivery store releases failed claims for retry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-delivery-fail-"));
  const store = new GitHubDeliveryStore(root);
  const first = await store.claim("delivery-2");
  assert.equal(first.claimed, true);
  await store.fail("delivery-2", "boom", first.leaseId!);
  const retry = await store.claim("delivery-2");
  assert.equal(retry.claimed, true);
  assert.equal(retry.duplicate, false);
});

test("delivery store rejects empty delivery ids", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-delivery-bad-"));
  const store = new GitHubDeliveryStore(root);
  await assert.rejects(() => store.claim(""), /delivery/i);
  await assert.rejects(() => store.claim("../escape"), /delivery/i);
});

test("completion remains structurally valid if the wall clock moves behind claimedAt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-delivery-clock-"));
  const store = new GitHubDeliveryStore(root);
  const futureClaimedAt = Date.now() + 60_000;
  const first = await store.claim("delivery-clock", futureClaimedAt);
  assert.ok(first.leaseId);

  assert.deepEqual(await store.complete("delivery-clock", first.leaseId!), { ok: true });
  const replay = await store.claim("delivery-clock");
  assert.equal(replay.status, "completed");
});
