import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { journalPaths, scanLockJournal } from "../src/lock-journal.ts";

const workerPath = fileURLToPath(
  new URL("./fixtures/lock-journal-worker.ts", import.meta.url),
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
}

interface Worker {
  child: ChildProcess;
  next(predicate: (message: WorkerMessage) => boolean): Promise<WorkerMessage>;
  continue(event: string): void;
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
): Worker {
  const child = fork(workerPath, [], {
    execArgv: ["--experimental-strip-types"],
    env: {
      ...process.env,
      MASWE_LOCK_RUN_DIRECTORY: runDirectory,
      MASWE_LOCK_ACTOR: actor,
      MASWE_LOCK_KIND: "data",
      MASWE_LOCK_OPERATION: "store-write",
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
    if (code === 0 || signal === "SIGKILL") return;
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
  };
}

async function event(worker: Worker, name: string): Promise<WorkerMessage> {
  return worker.next((message) => message.type === "EVENT" && message.event === name);
}

async function result(worker: Worker): Promise<WorkerMessage> {
  return worker.next((message) => message.type === "RESULT");
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
