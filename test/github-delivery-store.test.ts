import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitHubDeliveryStore } from "../src/github/delivery-store.ts";

test("delivery store claims a new delivery id once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-delivery-"));
  const store = new GitHubDeliveryStore(root);
  const first = await store.claim("delivery-1");
  assert.equal(first.claimed, true);
  assert.equal(first.duplicate, false);

  const replay = await store.claim("delivery-1");
  assert.equal(replay.claimed, false);
  assert.equal(replay.duplicate, true);
});

test("delivery store rejects empty delivery ids", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-delivery-bad-"));
  const store = new GitHubDeliveryStore(root);
  await assert.rejects(() => store.claim(""), /delivery/i);
  await assert.rejects(() => store.claim("../escape"), /delivery/i);
});
