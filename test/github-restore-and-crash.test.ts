import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  compareAndSwapFile,
  restoreMoved,
  unlinkIfBytesMatch,
} from "../src/github/lock-ownership.ts";
import { GitHubDeliveryStore } from "../src/github/delivery-store.ts";

test("restoreMoved never renames over a newer successor", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-restore-c-"));
  const filePath = path.join(root, "lock");
  const reclaimPath = path.join(root, "lock.reclaim");
  const b = `${JSON.stringify({ token: "B" })}\n`;
  const c = `${JSON.stringify({ token: "C" })}\n`;
  await writeFile(reclaimPath, b);
  await writeFile(filePath, c);

  const restored = await restoreMoved(reclaimPath, filePath);
  assert.equal(restored, false);
  assert.equal(await readFile(filePath, "utf8"), c);
});

test("unlinkIfBytesMatch mismatch recovery preserves newer successor C", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-unlink-c-"));
  const filePath = path.join(root, "lock");
  const expected = `${JSON.stringify({ token: "A-dead" })}\n`;
  const b = `${JSON.stringify({ token: "B" })}\n`;
  const c = `${JSON.stringify({ token: "C" })}\n`;
  await writeFile(filePath, expected);

  const ok = await unlinkIfBytesMatch(filePath, expected, {
    afterPathMoved: async (canonical, reclaimPath) => {
      // Successor B appears at canonical (already moved expected aside).
      await writeFile(canonical, b);
      // Newer successor C replaces B before mismatch recovery runs —
      // simulated by rewriting after we force a mismatch: put wrong bytes in reclaim.
      await writeFile(reclaimPath, `${JSON.stringify({ token: "not-expected" })}\n`);
      await writeFile(canonical, c);
    },
  });
  assert.equal(ok, false);
  assert.equal(await readFile(filePath, "utf8"), c);
});

test("compareAndSwapFile mismatch recovery preserves newer successor C", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-cas-c-"));
  const filePath = path.join(root, "delivery.json");
  const expected = `${JSON.stringify({ leaseId: "A", status: "processing" })}\n`;
  const c = `${JSON.stringify({ leaseId: "C", status: "processing" })}\n`;
  await writeFile(filePath, expected);

  const ok = await compareAndSwapFile(
    filePath,
    expected,
    `${JSON.stringify({ leaseId: "A", status: "completed" })}\n`,
    {
      afterPathMoved: async (canonical, reclaimPath) => {
        await writeFile(reclaimPath, `${JSON.stringify({ leaseId: "B" })}\n`);
        await writeFile(canonical, c);
      },
    },
  );
  assert.equal(ok, false);
  assert.equal(await readFile(filePath, "utf8"), c);
});

test("delivery claim recovers crash mid-complete instead of redispatching", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-crash-gap-"));
  const store = new GitHubDeliveryStore(root, { staleProcessingMs: 60_000 });
  const first = await store.claim("d-crash");
  assert.ok(first.leaseId);

  const canonical = path.join(root, "deliveries", "d-crash.json");
  const processing = await readFile(canonical, "utf8");
  const completed = `${JSON.stringify({
    ...JSON.parse(processing),
    status: "completed",
    completedAt: new Date().toISOString(),
  })}\n`;

  // Simulate crash after processing was moved aside and staging was written.
  await writeFile(`${canonical}.staging`, completed);
  await rename(canonical, `${canonical}.reclaim`);

  const again = await store.claim("d-crash");
  assert.equal(again.claimed, false);
  assert.equal(again.duplicate, true);
  assert.equal(again.status, "completed");

  const raw = await readFile(canonical, "utf8");
  assert.equal(JSON.parse(raw).status, "completed");
  assert.equal(JSON.parse(raw).leaseId, first.leaseId);
});
