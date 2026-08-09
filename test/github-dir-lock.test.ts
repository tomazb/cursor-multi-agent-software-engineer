import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workerPath = fileURLToPath(
  new URL("./fixtures/github-journal-worker.ts", import.meta.url),
);
const WATCHDOG_MS = 10_000;

interface WorkerMessage {
  type: "ENTER" | "TRANSITION" | "COMPLETE" | "ERROR";
  actor: string;
  pid: number;
  event?: string;
  ticket?: string;
  code?: string;
  message?: string;
}

interface Worker {
  child: ChildProcess;
  next(predicate: (message: WorkerMessage) => boolean): Promise<WorkerMessage>;
  release(): void;
}

function spawnWorker(
  githubRoot: string,
  eventsPath: string,
  actor: string,
  timeoutMs = 3_000,
): Worker {
  const child = fork(workerPath, [], {
    execArgv: ["--experimental-strip-types"],
    env: {
      ...process.env,
      MASWE_GITHUB_ROOT: githubRoot,
      MASWE_GITHUB_EVENTS_PATH: eventsPath,
      MASWE_GITHUB_ACTOR: actor,
      MASWE_GITHUB_JOURNAL_KIND: "check-create",
      MASWE_GITHUB_LOGICAL_KEY: "shared-key",
      MASWE_GITHUB_TIMEOUT_MS: String(timeoutMs),
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
    const error =
      code === 0
        ? new Error(`GitHub journal worker ${actor} exited before the expected message`)
        : new Error(`GitHub journal worker ${actor} exited ${code ?? signal}`);
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
          reject(new Error(`GitHub journal worker ${actor} watchdog expired`));
        }, WATCHDOG_MS);
        waiters.push({ predicate, resolve, reject, timer });
      });
    },
    release() {
      child.send({ type: "RELEASE" });
    },
  };
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

test("two child processes enter one logical GitHub journal strictly one at a time", async () => {
  const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-process-"));
  const eventsPath = path.join(githubRoot, "events.log");
  await writeFile(eventsPath, "", "utf8");
  const first = spawnWorker(githubRoot, eventsPath, "first");
  await first.next((message) => message.type === "ENTER");

  const second = spawnWorker(githubRoot, eventsPath, "second");
  await second.next(
    (message) => message.type === "TRANSITION" && message.event === "CLAIM_PUBLISHED",
  );
  assert.equal(await readFile(eventsPath, "utf8"), "first:enter\n");

  first.release();
  await first.next((message) => message.type === "COMPLETE");
  await second.next((message) => message.type === "ENTER");
  assert.equal(
    await readFile(eventsPath, "utf8"),
    "first:enter\nfirst:exit\nsecond:enter\n",
  );
  second.release();
  await second.next((message) => message.type === "COMPLETE");
  await Promise.all([waitForExit(first.child), waitForExit(second.child)]);
});
