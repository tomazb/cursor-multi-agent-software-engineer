import assert from "node:assert/strict";
import { link, mkdtemp, writeFile, readFile, open, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  publishClaimRelease,
  publishLockClaim,
  validateClaimOwnership,
} from "../src/lock-journal.ts";
import { FileRunStore } from "../src/store.ts";

async function installLinkLock(
  lockPath: string,
  meta: { pid: number; owner: string; at: string },
): Promise<void> {
  const tmp = `${lockPath}.${meta.owner}.tmp`;
  await writeFile(tmp, `${JSON.stringify(meta)}\n`, "utf8");
  await link(tmp, lockPath);
  await rm(tmp, { force: true });
}

test("incomplete lock is never auto-reclaimed while a live owner may still be initializing", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-lock-incomplete-"));
  const store = new FileRunStore(cwd, { lockRetries: 4 });
  const run = await store.create("incomplete", "lock", DEFAULT_CONFIG);
  const lockPath = path.join(cwd, ".maswe", "runs", run.id, ".lock");

  const holder = await open(lockPath, "wx");
  await holder.writeFile("", "utf8");

  run.title = "must-not-steal";
  await assert.rejects(
    store.save(run),
    /lock contention|stale lock|maswe unlock|corrupt|incomplete/i,
  );

  const raw = await readFile(lockPath, "utf8");
  assert.equal(raw, "");
  await holder.close();
  await rm(lockPath, { force: true });
});

test("four-actor race: two unlockers cannot hand the lock to a second acquirer over a replacement owner", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-lock-four-"));
  const store = new FileRunStore(cwd, { lockRetries: 8 });
  const run = await store.create("four", "actors", DEFAULT_CONFIG);
  const lockPath = path.join(cwd, ".maswe", "runs", run.id, ".lock");

  await installLinkLock(lockPath, {
    pid: 1_000_000_099,
    owner: "dead-owner",
    at: new Date(Date.now() - 120_000).toISOString(),
  });

  // Automatic acquire must not reclaim the dead lock.
  const blocked = structuredClone(run);
  blocked.title = "auto-reclaim-forbidden";
  await assert.rejects(store.save(blocked), /stale lock|maswe unlock|lock contention/i);
  assert.equal((await readLockOwner(lockPath)), "dead-owner");

  // Explicit unlock releases legacy ticket zero without deleting its pathname.
  await store.unlock(run.id);
  assert.equal((await readLockOwner(lockPath)), "dead-owner");

  // Replacement writer completes one normal v3 acquisition/release.
  const replacement = structuredClone(await store.load(run.id));
  replacement.title = "replacement-owner";
  await store.save(replacement);
  assert.equal((await store.load(run.id)).title, "replacement-owner");

  // Hold a published v3 claim as the replacement owner during a critical section.
  const hold = await publishLockClaim(
    path.dirname(lockPath),
    "data",
    "store-write",
  );
  await validateClaimOwnership(hold);

  // Two concurrent non-force unlock attempts must not release the live replacement claim.
  const unlockResults = await Promise.allSettled([
    store.unlock(run.id),
    store.unlock(run.id),
  ]);
  assert.equal(unlockResults.filter((r) => r.status === "rejected").length, 2);
  await validateClaimOwnership(hold);

  // Second acquiring owner cannot steal while replacement holds the lock.
  const second = structuredClone(await store.load(run.id));
  second.title = "second-acquirer";
  await assert.rejects(
    store.save(second),
    /lock contention|exclusive lock|live|queued|maswe unlock/i,
  );
  await validateClaimOwnership(hold);
  assert.equal((await store.load(run.id)).title, "replacement-owner");

  await publishClaimRelease(hold);
});

async function readLockOwner(lockPath: string): Promise<string | undefined> {
  try {
    const meta = JSON.parse(await readFile(lockPath, "utf8")) as { owner?: string };
    return meta.owner;
  } catch {
    return undefined;
  }
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("admin lock serializes unlockers against replacement acquire (barrier)", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-lock-admin-"));
  const store = new FileRunStore(cwd, { lockRetries: 20 });
  const run = await store.create("admin", "serialize", DEFAULT_CONFIG);
  const lockPath = path.join(cwd, ".maswe", "runs", run.id, ".lock");

  await installLinkLock(lockPath, {
    pid: 1_000_000_199,
    owner: "stale-owner",
    at: new Date(Date.now() - 180_000).toISOString(),
  });

  const aValidated = deferred();
  const bValidated = deferred();
  const allowARemove = deferred();
  const allowBCleanup = deferred();

  // Unlocker A validates stale lock, then waits before remove.
  const unlockA = store.unlock(run.id, {
    afterValidate: async (meta) => {
      assert.equal(meta?.owner, "stale-owner");
      aValidated.resolve();
      await allowARemove.promise;
    },
  });

  // Unlocker B validates the same stale lock, then waits before cleanup.
  const unlockB = store.unlock(run.id, {
    afterValidate: async (meta) => {
      assert.equal(meta?.owner, "stale-owner");
      bValidated.resolve();
      await allowBCleanup.promise;
    },
  });

  await Promise.all([aValidated.promise, bValidated.promise]);
  assert.equal(await readLockOwner(lockPath), "stale-owner");

  // Unlocker A publishes the exact ticket-zero release.
  allowARemove.resolve();
  await unlockA;
  assert.equal(
    await readLockOwner(lockPath),
    "stale-owner",
    "v3 recovery must not delete the legacy pathname",
  );

  // Writer C publishes the replacement v3 claim and holds it.
  const replacement = await publishLockClaim(
    path.dirname(lockPath),
    "data",
    "store-write",
  );
  await validateClaimOwnership(replacement);

  // Unlocker B's stale observation cannot release C's exact live replacement claim.
  allowBCleanup.resolve();
  await assert.rejects(
    () => unlockB,
    /live pid|lock changed|refusing|incomplete|missing|live owner/i,
  );
  await validateClaimOwnership(replacement);

  // Writer D attempts acquisition while C holds the lock.
  const writerD = structuredClone(await store.load(run.id));
  writerD.title = "writer-d";
  await assert.rejects(
    store.save(writerD),
    /lock contention|exclusive lock|stale lock|maswe unlock|queued/i,
  );
  await validateClaimOwnership(replacement);
  assert.equal((await store.load(run.id)).title, "admin");

  await publishClaimRelease(replacement);
});
