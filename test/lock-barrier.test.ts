import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, open, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { FileRunStore, reclaimStaleRunLock } from "../src/store.ts";

test("incomplete lock is never auto-reclaimed while a live owner may still be initializing", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-lock-incomplete-"));
  const store = new FileRunStore(cwd, { lockRetries: 4 });
  const run = await store.create("incomplete", "lock", DEFAULT_CONFIG);
  const lockPath = path.join(cwd, ".maswe", "runs", run.id, ".lock");

  // Simulate exclusive create before metadata write completes.
  const holder = await open(lockPath, "wx");
  // Empty / incomplete content — no owner token yet.
  await holder.writeFile("", "utf8");

  run.title = "must-not-steal";
  await assert.rejects(store.save(run), /lock contention|exclusive lock/i);

  const raw = await readFile(lockPath, "utf8");
  assert.equal(raw, "");
  await holder.close();
  await rm(lockPath, { force: true });
});

test("replacement lock created between reclaim inspect and delete is preserved", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-lock-toctou-"));
  await mkdir(path.join(cwd, ".maswe", "runs", "r1"), { recursive: true });
  const lockPath = path.join(cwd, ".maswe", "runs", "r1", ".lock");

  await writeFile(
    lockPath,
    `${JSON.stringify({
      pid: 1_000_000_042,
      owner: "dead-owner",
      at: new Date(Date.now() - 60_000).toISOString(),
    })}\n`,
    "utf8",
  );

  const liveMeta = {
    pid: process.pid,
    owner: "live-replacement",
    at: new Date().toISOString(),
  };

  const reclaimed = await reclaimStaleRunLock(lockPath, {
    afterInspect: async () => {
      // A new holder won the race and wrote a live lock before deletion.
      await writeFile(lockPath, `${JSON.stringify(liveMeta)}\n`, "utf8");
    },
  });

  assert.equal(reclaimed, false);
  const onDisk = JSON.parse(await readFile(lockPath, "utf8")) as { owner: string; pid: number };
  assert.equal(onDisk.owner, "live-replacement");
  assert.equal(onDisk.pid, process.pid);
});
