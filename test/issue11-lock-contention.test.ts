import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  canonicalClaim,
  initializeLockJournal,
  journalPaths,
  recoverCurrentLock,
  scanLockJournal,
} from "../src/lock-journal.ts";
import { FileRunStore } from "../src/store.ts";

const workerPath = fileURLToPath(
  new URL("./fixtures/lock-journal-worker.ts", import.meta.url),
);
const unlockAdminWorkerPath = fileURLToPath(
  new URL("./fixtures/unlock-admin-worker.ts", import.meta.url),
);
const WATCHDOG_MS = 10_000;

interface WorkerMessage {
  type: "EVENT" | "RESULT";
  actor: string;
  pid: number;
  event?: string;
  result?: string;
  kind: string;
  ticket?: string;
  owner?: string;
  claimDigest?: string;
  code?: string;
  message?: string;
  requestId?: string;
  command?: string;
}

interface Worker {
  child: ChildProcess;
  next(predicate: (message: WorkerMessage) => boolean): Promise<WorkerMessage>;
  continue(event: string): void;
  command(
    command: "VALIDATE" | "RELEASE" | "RECOVER" | "EXIT",
    options?: { force?: boolean },
  ): Promise<WorkerMessage>;
}

async function freshRunDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const runDirectory = path.join(root, "run");
  await mkdir(runDirectory);
  return runDirectory;
}

function spawnWorker(
  runDirectory: string,
  actor: string,
  pauseEvents: string[],
  options: {
    kind?: "data" | "admin" | "admin-recovery";
    operation?: "store-write" | "admin-serialize" | "admin-recovery";
    mode?: "publish" | "session" | "recovery";
  } = {},
): Worker {
  const child = fork(workerPath, [], {
    execArgv: ["--experimental-strip-types"],
    env: {
      ...process.env,
      MASWE_LOCK_RUN_DIRECTORY: runDirectory,
      MASWE_LOCK_ACTOR: actor,
      MASWE_LOCK_KIND: options.kind ?? "data",
      MASWE_LOCK_OPERATION: options.operation ?? "store-write",
      MASWE_LOCK_MODE: options.mode ?? "publish",
      MASWE_LOCK_PAUSE_EVENTS: pauseEvents.join(","),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const messages: WorkerMessage[] = [];
  const waiters: Array<{
    predicate: (message: WorkerMessage) => boolean;
    resolve: (message: WorkerMessage) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  let requestSequence = 0;

  child.on("message", (message: WorkerMessage) => {
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter!.timer);
      waiter!.resolve(message);
    } else {
      messages.push(message);
    }
  });
  child.on("exit", (code, signal) => {
    if (code === 0) return;
    const error = new Error(`worker ${actor} exited ${code ?? signal}`);
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  });

  return {
    child,
    next(predicate) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]!);
      return new Promise<WorkerMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          const waiterIndex = waiters.findIndex((waiter) => waiter.resolve === resolve);
          if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
          reject(new Error(`worker ${actor} watchdog expired`));
        }, WATCHDOG_MS);
        waiters.push({ predicate, resolve, reject, timer });
      });
    },
    continue(event) {
      child.send({ type: "CONTINUE", event });
    },
    command(command, commandOptions = {}) {
      requestSequence += 1;
      const requestId = `${actor}-${requestSequence}`;
      child.send({
        type: "COMMAND",
        command,
        requestId,
        ...commandOptions,
      });
      return this.next(
        (message) =>
          message.type === "RESULT" && message.requestId === requestId,
      );
    },
  };
}

async function event(
  worker: Pick<Worker, "next">,
  name: string,
): Promise<WorkerMessage> {
  return worker.next((message) => message.type === "EVENT" && message.event === name);
}

async function result(worker: Pick<Worker, "next">): Promise<WorkerMessage> {
  return worker.next((message) => message.type === "RESULT");
}

async function stopWorker(worker: Worker): Promise<void> {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
  const response = await worker.command("EXIT");
  assert.equal(response.result, "OK");
}

function spawnUnlockAdminWorker(
  cwd: string,
  runId: string,
  actor: string,
  pauseEvents: string[],
  force: boolean,
): Pick<Worker, "child" | "next" | "continue"> {
  const child = fork(unlockAdminWorkerPath, [], {
    execArgv: ["--experimental-strip-types"],
    env: {
      ...process.env,
      MASWE_STORE_CWD: cwd,
      MASWE_STORE_RUN_ID: runId,
      MASWE_LOCK_ACTOR: actor,
      MASWE_LOCK_PAUSE_EVENTS: pauseEvents.join(","),
      MASWE_UNLOCK_FORCE: force ? "1" : "0",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const messages: WorkerMessage[] = [];
  const waiters: Array<{
    predicate: (message: WorkerMessage) => boolean;
    resolve: (message: WorkerMessage) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  child.on("message", (message: WorkerMessage) => {
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter!.timer);
      waiter!.resolve(message);
    } else {
      messages.push(message);
    }
  });
  child.on("exit", (code, signal) => {
    if (code === 0) return;
    const error = new Error(`unlock worker ${actor} exited ${code ?? signal}`);
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  });
  return {
    child,
    next(predicate) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]!);
      return new Promise<WorkerMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          const waiterIndex = waiters.findIndex((waiter) => waiter.resolve === resolve);
          if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
          reject(new Error(`unlock worker ${actor} watchdog expired`));
        }, WATCHDOG_MS);
        waiters.push({ predicate, resolve, reject, timer });
      });
    },
    continue(event) {
      child.send({ type: "CONTINUE", event });
    },
  };
}

async function createStoreRun(prefix: string): Promise<{
  cwd: string;
  runId: string;
  runDirectory: string;
}> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), prefix));
  const run = await new FileRunStore(cwd, { lockRetries: 5 }).create(
    "recovery",
    "issue-11",
    DEFAULT_CONFIG,
  );
  return {
    cwd,
    runId: run.id,
    runDirectory: path.join(cwd, ".maswe", "runs", run.id),
  };
}

test("real processes conflict on one proposed ticket and publish contiguous successors", async () => {
  const runDirectory = await freshRunDirectory("maswe-ticket-process-");
  const left = spawnWorker(runDirectory, "left", [
    "CLAIM_TICKET_PROPOSED",
    "CLAIM_LINK_ATTEMPT_READY",
  ]);
  const right = spawnWorker(runDirectory, "right", [
    "CLAIM_TICKET_PROPOSED",
    "CLAIM_LINK_ATTEMPT_READY",
  ]);

  const firstProposals = await Promise.all([
    event(left, "CLAIM_TICKET_PROPOSED"),
    event(right, "CLAIM_TICKET_PROPOSED"),
  ]);
  assert.deepEqual(firstProposals.map((message) => message.ticket), [
    "00000000000000000001",
    "00000000000000000001",
  ]);
  left.continue("CLAIM_TICKET_PROPOSED");
  right.continue("CLAIM_TICKET_PROPOSED");

  await Promise.all([
    event(left, "CLAIM_LINK_ATTEMPT_READY"),
    event(right, "CLAIM_LINK_ATTEMPT_READY"),
  ]);
  left.continue("CLAIM_LINK_ATTEMPT_READY");
  right.continue("CLAIM_LINK_ATTEMPT_READY");

  const leftResult = result(left);
  const rightResult = result(right);
  const firstResult = await Promise.race([leftResult, rightResult]);
  assert.equal(firstResult.result, "PUBLISHED");
  const loser = firstResult.actor === "left" ? right : left;
  const loserResult = firstResult.actor === "left" ? rightResult : leftResult;
  const secondProposal = await event(loser, "CLAIM_TICKET_PROPOSED");
  assert.equal(secondProposal.ticket, "00000000000000000002");
  loser.continue("CLAIM_TICKET_PROPOSED");
  await event(loser, "CLAIM_LINK_ATTEMPT_READY");
  loser.continue("CLAIM_LINK_ATTEMPT_READY");
  assert.equal((await loserResult).result, "PUBLISHED");

  const scan = await scanLockJournal(runDirectory, "data");
  assert.deepEqual(scan.claims.map((claim) => claim.ticket), [
    "00000000000000000001",
    "00000000000000000002",
  ]);
});

test("crash before temporary creation leaves no claim or temporary record", async () => {
  const runDirectory = await freshRunDirectory("maswe-ticket-crash-pre-temp-");
  const worker = spawnWorker(runDirectory, "crash-pre-temp", ["CLAIM_TICKET_PROPOSED"]);
  await event(worker, "CLAIM_TICKET_PROPOSED");
  worker.child.kill("SIGKILL");
  await new Promise<void>((resolve) => worker.child.once("exit", () => resolve()));

  const scan = await scanLockJournal(runDirectory, "data");
  assert.equal(scan.claims.length, 0);
  assert.deepEqual(await readdir(journalPaths(runDirectory, "data").tmp), []);
});

test("crash during temporary claim write leaves no published claim", async () => {
  const runDirectory = await freshRunDirectory("maswe-ticket-crash-partial-");
  const worker = spawnWorker(runDirectory, "crash-partial", [
    "CLAIM_PARTIALLY_WRITTEN",
  ]);
  await event(worker, "CLAIM_PARTIALLY_WRITTEN");
  worker.child.kill("SIGKILL");
  await new Promise<void>((resolve) => worker.child.once("exit", () => resolve()));

  const scan = await scanLockJournal(runDirectory, "data");
  assert.equal(scan.claims.length, 0);
  assert.equal((await readdir(journalPaths(runDirectory, "data").tmp)).length, 1);
});

test("crash after close but before link leaves no published claim", async () => {
  const runDirectory = await freshRunDirectory("maswe-ticket-crash-before-");
  const worker = spawnWorker(runDirectory, "crash-before", ["CLAIM_LINK_ATTEMPT_READY"]);
  await event(worker, "CLAIM_LINK_ATTEMPT_READY");
  worker.child.kill("SIGKILL");
  await new Promise<void>((resolve) => worker.child.once("exit", () => resolve()));

  const scan = await scanLockJournal(runDirectory, "data");
  assert.equal(scan.claims.length, 0);
  assert.equal((await readdir(journalPaths(runDirectory, "data").tmp)).length, 1);
});

test("crash after release publication is idempotently complete", async () => {
  const runDirectory = await freshRunDirectory("maswe-release-crash-after-");
  const owner = spawnWorker(
    runDirectory,
    "release-crash",
    ["RELEASE_PUBLISHED"],
    { mode: "session" },
  );
  await event(owner, "WORKER_READY");
  const releaseResult = owner.command("RELEASE");
  await event(owner, "RELEASE_PUBLISHED");
  owner.child.kill("SIGKILL");
  await new Promise<void>((resolve) => owner.child.once("exit", () => resolve()));
  await assert.rejects(releaseResult);

  const scan = await scanLockJournal(runDirectory, "data");
  assert.equal(scan.claims.length, 1);
  assert.equal(scan.releases.size, 1);
  await recoverCurrentLock(runDirectory, "data", { force: true });
  assert.equal((await scanLockJournal(runDirectory, "data")).releases.size, 1);
});

test("exact-range checks order real-process owners without timing sleeps", async () => {
  const runDirectory = await freshRunDirectory("maswe-owner-order-process-");
  const first = spawnWorker(runDirectory, "first-owner", [], { mode: "session" });
  await event(first, "WORKER_READY");
  const second = spawnWorker(runDirectory, "second-owner", [], { mode: "session" });
  await event(second, "WORKER_READY");

  const queued = await second.command("VALIDATE");
  assert.equal(queued.result, "ERROR");
  assert.equal(queued.code, "LOCK_QUEUED");
  assert.equal((await first.command("VALIDATE")).result, "OK");
  assert.equal((await first.command("RELEASE")).result, "OK");
  assert.equal((await second.command("VALIDATE")).result, "OK");

  await Promise.all([stopWorker(first), stopWorker(second)]);
});

test("three real-process claimants enter strictly in ticket order", async () => {
  const runDirectory = await freshRunDirectory("maswe-owner-three-process-");
  const workers: Worker[] = [];
  for (const actor of ["owner-one", "owner-two", "owner-three"]) {
    const worker = spawnWorker(runDirectory, actor, [], { mode: "session" });
    await event(worker, "WORKER_READY");
    workers.push(worker);
  }

  assert.equal((await workers[0]!.command("VALIDATE")).result, "OK");
  for (const worker of workers.slice(1)) {
    const queued = await worker.command("VALIDATE");
    assert.equal(queued.result, "ERROR");
    assert.equal(queued.code, "LOCK_QUEUED");
  }
  assert.equal((await workers[0]!.command("RELEASE")).result, "OK");
  assert.equal((await workers[1]!.command("VALIDATE")).result, "OK");
  assert.equal((await workers[2]!.command("VALIDATE")).code, "LOCK_QUEUED");
  assert.equal((await workers[1]!.command("RELEASE")).result, "OK");
  assert.equal((await workers[2]!.command("VALIDATE")).result, "OK");
  await Promise.all(workers.map(stopWorker));
});

test("two real recoverers converge on one exact dead-claim release", async () => {
  const runDirectory = await freshRunDirectory("maswe-recover-process-");
  const paths = journalPaths(runDirectory, "data");
  await initializeLockJournal(runDirectory);
  const dead = canonicalClaim({
    kind: "data",
    ticket: 1n,
    owner: "6fd6b8c7-3c46-4329-a430-e1d64c75f599",
    pid: 1_000_000_011,
    process: {
      startedAt: "2026-07-24T10:00:00.000Z",
      platformIdentity: null,
    },
    at: "2026-07-24T10:00:01.000Z",
    operation: "store-write",
  });
  await writeFile(path.join(paths.claims, "00000000000000000001.json"), dead.bytes);
  const left = spawnWorker(
    runDirectory,
    "left-recoverer",
    ["RELEASE_LINK_ATTEMPT_READY"],
    { mode: "recovery" },
  );
  const right = spawnWorker(
    runDirectory,
    "right-recoverer",
    ["RELEASE_LINK_ATTEMPT_READY"],
    { mode: "recovery" },
  );
  await Promise.all([event(left, "WORKER_READY"), event(right, "WORKER_READY")]);

  const leftResult = left.command("RECOVER", { force: false });
  const rightResult = right.command("RECOVER", { force: false });
  await Promise.all([
    event(left, "RELEASE_LINK_ATTEMPT_READY"),
    event(right, "RELEASE_LINK_ATTEMPT_READY"),
  ]);
  left.continue("RELEASE_LINK_ATTEMPT_READY");
  right.continue("RELEASE_LINK_ATTEMPT_READY");
  assert.equal((await leftResult).result, "OK");
  assert.equal((await rightResult).result, "OK");
  assert.equal((await scanLockJournal(runDirectory, "data")).releases.size, 1);

  await Promise.all([stopWorker(left), stopWorker(right)]);
});

test("two real administrative-recovery claimants admit exactly one owner", async () => {
  const runDirectory = await freshRunDirectory("maswe-admin-recovery-process-");
  const first = spawnWorker(runDirectory, "first-recoverer", [], {
    kind: "admin-recovery",
    operation: "admin-recovery",
    mode: "session",
  });
  await event(first, "WORKER_READY");
  const second = spawnWorker(runDirectory, "second-recoverer", [], {
    kind: "admin-recovery",
    operation: "admin-recovery",
    mode: "session",
  });
  await event(second, "WORKER_READY");

  assert.equal((await first.command("VALIDATE")).result, "OK");
  const queued = await second.command("VALIDATE");
  assert.equal(queued.result, "ERROR");
  assert.equal(queued.code, "LOCK_QUEUED");
  const concurrent = await second.command("RECOVER", { force: true });
  assert.equal(concurrent.result, "ERROR");
  assert.equal(concurrent.code, "ADMIN_RECOVERY_CONCURRENT");
  assert.equal((await scanLockJournal(runDirectory, "admin-recovery")).releases.size, 0);

  await first.command("RELEASE");
  assert.equal((await second.command("VALIDATE")).result, "OK");
  await Promise.all([stopWorker(first), stopWorker(second)]);
});

test("two real unlockAdmin calls admit one recovery owner and reject the live contender", async () => {
  const { cwd, runId, runDirectory } = await createStoreRun(
    "maswe-unlock-admin-race-",
  );
  const first = spawnUnlockAdminWorker(
    cwd,
    runId,
    "unlock-first",
    ["OWNERSHIP_ENTERED"],
    true,
  );
  const entered = await event(first, "OWNERSHIP_ENTERED");
  assert.equal(entered.kind, "admin-recovery");

  const second = spawnUnlockAdminWorker(cwd, runId, "unlock-second", [], true);
  const rejected = await result(second);
  assert.equal(rejected.result, "ERROR");
  assert.equal(rejected.code, "ADMIN_RECOVERY_CONCURRENT");

  let recovery = await scanLockJournal(runDirectory, "admin-recovery");
  assert.equal(recovery.claims.length, 2);
  assert.equal(recovery.releases.has(recovery.claims[0]!.ticket), false);
  assert.equal(recovery.releases.has(recovery.claims[1]!.ticket), true);

  first.continue("OWNERSHIP_ENTERED");
  assert.equal((await result(first)).result, "OK");
  recovery = await scanLockJournal(runDirectory, "admin-recovery");
  assert.equal(recovery.releases.size, 2);
});

test("a crashed real unlockAdmin recovery owner is exact-recovered by its successor", async () => {
  const { cwd, runId, runDirectory } = await createStoreRun(
    "maswe-unlock-admin-crash-",
  );
  const crashed = spawnUnlockAdminWorker(
    cwd,
    runId,
    "unlock-crashed",
    ["OWNERSHIP_ENTERED"],
    true,
  );
  const entered = await event(crashed, "OWNERSHIP_ENTERED");
  assert.equal(entered.kind, "admin-recovery");
  crashed.child.kill("SIGKILL");
  await new Promise<void>((resolve) => crashed.child.once("exit", () => resolve()));

  const successor = spawnUnlockAdminWorker(
    cwd,
    runId,
    "unlock-successor",
    [],
    true,
  );
  assert.equal((await result(successor)).result, "OK");
  const recovery = await scanLockJournal(runDirectory, "admin-recovery");
  assert.equal(recovery.claims.length, 2);
  assert.equal(recovery.releases.size, 2);
});

test("two administrative recoverers converge on one dead recovery-claim release", async () => {
  const runDirectory = await freshRunDirectory("maswe-dead-recovery-process-");
  const paths = journalPaths(runDirectory, "admin-recovery");
  await initializeLockJournal(runDirectory);
  const dead = canonicalClaim({
    kind: "admin-recovery",
    ticket: 1n,
    owner: "01b4960f-7795-41fc-b9a7-06c9291a4bda",
    pid: 1_000_000_012,
    process: {
      startedAt: "2026-07-24T10:00:00.000Z",
      platformIdentity: null,
    },
    at: "2026-07-24T10:00:01.000Z",
    operation: "admin-recovery",
  });
  await writeFile(path.join(paths.claims, "00000000000000000001.json"), dead.bytes);
  const left = spawnWorker(
    runDirectory,
    "dead-recovery-left",
    ["RELEASE_LINK_ATTEMPT_READY"],
    {
      kind: "admin-recovery",
      operation: "admin-recovery",
      mode: "session",
    },
  );
  await event(left, "WORKER_READY");
  const right = spawnWorker(
    runDirectory,
    "dead-recovery-right",
    ["RELEASE_LINK_ATTEMPT_READY"],
    {
      kind: "admin-recovery",
      operation: "admin-recovery",
      mode: "session",
    },
  );
  await event(right, "WORKER_READY");

  const leftRecovery = left.command("RECOVER", { force: true });
  const rightRecovery = right.command("RECOVER", { force: true });
  await Promise.all([
    event(left, "RELEASE_LINK_ATTEMPT_READY"),
    event(right, "RELEASE_LINK_ATTEMPT_READY"),
  ]);
  left.continue("RELEASE_LINK_ATTEMPT_READY");
  right.continue("RELEASE_LINK_ATTEMPT_READY");
  assert.equal((await leftRecovery).result, "OK");
  assert.equal((await rightRecovery).result, "OK");
  assert.equal((await left.command("VALIDATE")).result, "OK");
  const loser = await right.command("VALIDATE");
  assert.equal(loser.result, "ERROR");
  assert.equal(loser.code, "LOCK_QUEUED");
  assert.equal((await scanLockJournal(runDirectory, "admin-recovery")).releases.size, 1);
  await Promise.all([stopWorker(left), stopWorker(right)]);
});

test("owner release and forced recovery converge while the successor survives", async () => {
  const runDirectory = await freshRunDirectory("maswe-release-recovery-process-");
  const owner = spawnWorker(
    runDirectory,
    "old-owner",
    ["RELEASE_LINK_ATTEMPT_READY"],
    { mode: "session" },
  );
  await event(owner, "WORKER_READY");
  const successor = spawnWorker(runDirectory, "successor", [], { mode: "session" });
  await event(successor, "WORKER_READY");
  const recoverer = spawnWorker(
    runDirectory,
    "forced-recoverer",
    ["RELEASE_LINK_ATTEMPT_READY"],
    { mode: "recovery" },
  );
  await event(recoverer, "WORKER_READY");

  const ownerRelease = owner.command("RELEASE");
  const forcedRelease = recoverer.command("RECOVER", { force: true });
  await Promise.all([
    event(owner, "RELEASE_LINK_ATTEMPT_READY"),
    event(recoverer, "RELEASE_LINK_ATTEMPT_READY"),
  ]);
  owner.continue("RELEASE_LINK_ATTEMPT_READY");
  recoverer.continue("RELEASE_LINK_ATTEMPT_READY");
  assert.equal((await ownerRelease).result, "OK");
  assert.equal((await forcedRelease).result, "OK");
  assert.equal((await successor.command("VALIDATE")).result, "OK");
  const lateRelease = owner.command("RELEASE");
  await event(owner, "RELEASE_LINK_ATTEMPT_READY");
  owner.continue("RELEASE_LINK_ATTEMPT_READY");
  assert.equal((await lateRelease).result, "OK");
  assert.equal((await successor.command("VALIDATE")).result, "OK");

  const scan = await scanLockJournal(runDirectory, "data");
  assert.equal(scan.claims.length, 2);
  assert.equal(scan.releases.size, 1);
  await Promise.all([stopWorker(owner), stopWorker(successor), stopWorker(recoverer)]);
});

function repetitionCount(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const count = Number(raw);
  if (!Number.isSafeInteger(count) || count < 1 || count > 1_000) {
    throw new Error(`${name} must be an integer from 1 through 1000`);
  }
  return count;
}

const allocationIterations = repetitionCount("MASWE_ISSUE11_ALLOCATION_ITERATIONS");
test(
  `allocation contention repetition (${allocationIterations ?? 0} requested iterations)`,
  { skip: allocationIterations === undefined },
  async () => {
    for (let iteration = 1; iteration <= allocationIterations!; iteration += 1) {
      const runDirectory = await freshRunDirectory(
        `maswe-allocation-repeat-${iteration}-`,
      );
      const left = spawnWorker(
        runDirectory,
        `allocation-left-${iteration}`,
        ["CLAIM_TICKET_PROPOSED", "CLAIM_LINK_ATTEMPT_READY"],
        { mode: "session" },
      );
      const right = spawnWorker(
        runDirectory,
        `allocation-right-${iteration}`,
        ["CLAIM_TICKET_PROPOSED", "CLAIM_LINK_ATTEMPT_READY"],
        { mode: "session" },
      );
      const proposals = await Promise.all([
        event(left, "CLAIM_TICKET_PROPOSED"),
        event(right, "CLAIM_TICKET_PROPOSED"),
      ]);
      assert.deepEqual(
        proposals.map((message) => message.ticket),
        ["00000000000000000001", "00000000000000000001"],
      );
      left.continue("CLAIM_TICKET_PROPOSED");
      right.continue("CLAIM_TICKET_PROPOSED");
      await Promise.all([
        event(left, "CLAIM_LINK_ATTEMPT_READY"),
        event(right, "CLAIM_LINK_ATTEMPT_READY"),
      ]);
      const leftReady = event(left, "WORKER_READY");
      const rightReady = event(right, "WORKER_READY");
      left.continue("CLAIM_LINK_ATTEMPT_READY");
      right.continue("CLAIM_LINK_ATTEMPT_READY");
      const first = await Promise.race([
        leftReady.then((message) => ({ worker: left, message, actor: "left" })),
        rightReady.then((message) => ({ worker: right, message, actor: "right" })),
      ]);
      const loser = first.actor === "left" ? right : left;
      const loserReady = first.actor === "left" ? rightReady : leftReady;
      const secondProposal = await event(loser, "CLAIM_TICKET_PROPOSED");
      assert.equal(secondProposal.ticket, "00000000000000000002");
      loser.continue("CLAIM_TICKET_PROPOSED");
      await event(loser, "CLAIM_LINK_ATTEMPT_READY");
      loser.continue("CLAIM_LINK_ATTEMPT_READY");
      const secondReady = await loserReady;

      const scan = await scanLockJournal(runDirectory, "data");
      assert.deepEqual(
        scan.claims.map((claim) => claim.ticket),
        ["00000000000000000001", "00000000000000000002"],
      );
      assert.equal(first.message.ticket, "00000000000000000001");
      assert.equal(secondReady.ticket, "00000000000000000002");
      assert.equal((await first.worker.command("VALIDATE")).result, "OK");
      const queued = await loser.command("VALIDATE");
      assert.equal(queued.result, "ERROR");
      assert.equal(queued.code, "LOCK_QUEUED");
      await Promise.all([stopWorker(left), stopWorker(right)]);
    }
  },
);

const releaseIterations = repetitionCount("MASWE_ISSUE11_RELEASE_ITERATIONS");
test(
  `owner recovery successor repetition (${releaseIterations ?? 0} requested iterations)`,
  { skip: releaseIterations === undefined },
  async () => {
    for (let iteration = 1; iteration <= releaseIterations!; iteration += 1) {
      const runDirectory = await freshRunDirectory(
        `maswe-release-repeat-${iteration}-`,
      );
      const owner = spawnWorker(
        runDirectory,
        `repeat-owner-${iteration}`,
        ["RELEASE_LINK_ATTEMPT_READY"],
        { mode: "session" },
      );
      await event(owner, "WORKER_READY");
      const successor = spawnWorker(
        runDirectory,
        `repeat-successor-${iteration}`,
        [],
        { mode: "session" },
      );
      await event(successor, "WORKER_READY");
      const recoverer = spawnWorker(
        runDirectory,
        `repeat-recoverer-${iteration}`,
        ["RELEASE_LINK_ATTEMPT_READY"],
        { mode: "recovery" },
      );
      await event(recoverer, "WORKER_READY");

      const ownerRelease = owner.command("RELEASE");
      const forcedRelease = recoverer.command("RECOVER", { force: true });
      await Promise.all([
        event(owner, "RELEASE_LINK_ATTEMPT_READY"),
        event(recoverer, "RELEASE_LINK_ATTEMPT_READY"),
      ]);
      recoverer.continue("RELEASE_LINK_ATTEMPT_READY");
      assert.equal((await forcedRelease).result, "OK");
      assert.equal((await successor.command("VALIDATE")).result, "OK");
      owner.continue("RELEASE_LINK_ATTEMPT_READY");
      assert.equal((await ownerRelease).result, "OK");
      assert.equal((await successor.command("VALIDATE")).result, "OK");

      const scan = await scanLockJournal(runDirectory, "data");
      assert.equal(scan.claims.length, 2);
      assert.equal(scan.releases.size, 1);
      assert.equal(scan.releases.has(scan.claims[1]!.ticket), false);
      await Promise.all([
        stopWorker(owner),
        stopWorker(successor),
        stopWorker(recoverer),
      ]);
    }
  },
);

test("crash after hard-link publication leaves one valid claim plus a temp alias", async () => {
  const runDirectory = await freshRunDirectory("maswe-ticket-crash-after-");
  const worker = spawnWorker(runDirectory, "crash-after", ["CLAIM_PUBLISHED"]);
  await event(worker, "CLAIM_PUBLISHED");
  worker.child.kill("SIGKILL");
  await new Promise<void>((resolve) => worker.child.once("exit", () => resolve()));

  const scan = await scanLockJournal(runDirectory, "data");
  assert.equal(scan.claims.length, 1);
  assert.equal(scan.highestTicket, 1n);
  assert.equal((await readdir(journalPaths(runDirectory, "data").tmp)).length, 1);
});
