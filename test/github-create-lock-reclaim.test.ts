import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  canonicalClaim,
  initializeLockJournal,
  journalPaths,
  publishLockClaim,
  scanLockJournal,
} from "../src/lock-journal.ts";
import { withGitHubJournal } from "../src/github/journal.ts";

function checkJournalDirectory(githubRoot: string, logicalKey: string): string {
  const digest = createHash("sha256").update(logicalKey).digest("hex");
  return path.join(githubRoot, "journals", "check-create", digest);
}

const workerPath = fileURLToPath(
  new URL("./fixtures/github-journal-worker.ts", import.meta.url),
);
const WATCHDOG_MS = 10_000;

async function waitForExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolve, reject) => {
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("exited owner post-SIGKILL watchdog expired"));
    }, WATCHDOG_MS);
    child.once("exit", onExit);
  });
}

async function publishThenExit(
  githubRoot: string,
  logicalKey: string,
): Promise<void> {
  const eventsPath = path.join(githubRoot, "events.log");
  await writeFile(eventsPath, "", "utf8");
  const child = fork(workerPath, [], {
    execArgv: ["--experimental-strip-types"],
    env: {
      ...process.env,
      MASWE_GITHUB_ROOT: githubRoot,
      MASWE_GITHUB_EVENTS_PATH: eventsPath,
      MASWE_GITHUB_ACTOR: "exited-owner",
      MASWE_GITHUB_JOURNAL_KIND: "check-create",
      MASWE_GITHUB_LOGICAL_KEY: logicalKey,
      MASWE_GITHUB_TIMEOUT_MS: "3000",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let startupError: unknown;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      settle(new Error("exited owner watchdog expired"));
    }, WATCHDOG_MS);
    child.on("message", (message: { type?: string }) => {
      if (message.type !== "ENTER") return;
      settle();
    });
    child.once("error", settle);
    child.once("exit", (code, signal) => {
      settle(new Error(`exited owner terminated before ENTER: ${code ?? signal}`));
    });
  }).catch((error) => {
    startupError = error;
  });
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  const exit = await waitForExit(child);
  if (startupError !== undefined) throw startupError;
  assert.deepEqual(exit, { code: null, signal: "SIGKILL" });
}

test("an exited lower-ticket owner is released by its exact immutable claim", async (t) => {
  const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-dead-"));
  t.after(async () => rm(githubRoot, { recursive: true, force: true }));
  const logicalKey = "dead-lower-owner";
  const journalDirectory = checkJournalDirectory(githubRoot, logicalKey);
  await publishThenExit(githubRoot, logicalKey);
  const before = await scanLockJournal(journalDirectory, "data");
  const lower = before.claims[0]!;

  let entered = false;
  await withGitHubJournal(
    githubRoot,
    "check-create",
    logicalKey,
    async () => {
      entered = true;
    },
    { timeoutMs: 1_000 },
  );
  assert.equal(entered, true);

  const scan = await scanLockJournal(journalDirectory, "data");
  assert.equal(scan.claims.length, 2);
  assert.equal(scan.releases.has(lower.ticket), true);
  const releaseNames = await readdir(journalPaths(journalDirectory, "data").releases);
  assert.equal(releaseNames.length, 2);
  assert.equal(
    releaseNames.some(
      (name) =>
        name.includes(lower.owner) &&
        name.includes(lower.claimDigest.slice("sha256:".length)),
    ),
    true,
  );
});

test("a conservative EPERM process probe keeps the lower owner blocking", async (t) => {
  const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-eperm-"));
  t.after(async () => rm(githubRoot, { recursive: true, force: true }));
  const logicalKey = "eperm-lower-owner";
  const journalDirectory = checkJournalDirectory(githubRoot, logicalKey);
  await mkdir(journalDirectory, { recursive: true });
  await publishLockClaim(journalDirectory, "data", "github-check-create");

  const originalKill = process.kill;
  (process as { kill: typeof process.kill }).kill = (() => {
    const error = new Error("not permitted") as NodeJS.ErrnoException;
    error.code = "EPERM";
    throw error;
  }) as typeof process.kill;
  try {
    await assert.rejects(
      withGitHubJournal(
        githubRoot,
        "check-create",
        logicalKey,
        async () => assert.fail("EPERM owner must remain blocking"),
        { timeoutMs: 50, pollIntervalMs: 5 },
      ),
      (error: unknown) =>
        error instanceof Error &&
        /Timed out acquiring GitHub check-create journal/.test(error.message) &&
        !error.message.includes(logicalKey),
    );
  } finally {
    process.kill = originalKill;
  }
});

test("an indeterminate EIO process probe cannot release a GitHub lower owner", async (t) => {
  const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-eio-"));
  t.after(async () => rm(githubRoot, { recursive: true, force: true }));
  const logicalKey = "eio-lower-owner";
  const journalDirectory = checkJournalDirectory(githubRoot, logicalKey);
  await mkdir(journalDirectory, { recursive: true });
  const lower = await publishLockClaim(
    journalDirectory,
    "data",
    "github-check-create",
  );

  const originalKill = process.kill;
  (process as { kill: typeof process.kill }).kill = (() => {
    const error = new Error("indeterminate process probe") as NodeJS.ErrnoException;
    error.code = "EIO";
    throw error;
  }) as typeof process.kill;
  let entered = false;
  try {
    await assert.rejects(
      withGitHubJournal(
        githubRoot,
        "check-create",
        logicalKey,
        async () => {
          entered = true;
        },
        { timeoutMs: 50, pollIntervalMs: 5 },
      ),
      /Timed out acquiring GitHub check-create journal/,
    );
  } finally {
    process.kill = originalKill;
  }

  const scan = await scanLockJournal(journalDirectory, "data");
  assert.equal(entered, false);
  assert.equal(scan.releases.has(lower.claim.ticket), false);
  assert.equal(scan.claims.length, 2);
  assert.equal(scan.releases.has(scan.claims[1]!.ticket), true);
});

test(
  "a process identity mismatch cannot release a GitHub lower owner without ESRCH",
  { skip: process.platform !== "linux" },
  async (t) => {
    const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-pid-id-"));
    t.after(async () => rm(githubRoot, { recursive: true, force: true }));
    const logicalKey = "identity-mismatch-lower-owner";
    const journalDirectory = checkJournalDirectory(githubRoot, logicalKey);
    await mkdir(journalDirectory, { recursive: true });
    await initializeLockJournal(journalDirectory);
    const lower = canonicalClaim({
      kind: "data",
      ticket: 1n,
      owner: "550e8400-e29b-41d4-a716-446655440000",
      pid: process.pid,
      process: {
        startedAt: "2026-08-09T10:00:00.000Z",
        platformIdentity: "linux:550e8400-e29b-41d4-a716-446655440000:0",
      },
      at: "2026-08-09T10:00:00.000Z",
      operation: "github-check-create",
    });
    await writeFile(
      path.join(
        journalPaths(journalDirectory, "data").claims,
        "00000000000000000001.json",
      ),
      lower.bytes,
      "utf8",
    );

    let entered = false;
    await assert.rejects(
      withGitHubJournal(
        githubRoot,
        "check-create",
        logicalKey,
        async () => {
          entered = true;
        },
        { timeoutMs: 50, pollIntervalMs: 5 },
      ),
      /Timed out acquiring GitHub check-create journal/,
    );

    const scan = await scanLockJournal(journalDirectory, "data");
    assert.equal(entered, false);
    assert.equal(scan.releases.has(lower.record.ticket), false);
    assert.equal(scan.claims.length, 2);
    assert.equal(scan.releases.has(scan.claims[1]!.ticket), true);
  },
);
