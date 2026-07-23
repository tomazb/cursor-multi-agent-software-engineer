import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  acquireDirectoryLock,
  classifyLockPath,
  recoverClassifiedLock,
  removeOwnedDirectory,
  type LockOwnershipHandle,
} from "../src/lock-protocol.ts";
import { FileRunStore } from "../src/store.ts";

const workerPath = fileURLToPath(new URL("./fixtures/lock-worker.ts", import.meta.url));
const DEAD_PID = 1_000_000_313;

interface WorkerMessage {
  type: "ready" | "transition" | "owned" | "result";
  actor: string;
  transition?: string;
  token?: string;
  result?: "ok" | "error";
  code?: string;
  error?: string;
}

interface Worker {
  child: ChildProcess;
  messages: WorkerMessage[];
  waitFor: (predicate: (message: WorkerMessage) => boolean) => Promise<WorkerMessage>;
  send: (message: Record<string, unknown>) => void;
  close: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function spawnWorker(): Worker {
  const child = fork(workerPath, [], {
    execArgv: ["--experimental-strip-types"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const messages: WorkerMessage[] = [];
  const pending = new Set<{
    predicate: (message: WorkerMessage) => boolean;
    resolve: (message: WorkerMessage) => void;
    timer: NodeJS.Timeout;
  }>();
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  child.on("message", (value: WorkerMessage) => {
    messages.push(value);
    for (const waiter of pending) {
      if (!waiter.predicate(value)) continue;
      clearTimeout(waiter.timer);
      pending.delete(waiter);
      waiter.resolve(value);
    }
  });
  const close = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on("close", (code, signal) => {
        for (const waiter of pending) clearTimeout(waiter.timer);
        pending.clear();
        resolve({ code, signal });
      });
    },
  );
  return {
    child,
    messages,
    waitFor(predicate) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          timer: setTimeout(() => {
            pending.delete(waiter);
            reject(new Error(`Worker barrier timed out; stderr=${stderr}`));
          }, 10_000),
        };
        pending.add(waiter);
      });
    },
    send(message) {
      child.send(message);
    },
    close,
  };
}

async function readyWorker(): Promise<Worker> {
  const worker = spawnWorker();
  await worker.waitFor((message) => message.type === "ready");
  return worker;
}

function serializeOwnership(ownership: LockOwnershipHandle) {
  return {
    lockPath: ownership.lockPath,
    kind: ownership.kind,
    owner: ownership.owner,
    directoryIdentity: {
      dev: ownership.directoryIdentity.dev.toString(),
      ino: ownership.directoryIdentity.ino.toString(),
    },
  };
}

async function runExclusiveMkdirRace(iteration: number): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), `maswe-issue11-mkdir-${iteration}-`));
  const lockPath = path.join(root, ".lock");
  const a = await readyWorker();
  const b = await readyWorker();
  a.send({ action: "acquire", actor: "A", lockPath, kind: "data" });
  b.send({ action: "acquire", actor: "B", lockPath, kind: "data" });

  const ownerMessage = await Promise.race([
    a.waitFor((message) => message.type === "owned"),
    b.waitFor((message) => message.type === "owned"),
  ]);
  const winner = ownerMessage.actor === "A" ? a : b;
  const loser = winner === a ? b : a;
  const loserResult = await loser.waitFor((message) => message.type === "result");
  assert.equal(loserResult.result, "error");
  assert.ok(
    ["LOCK_LIVE_OWNER", "LOCK_INCOMPLETE", "LOCK_OWNERSHIP_LOST"].includes(
      loserResult.code ?? "",
    ),
  );
  assert.equal(
    a.messages.filter((message) => message.type === "owned").length +
      b.messages.filter((message) => message.type === "owned").length,
    1,
  );

  winner.send({ action: "continue", transition: "RELEASE" });
  assert.deepEqual((await Promise.all([a.close, b.close])).map((value) => value.code).sort(), [0, 2]);
  assert.equal((await classifyLockPath(lockPath, "data")).state, "absent");
}

test("real child processes race exclusive mkdir with exactly one validated owner", async () => {
  const iterations = Number(process.env.MASWE_ISSUE11_CONTENTION_ITERATIONS ?? "1");
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    await runExclusiveMkdirRace(iteration);
  }
});

for (const transition of [
  "DIRECTORY_CLAIMED",
  "RECORD_PARTIALLY_WRITTEN",
  "RECORD_SYNCED",
] as const) {
  test(`child crash at ${transition} leaves a classified incomplete lock`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "maswe-issue11-crash-"));
    const lockPath = path.join(root, ".lock");
    const worker = await readyWorker();
    worker.send({
      action: "acquire",
      actor: "crasher",
      lockPath,
      kind: "data",
      pauseAt: [transition],
    });
    await worker.waitFor(
      (message) => message.type === "transition" && message.transition === transition,
    );
    worker.child.kill("SIGKILL");
    await worker.close;
    const classified = await classifyLockPath(lockPath, "data");
    assert.equal(
      classified.state,
      transition === "DIRECTORY_CLAIMED"
        ? "incomplete-empty"
        : "incomplete-temporary",
    );
  });
}

async function runReleaseReplacementRace(iteration: number): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), `maswe-issue11-replace-${iteration}-`));
  const lockPath = path.join(root, ".lock");
  const oldOwner = await acquireDirectoryLock(lockPath, "data");
  const oldRelease = await readyWorker();
  oldRelease.send({
    action: "release",
    actor: "old-owner",
    ownership: serializeOwnership(oldOwner),
    pauseAt: ["OWNER_VALIDATED"],
  });
  await oldRelease.waitFor(
    (message) =>
      message.type === "transition" && message.transition === "OWNER_VALIDATED",
  );

  const observed = await classifyLockPath(lockPath, "data");
  await recoverClassifiedLock(observed, { force: true });
  const replacement = await acquireDirectoryLock(lockPath, "data");
  oldRelease.send({ action: "continue", transition: "OWNER_VALIDATED" });
  const result = await oldRelease.waitFor((message) => message.type === "result");
  assert.equal(result.code, "LOCK_OWNERSHIP_LOST");
  await oldRelease.close;

  const surviving = await classifyLockPath(lockPath, "data");
  assert.equal(surviving.state, "valid-live");
  if (surviving.state === "valid-live") {
    assert.equal(surviving.record.owner, replacement.owner);
  }
  await removeOwnedDirectory(replacement);
}

test("old-owner forced-replacement race preserves replacement", async () => {
  const iterations = Number(process.env.MASWE_ISSUE11_REPLACEMENT_ITERATIONS ?? "1");
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    await runReleaseReplacementRace(iteration);
  }
});

test("acquisition does not overwrite the old-owner empty-directory release window", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-issue11-empty-window-"));
  const lockPath = path.join(root, ".lock");
  const owner = await acquireDirectoryLock(lockPath, "data");
  const release = await readyWorker();
  release.send({
    action: "release",
    actor: "old-owner",
    ownership: serializeOwnership(owner),
    pauseAt: ["TOKEN_REMOVED"],
  });
  await release.waitFor(
    (message) =>
      message.type === "transition" && message.transition === "TOKEN_REMOVED",
  );
  const empty = await classifyLockPath(lockPath, "data");
  assert.equal(empty.state, "incomplete-empty");
  await assert.rejects(
    acquireDirectoryLock(lockPath, "data"),
    /incomplete|fail closed/i,
  );
  release.send({ action: "continue", transition: "TOKEN_REMOVED" });
  assert.equal((await release.close).code, 0);
  const replacement = await acquireDirectoryLock(lockPath, "data");
  await removeOwnedDirectory(replacement);
});

test("claimant losing its empty directory cannot publish into a replacement", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-issue11-claim-loss-"));
  const lockPath = path.join(root, ".lock");
  const claimant = await readyWorker();
  claimant.send({
    action: "acquire",
    actor: "claimant",
    lockPath,
    kind: "data",
    pauseAt: ["DIRECTORY_CLAIMED"],
  });
  await claimant.waitFor(
    (message) =>
      message.type === "transition" && message.transition === "DIRECTORY_CLAIMED",
  );
  await rmdir(lockPath);
  const replacement = await acquireDirectoryLock(lockPath, "data");
  claimant.send({ action: "continue", transition: "DIRECTORY_CLAIMED" });
  const result = await claimant.waitFor((message) => message.type === "result");
  assert.equal(result.code, "LOCK_OWNERSHIP_LOST");
  await claimant.close;
  const surviving = await classifyLockPath(lockPath, "data");
  assert.equal(surviving.state, "valid-live");
  if (surviving.state === "valid-live") {
    assert.equal(surviving.record.owner, replacement.owner);
  }
  await removeOwnedDirectory(replacement);
});

async function runRecoveryMarkerRace(initial: "dead" | "empty"): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), `maswe-issue11-recovery-${initial}-`));
  const store = new FileRunStore(root);
  const run = await store.create("recovery", initial, DEFAULT_CONFIG);
  const markerPath = path.join(
    root,
    ".maswe",
    "runs",
    run.id,
    ".admin.lock.recovering",
  );
  await mkdir(markerPath);
  if (initial === "dead") {
    const owner = randomUUID();
    await writeFile(
      path.join(markerPath, owner),
      `${JSON.stringify({
        format: 2,
        pid: DEAD_PID,
        owner,
        at: new Date().toISOString(),
        kind: "admin-recovery",
        recovery: { mode: "admin-unlock", force: true },
      })}\n`,
      "utf8",
    );
  }

  const a = await readyWorker();
  const b = await readyWorker();
  a.send({
    action: "recover-admin",
    actor: "A",
    cwd: root,
    runId: run.id,
    force: true,
    pauseOnEntry: true,
  });
  b.send({
    action: "recover-admin",
    actor: "B",
    cwd: root,
    runId: run.id,
    force: true,
    pauseOnEntry: true,
  });
  const entered = await Promise.race([
    a.waitFor(
      (message) =>
        message.type === "transition" && message.transition === "RECOVERY_ENTERED",
    ),
    b.waitFor(
      (message) =>
        message.type === "transition" && message.transition === "RECOVERY_ENTERED",
    ),
  ]);
  const winner = entered.actor === "A" ? a : b;
  const loser = winner === a ? b : a;
  const loserResult = await loser.waitFor((message) => message.type === "result");
  const enteredCount =
    a.messages.filter((message) => message.transition === "RECOVERY_ENTERED").length +
    b.messages.filter((message) => message.transition === "RECOVERY_ENTERED").length;
  winner.send({ action: "continue", transition: "RECOVERY_ENTERED" });
  await Promise.all([a.close, b.close]);
  assert.equal(
    loserResult.code,
    "ADMIN_RECOVERY_CONCURRENT",
    JSON.stringify(loserResult),
  );
  assert.equal(enteredCount, 1);
  assert.equal((await classifyLockPath(markerPath, "admin-recovery")).state, "absent");
}

test("two real children recovering a dead recovery marker enter exactly once", async () => {
  await runRecoveryMarkerRace("dead");
});

test("two real children recovering an empty recovery marker enter exactly once", async () => {
  await runRecoveryMarkerRace("empty");
});
