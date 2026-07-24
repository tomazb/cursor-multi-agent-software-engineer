import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { access, chmod, mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { FileRunStore } from "../src/store.ts";
import { journalPaths, scanLockJournal } from "../src/lock-journal.ts";

const storeWriterWorker = fileURLToPath(
  new URL("./fixtures/store-writer-worker.ts", import.meta.url),
);

test("normal store acquisition and release use immutable v3 claims and releases", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-v3-store-"));
  const store = new FileRunStore(cwd);
  const run = await store.create("v3", "journal", DEFAULT_CONFIG);
  const runDirectory = path.join(cwd, ".maswe", "runs", run.id);

  await assert.rejects(access(path.join(runDirectory, ".lock")), /ENOENT/);
  await assert.rejects(access(path.join(runDirectory, ".admin.lock")), /ENOENT/);

  const data = await scanLockJournal(runDirectory, "data");
  assert.equal(data.claims.length, 1);
  assert.equal(data.releases.size, 1);
  const admin = await scanLockJournal(runDirectory, "admin");
  assert.equal(admin.claims.length, 2);
  assert.equal(admin.releases.size, 2);
  assert.equal(
    (await readFile(
      path.join(
        journalPaths(runDirectory, "data").claims,
        "00000000000000000001.json",
      ),
      "utf8",
    )).includes('"format":3'),
    true,
  );
});

test("protected-work and exact-release failures are both preserved", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-v3-dual-failure-"));
  const store = new FileRunStore(cwd);
  const run = await store.create("dual", "failure", DEFAULT_CONFIG);
  const runDirectory = path.join(cwd, ".maswe", "runs", run.id);
  const primary = new Error("protected work failed");

  await assert.rejects(
    store.withAdminLockForTest(run.id, async () => {
      const scan = await scanLockJournal(runDirectory, "admin");
      const owned = scan.claims.at(-1)!;
      const claimPath = path.join(
        journalPaths(runDirectory, "admin").claims,
        `${owned.ticket}.json`,
      );
      await chmod(claimPath, 0o600);
      await writeFile(
        claimPath,
        "{corrupted-before-release",
      );
      throw primary;
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.equal(error.errors[0], primary);
      assert.match(String(error.errors[1]), /corrupt/i);
      return true;
    },
  );
});

test("exclusive lock blocks simultaneous multi-process writers", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-lock-"));
  const store = new FileRunStore(cwd);
  const run = await store.create("lock", "race", DEFAULT_CONFIG);
  const lockPath = path.join(cwd, ".maswe", "runs", run.id, ".lock");

  // Hold an exclusive lock in this process, then spawn a sibling that must fail or wait.
  const { open } = await import("node:fs/promises");
  const holder = await open(lockPath, "wx");
  await holder.writeFile(
    `${JSON.stringify({
      pid: process.pid,
      owner: "holder-token",
      at: new Date().toISOString(),
    })}\n`,
    "utf8",
  );

  const child = fork(storeWriterWorker, [], {
    cwd,
    execArgv: ["--experimental-strip-types"],
    env: {
      ...process.env,
      MASWE_STORE_CWD: cwd,
      MASWE_STORE_RUN_ID: run.id,
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const nextMessage = () =>
    new Promise<Record<string, unknown>>((resolve) => child.once("message", resolve));
  assert.equal((await nextMessage()).type, "READY");
  child.send({ type: "CONTINUE" });
  const result = await nextMessage();
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));

  await holder.close();
  await import("node:fs/promises").then((fs) => fs.rm(lockPath, { force: true }));

  assert.equal(result.result, "ERROR", "child must not save while legacy ticket zero is live");
  assert.match(String(result.message), /lock|queued|contention|maswe unlock/i);
  const loaded = await store.load(run.id);
  assert.notEqual(loaded.title, "child-writer");
});

test("stale lock from dead pid requires explicit unlock", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-stale-"));
  const store = new FileRunStore(cwd, { lockRetries: 4 });
  const run = await store.create("stale", "lock", DEFAULT_CONFIG);
  const lockPath = path.join(cwd, ".maswe", "runs", run.id, ".lock");
  await writeFile(
    lockPath,
    `${JSON.stringify({
      pid: 1_000_000_001,
      owner: "dead-stale-owner",
      at: new Date(Date.now() - 60_000).toISOString(),
    })}\n`,
    "utf8",
  );
  run.title = "blocked";
  await assert.rejects(store.save(run), /stale lock|maswe unlock|lock contention|queued/i);
  await store.unlock(run.id);
  run.title = "reclaimed";
  await store.save(run);
  const loaded = await store.load(run.id);
  assert.equal(loaded.title, "reclaimed");
});

test("concurrent writeArtifact under lock yields unique attempts and valid digests", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-art-"));
  const store = new FileRunStore(cwd);
  const run = await store.create("arts", "concurrent", DEFAULT_CONFIG);

  const writers = Array.from({ length: 8 }, (_, index) =>
    (async () => {
      const latest = await store.load(run.id);
      return store.writeArtifact(latest, "note.md", `content-${index}-${Date.now()}`);
    })(),
  );
  const results = await Promise.allSettled(writers);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  assert.ok(
    fulfilled.length >= 1,
    results
      .map((result) =>
        result.status === "rejected"
          ? result.reason instanceof Error
            ? `${result.reason.name}: ${result.reason.message}`
            : String(result.reason)
          : "fulfilled",
      )
      .join("\n"),
  );

  const final = await store.load(run.id);
  const notes = final.artifacts.filter((a) => a.logicalName === "note.md");
  const attempts = new Set(notes.map((a) => a.attempt));
  assert.equal(attempts.size, notes.length, "attempt numbers must be unique");
  for (const artifact of notes) {
    const content = await store.readArtifact(final, artifact.name === "note.md" ? "note.md" : artifact.name);
    assert.ok(content !== undefined);
    const absolute = path.join(cwd, artifact.path);
    const bytes = await readFile(absolute, "utf8");
    const { createHash } = await import("node:crypto");
    assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
  }
});
