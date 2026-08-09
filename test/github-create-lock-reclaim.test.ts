import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
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
    }, 10_000);
    child.on("message", (message: { type?: string }) => {
      if (message.type !== "ENTER") return;
      settle();
    });
    child.once("error", settle);
    child.once("exit", (code, signal) => {
      settle(new Error(`exited owner terminated before ENTER: ${code ?? signal}`));
    });
  });
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

test("an exited lower-ticket owner is released by its exact immutable claim", async () => {
  const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-dead-"));
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

test("a conservative EPERM process probe keeps the lower owner blocking", async () => {
  const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-eperm-"));
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
