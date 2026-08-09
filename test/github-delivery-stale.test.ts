import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitHubDeliveryStore } from "../src/github/delivery-store.ts";

test("stale processing claims can be reclaimed after crash TTL", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-stale-del-"));
  const store = new GitHubDeliveryStore(root, { staleProcessingMs: 1 });
  assert.equal((await store.claim("d1")).claimed, true);

  // Simulate a crash leaving processing forever by rewriting claimedAt into the past.
  const file = path.join(root, "deliveries", "d1.json");
  await writeFile(
    file,
    `${JSON.stringify({
      deliveryId: "d1",
      status: "processing",
      claimedAt: new Date(Date.now() - 10_000).toISOString(),
    })}\n`,
  );

  const reclaim = await store.claim("d1");
  assert.equal(reclaim.claimed, true);
  assert.equal(reclaim.duplicate, false);
});

test("fresh processing claims remain duplicates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-fresh-del-"));
  const store = new GitHubDeliveryStore(root, { staleProcessingMs: 60_000 });
  assert.equal((await store.claim("d2")).claimed, true);
  const again = await store.claim("d2");
  assert.equal(again.claimed, false);
  assert.equal(again.duplicate, true);
  assert.equal(again.status, "processing");
});
