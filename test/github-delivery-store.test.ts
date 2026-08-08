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

  const inFlight = await store.claim("delivery-1");
  assert.equal(inFlight.claimed, false);
  assert.equal(inFlight.duplicate, true);
  assert.equal(inFlight.status, "processing");

  await store.complete("delivery-1");
  const replay = await store.claim("delivery-1");
  assert.equal(replay.claimed, false);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.status, "completed");
});

test("delivery store releases failed claims for retry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-delivery-fail-"));
  const store = new GitHubDeliveryStore(root);
  assert.equal((await store.claim("delivery-2")).claimed, true);
  await store.fail("delivery-2", "boom");
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
