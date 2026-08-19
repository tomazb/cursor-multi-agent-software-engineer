import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  runMutationJournalRoot,
  withRunMutationFence,
} from "../src/run-mutation.ts";
import { FileRunStore } from "../src/store.ts";

interface WorkerMessage {
  type: "EVENT" | "RESULT";
  event?: string;
  result?: string;
  requestId?: string;
}

test("invalid run mutation options fail before publishing ownership", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-run-mutation-options-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("mutation options", "reject before claim", DEFAULT_CONFIG);

  await assert.rejects(
    withRunMutationFence(cwd, run.id, "target", async () => undefined, {
      timeoutMs: 60_001,
    }),
    /Run mutation fence options are invalid/,
  );

  assert.deepEqual(await readdir(runMutationJournalRoot(cwd, run.id)), []);
});

test("a timed-out queued mutation claim is exactly released before rejection", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-run-mutation-timeout-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("mutation timeout", "release queued claim", DEFAULT_CONFIG);
  const dataRoot = path.join(runMutationJournalRoot(cwd, run.id), ".lock-journal-v3", "data");

  await withRunMutationFence(cwd, run.id, "publication", async () => {
    await assert.rejects(
      withRunMutationFence(cwd, run.id, "target", async () => undefined, {
        timeoutMs: 0,
      }),
      /Timed out acquiring durable run mutation fence/,
    );
    assert.equal((await readdir(path.join(dataRoot, "releases"))).length, 1);
  });

  await withRunMutationFence(cwd, run.id, "target", async () => undefined, {
    timeoutMs: 1_000,
  });
  assert.equal((await readdir(path.join(dataRoot, "claims"))).length, 3);
  assert.equal((await readdir(path.join(dataRoot, "releases"))).length, 3);
});

function waitForMessage(
  child: ReturnType<typeof fork>,
  predicate: (message: WorkerMessage) => boolean,
): Promise<WorkerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("mutation worker watchdog expired")), 10_000);
    const onMessage = (message: WorkerMessage): void => {
      if (!predicate(message)) return;
      clearTimeout(timer);
      child.off("message", onMessage);
      resolve(message);
    };
    child.on("message", onMessage);
    child.once("error", reject);
  });
}

test("durable run mutation ownership crosses processes and ESRCH-recovers a crashed owner without deletion", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-run-mutation-process-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("mutation process", "recover immutable ownership", DEFAULT_CONFIG);
  await withRunMutationFence(cwd, run.id, "target", async () => undefined);
  const mutationRoot = runMutationJournalRoot(cwd, run.id);
  const child = fork(
    path.join(process.cwd(), "test/fixtures/lock-journal-worker.ts"),
    [],
    {
      execArgv: ["--experimental-strip-types"],
      env: {
        ...process.env,
        MASWE_LOCK_RUN_DIRECTORY: mutationRoot,
        MASWE_LOCK_ACTOR: "crash-owner",
        MASWE_LOCK_KIND: "data",
        MASWE_LOCK_OPERATION: "run-publication",
        MASWE_LOCK_MODE: "session",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  await waitForMessage(child, (message) => message.event === "WORKER_READY");
  const validation = waitForMessage(
    child,
    (message) => message.type === "RESULT" && message.requestId === "validate",
  );
  child.send({ type: "COMMAND", command: "VALIDATE", requestId: "validate" });
  assert.equal((await validation).result, "OK");
  const exited = new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
  child.kill("SIGKILL");
  await exited;

  let entered = false;
  await withRunMutationFence(cwd, run.id, "target", async () => {
    entered = true;
  }, { timeoutMs: 5_000 });
  assert.equal(entered, true);

  const dataRoot = path.join(runMutationJournalRoot(cwd, run.id), ".lock-journal-v3", "data");
  assert.deepEqual((await readdir(path.join(dataRoot, "claims"))).sort(), [
    "00000000000000000001.json",
    "00000000000000000002.json",
    "00000000000000000003.json",
  ]);
  const releases = (await readdir(path.join(dataRoot, "releases"))).sort();
  assert.equal(releases.length, 3);
  assert.deepEqual(
    releases.map((name) => name.match(/^data\.([0-9]{20})\./)?.[1]),
    ["00000000000000000001", "00000000000000000002", "00000000000000000003"],
  );
});
