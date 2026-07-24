import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  LockJournalError,
  canonicalClaim,
  journalPaths,
  publishClaimRelease,
  publishLockClaim,
  releaseBasename,
  scanLockJournal,
  validateClaimOwnership,
} from "../src/lock-journal.ts";
import { FileRunStore } from "../src/store.ts";

async function createRun(prefix: string): Promise<{
  cwd: string;
  runDirectory: string;
  store: FileRunStore;
  runId: string;
}> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), prefix));
  const store = new FileRunStore(cwd, { lockRetries: 5 });
  const run = await store.create("recovery", "issue-11", DEFAULT_CONFIG);
  return {
    cwd,
    runDirectory: path.join(cwd, ".maswe", "runs", run.id),
    store,
    runId: run.id,
  };
}

test("unlock-admin owns and releases an administrative-recovery ticket even when admin is empty", async () => {
  const { runDirectory, store, runId } = await createRun("maswe-admin-empty-");
  await store.unlockAdmin(runId);
  const recovery = await scanLockJournal(runDirectory, "admin-recovery");
  assert.equal(recovery.claims.length, 1);
  assert.equal(recovery.releases.size, 1);
});

test("live administrative-recovery owner is never revoked, including with force", async () => {
  const { runDirectory, store, runId } = await createRun("maswe-admin-live-recovery-");
  const live = await publishLockClaim(
    runDirectory,
    "admin-recovery",
    "admin-recovery",
  );
  await validateClaimOwnership(live);

  await assert.rejects(
    store.unlockAdmin(runId, { force: true }),
    (error: unknown) =>
      error instanceof LockJournalError &&
      error.code === "ADMIN_RECOVERY_CONCURRENT",
  );
  const scan = await scanLockJournal(runDirectory, "admin-recovery");
  assert.equal(scan.releases.has(live.claim.ticket), false);
  assert.equal(
    (await readFile(
      path.join(
        journalPaths(runDirectory, "admin-recovery").claims,
        `${live.claim.ticket}.json`,
      ),
      "utf8",
    )).includes(live.owner),
    true,
  );
  await publishClaimRelease(live);
});

test("dead administrative-recovery predecessor requires force and is exact-released", async () => {
  const { runDirectory, store, runId } = await createRun("maswe-admin-dead-recovery-");
  const paths = journalPaths(runDirectory, "admin-recovery");
  await mkdir(paths.claims, { recursive: true });
  const dead = canonicalClaim({
    kind: "admin-recovery",
    ticket: 1n,
    owner: "4bd75a51-2cf0-45f0-b759-f5d4ac458e64",
    pid: 1_000_000_003,
    process: {
      startedAt: "2026-07-24T10:00:00.000Z",
      platformIdentity: null,
    },
    at: "2026-07-24T10:00:01.000Z",
    operation: "admin-recovery",
  });
  await writeFile(path.join(paths.claims, "00000000000000000001.json"), dead.bytes);

  await assert.rejects(
    store.unlockAdmin(runId),
    (error: unknown) =>
      error instanceof LockJournalError && error.code === "LOCK_DEAD_OWNER",
  );
  await store.unlockAdmin(runId, { force: true });
  const scan = await scanLockJournal(runDirectory, "admin-recovery");
  assert.equal(scan.releases.has(dead.record.ticket), true);
  assert.equal(
    (await import("node:fs/promises").then((fs) => fs.readdir(paths.releases))).includes(
      releaseBasename(dead.record),
    ),
    true,
  );
});

test("live admin claim rejects non-force and force publishes only its canonical release", async () => {
  const { runDirectory, store, runId } = await createRun("maswe-admin-live-");
  const admin = await publishLockClaim(runDirectory, "admin", "admin-serialize");
  await validateClaimOwnership(admin);

  await assert.rejects(
    store.unlockAdmin(runId),
    (error: unknown) =>
      error instanceof LockJournalError && error.code === "LOCK_LIVE_OWNER",
  );
  await store.unlockAdmin(runId, { force: true });
  assert.equal(
    (await scanLockJournal(runDirectory, "admin")).releases.has(admin.claim.ticket),
    true,
  );
});

test("incomplete empty legacy recovery marker requires force and is never deleted", async () => {
  const { runDirectory, store, runId } = await createRun("maswe-admin-empty-marker-");
  const marker = path.join(runDirectory, ".admin.lock.recovering");
  await mkdir(marker);

  await assert.rejects(
    store.unlockAdmin(runId),
    (error: unknown) =>
      error instanceof LockJournalError && error.code === "LOCK_CORRUPT",
  );
  await store.unlockAdmin(runId, { force: true });
  assert.equal((await import("node:fs/promises").then((fs) => fs.lstat(marker))).isDirectory(), true);
  const scan = await scanLockJournal(runDirectory, "admin-recovery");
  assert.ok(scan.legacyRelease);
});
