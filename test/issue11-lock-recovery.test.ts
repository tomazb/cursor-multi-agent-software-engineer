import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  acquireDirectoryLock,
  classifyLockPath,
  LockProtocolError,
  removeOwnedDirectory,
  type LockRecordV2,
} from "../src/lock-protocol.ts";
import { FileRunStore } from "../src/store.ts";

const DEAD_PID = 1_000_000_111;

function record(
  owner: string,
  overrides: Partial<LockRecordV2> = {},
): LockRecordV2 {
  return {
    format: 2,
    pid: DEAD_PID,
    owner,
    at: new Date().toISOString(),
    kind: "data",
    recovery: null,
    ...overrides,
  };
}

async function fixture(): Promise<{ root: string; lockPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-issue11-state-"));
  return { root, lockPath: path.join(root, ".lock") };
}

test("classifies absent and empty claimed lock directories", async () => {
  const { lockPath } = await fixture();
  assert.equal((await classifyLockPath(lockPath, "data")).state, "absent");
  await mkdir(lockPath, { mode: 0o700 });
  assert.equal((await classifyLockPath(lockPath, "data")).state, "incomplete-empty");
});

test("classifies temporary publication records as incomplete", async () => {
  const { lockPath } = await fixture();
  await mkdir(lockPath);
  await writeFile(path.join(lockPath, `.record-${randomUUID()}`), '{"format":2', "utf8");
  assert.equal((await classifyLockPath(lockPath, "data")).state, "incomplete-temporary");
});

test("validates the sole UUID entry, owner, kind, pid, and timestamp", async () => {
  const { lockPath } = await fixture();
  const owner = randomUUID();
  await mkdir(lockPath);
  await writeFile(path.join(lockPath, owner), `${JSON.stringify(record(owner))}\n`, "utf8");
  const classified = await classifyLockPath(lockPath, "data");
  assert.equal(classified.state, "valid-dead");
  if (classified.state === "valid-dead") {
    assert.equal(classified.record.owner, owner);
    assert.equal(classified.record.kind, "data");
  }
});

test("rejects filename-owner mismatch and wrong lock kind as corrupt", async () => {
  for (const value of [
    record(randomUUID()),
    record(randomUUID(), { kind: "admin" }),
  ]) {
    const { lockPath } = await fixture();
    const filename = randomUUID();
    await mkdir(lockPath);
    await writeFile(path.join(lockPath, filename), JSON.stringify(value), "utf8");
    assert.equal((await classifyLockPath(lockPath, "data")).state, "corrupt");
  }
});

test("rejects malformed schema and multiple entries as corrupt", async () => {
  const malformedCases: unknown[] = [
    {},
    { ...record(randomUUID()), format: 3 },
    { ...record(randomUUID()), pid: 0 },
    { ...record(randomUUID()), owner: "not-a-uuid" },
    { ...record(randomUUID()), at: "not-a-date" },
  ];
  for (const value of malformedCases) {
    const { lockPath } = await fixture();
    const filename = randomUUID();
    await mkdir(lockPath);
    await writeFile(path.join(lockPath, filename), JSON.stringify(value), "utf8");
    assert.equal((await classifyLockPath(lockPath, "data")).state, "corrupt");
  }

  const { lockPath } = await fixture();
  await mkdir(lockPath);
  await writeFile(path.join(lockPath, randomUUID()), "{}", "utf8");
  await writeFile(path.join(lockPath, randomUUID()), "{}", "utf8");
  assert.equal((await classifyLockPath(lockPath, "data")).state, "multiple");
});

test("does not follow canonical or token symlinks", async () => {
  const canonical = await fixture();
  const canonicalTarget = path.join(canonical.root, "sentinel");
  await writeFile(canonicalTarget, "keep-canonical", "utf8");
  await symlink(canonicalTarget, canonical.lockPath);
  assert.equal((await classifyLockPath(canonical.lockPath, "data")).state, "unsafe");
  assert.equal(await readFile(canonicalTarget, "utf8"), "keep-canonical");

  const child = await fixture();
  const owner = randomUUID();
  const childTarget = path.join(child.root, "token-target");
  const targetContent = JSON.stringify(record(owner));
  await writeFile(childTarget, targetContent, "utf8");
  await mkdir(child.lockPath);
  await symlink(childTarget, path.join(child.lockPath, owner));
  assert.equal((await classifyLockPath(child.lockPath, "data")).state, "unsafe");
  assert.equal(await readFile(childTarget, "utf8"), targetContent);
  assert.equal((await lstat(path.join(child.lockPath, owner))).isSymbolicLink(), true);
});

test("reads PR #10 legacy regular-file locks without writing legacy format", async () => {
  const { lockPath } = await fixture();
  await writeFile(
    lockPath,
    `${JSON.stringify({
      pid: DEAD_PID,
      owner: "legacy-dead-owner",
      at: new Date().toISOString(),
    })}\n`,
    "utf8",
  );
  const classified = await classifyLockPath(lockPath, "data");
  assert.equal(classified.state, "legacy-dead");
});

test("acquisition claims with mkdir and returns ownership only after token validation", async () => {
  const { lockPath } = await fixture();
  const transitions: string[] = [];
  const handle = await acquireDirectoryLock(lockPath, "data", {
    transition: async (transition) => {
      transitions.push(transition);
    },
  });
  assert.match(handle.owner, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(transitions, [
    "DIRECTORY_CLAIMED",
    "TEMP_RECORD_CREATED",
    "RECORD_PARTIALLY_WRITTEN",
    "RECORD_SYNCED",
    "TOKEN_PUBLISHED",
    "OWNERSHIP_VALIDATED",
  ]);
  const classified = await classifyLockPath(lockPath, "data");
  assert.equal(classified.state, "valid-live");
  if (classified.state === "valid-live") assert.equal(classified.record.owner, handle.owner);
  await removeOwnedDirectory(handle);
  assert.equal((await classifyLockPath(lockPath, "data")).state, "absent");
});

test("acquisition never overwrites an existing empty directory", async () => {
  const { lockPath } = await fixture();
  await mkdir(lockPath);
  const before = await lstat(lockPath, { bigint: true });
  await assert.rejects(
    acquireDirectoryLock(lockPath, "data"),
    (error: unknown) =>
      error instanceof LockProtocolError && error.code === "LOCK_INCOMPLETE",
  );
  const after = await lstat(lockPath, { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.deepEqual(await import("node:fs/promises").then((fs) => fs.readdir(lockPath)), []);
});

test("old owner release cannot remove a fully published replacement directory", async () => {
  const { lockPath } = await fixture();
  const oldOwner = await acquireDirectoryLock(lockPath, "data");
  await import("node:fs/promises").then(async (fs) => {
    await fs.unlink(path.join(lockPath, oldOwner.owner));
    await fs.rmdir(lockPath);
  });
  const replacement = await acquireDirectoryLock(lockPath, "data");

  await assert.rejects(
    removeOwnedDirectory(oldOwner),
    (error: unknown) =>
      error instanceof LockProtocolError && error.code === "LOCK_OWNERSHIP_LOST",
  );
  const classified = await classifyLockPath(lockPath, "data");
  assert.equal(classified.state, "valid-live");
  if (classified.state === "valid-live") {
    assert.equal(classified.record.owner, replacement.owner);
  }
  await removeOwnedDirectory(replacement);
});

test("release surfaces cleanup failure and never recursively deletes a second entry", async () => {
  const { lockPath } = await fixture();
  const handle = await acquireDirectoryLock(lockPath, "data");
  const second = randomUUID();
  await writeFile(path.join(lockPath, second), "sentinel", "utf8");
  await assert.rejects(
    removeOwnedDirectory(handle),
    (error: unknown) =>
      error instanceof LockProtocolError && error.code === "LOCK_OWNERSHIP_LOST",
  );
  assert.equal(await readFile(path.join(lockPath, second), "utf8"), "sentinel");
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("a live administrative recovery marker is never revoked even with force", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-issue11-marker-live-"));
  const store = new FileRunStore(root, { lockRetries: 4 });
  const run = await store.create("marker", "live", DEFAULT_CONFIG);
  const adminPath = path.join(root, ".maswe", "runs", run.id, ".admin.lock");
  await writeFile(
    adminPath,
    `${JSON.stringify({
      pid: DEAD_PID,
      owner: "legacy-dead-admin",
      at: new Date().toISOString(),
    })}\n`,
    "utf8",
  );

  const entered = deferred();
  const release = deferred();
  const winner = store.unlockAdmin(run.id, {
    afterObserve: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  await entered.promise;

  await assert.rejects(
    store.unlockAdmin(run.id, { force: true }),
    (error: unknown) =>
      error instanceof LockProtocolError &&
      error.code === "ADMIN_RECOVERY_CONCURRENT",
  );
  release.resolve();
  await winner;
  assert.equal((await classifyLockPath(adminPath, "admin")).state, "absent");
});

test("two forced actors recovering a dead marker produce one recovery owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-issue11-marker-dead-"));
  const store = new FileRunStore(root, { lockRetries: 12 });
  const run = await store.create("marker", "dead", DEFAULT_CONFIG);
  const runDirectory = path.join(root, ".maswe", "runs", run.id);
  const markerPath = path.join(runDirectory, ".admin.lock.recovering");
  const deadOwner = randomUUID();
  await mkdir(markerPath);
  await writeFile(
    path.join(markerPath, deadOwner),
    `${JSON.stringify(record(deadOwner, {
      kind: "admin-recovery",
      recovery: { mode: "admin-unlock", force: true },
    }))}\n`,
    "utf8",
  );

  const entered = deferred();
  const release = deferred();
  let entryCount = 0;
  const recover = () =>
    store.unlockAdmin(run.id, {
      force: true,
      afterObserve: async () => {
        entryCount += 1;
        entered.resolve();
        await release.promise;
      },
    });
  const settle = (promise: Promise<void>) =>
    promise.then(
      () => ({ status: "fulfilled" as const }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
  const a = settle(recover());
  const b = settle(recover());
  await entered.promise;

  const firstFinished = await Promise.race([a, b]);
  assert.equal(firstFinished.status, "rejected");
  if (firstFinished.status === "rejected") {
    assert.ok(firstFinished.reason instanceof LockProtocolError);
    assert.equal(firstFinished.reason.code, "ADMIN_RECOVERY_CONCURRENT");
  }
  assert.equal(entryCount, 1);

  release.resolve();
  const results = await Promise.all([a, b]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await classifyLockPath(markerPath, "admin-recovery")).state, "absent");
});
