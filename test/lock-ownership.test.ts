import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { FileRunStore } from "../src/store.ts";

test("live lock older than stale threshold is not stolen", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-live-lock-"));
  const store = new FileRunStore(cwd, { lockStaleMs: 50, lockRetries: 5 });
  const run = await store.create("live", "lock", DEFAULT_CONFIG);
  const lockPath = path.join(cwd, ".maswe", "runs", run.id, ".lock");

  const holder = await open(lockPath, "wx");
  const token = "owner-token-live";
  await holder.writeFile(
    `${JSON.stringify({
      pid: process.pid,
      owner: token,
      at: new Date(Date.now() - 120_000).toISOString(),
    })}\n`,
    "utf8",
  );

  run.title = "should-fail";
  await assert.rejects(store.save(run), /lock contention|exclusive lock/i);

  const onDisk = JSON.parse(await readFile(lockPath, "utf8")) as { owner?: string };
  assert.equal(onDisk.owner, token);
  await holder.close();
  await rm(lockPath, { force: true });
});

test("two simultaneous stale reclaimers cannot delete each other's new lock", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-reclaim-"));
  const storeA = new FileRunStore(cwd, { lockStaleMs: 10, lockRetries: 30 });
  const storeB = new FileRunStore(cwd, { lockStaleMs: 10, lockRetries: 30 });
  const run = await storeA.create("race", "reclaim", DEFAULT_CONFIG);
  const lockPath = path.join(cwd, ".maswe", "runs", run.id, ".lock");

  await writeFile(
    lockPath,
    `${JSON.stringify({
      pid: 1_000_000_007,
      owner: "dead-owner",
      at: new Date(Date.now() - 60_000).toISOString(),
    })}\n`,
    "utf8",
  );

  const a = structuredClone(run);
  const b = structuredClone(run);
  a.title = "writer-a";
  b.title = "writer-b";

  const results = await Promise.allSettled([storeA.save(a), storeB.save(b)]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);

  const loaded = await storeA.load(run.id);
  assert.ok(loaded.title === "writer-a" || loaded.title === "writer-b");
});
