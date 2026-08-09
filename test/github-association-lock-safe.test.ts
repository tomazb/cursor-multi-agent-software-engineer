import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LockJournalError,
  publishLockClaim,
  scanLockJournal,
} from "../src/lock-journal.ts";
import { withGitHubJournal } from "../src/github/journal.ts";

const ASSOCIATION_DIGEST =
  "0d0eff7483f9df60bddf94736a2ce4e3e77fe46d895ebd415d72351adb890e30";

test("a live lower-ticket owner remains blocking and the queued claim is exactly released", async () => {
  const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-live-"));
  const journalDirectory = path.join(
    githubRoot,
    "journals",
    "association",
    ASSOCIATION_DIGEST,
  );
  await mkdir(journalDirectory, { recursive: true });
  const lower = await publishLockClaim(
    journalDirectory,
    "data",
    "github-association",
  );

  await assert.rejects(
    withGitHubJournal(
      githubRoot,
      "association",
      "associations",
      async () => assert.fail("live owner must remain blocking"),
      { timeoutMs: 50, pollIntervalMs: 5 },
    ),
    /Timed out acquiring GitHub association journal/,
  );

  const scan = await scanLockJournal(journalDirectory, "data");
  assert.equal(scan.releases.has(lower.claim.ticket), false);
  assert.equal(scan.claims.length, 2);
  assert.equal(scan.releases.has(scan.claims[1]!.ticket), true);
});

test("the GitHub journal path hashes the complete logical key", async () => {
  const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-path-"));
  const logicalKey = "credential-looking-value:secret";
  await withGitHubJournal(githubRoot, "delivery", logicalKey, async () => undefined);
  const digest = createHash("sha256").update(logicalKey).digest("hex");
  const scan = await scanLockJournal(
    path.join(githubRoot, "journals", "delivery", digest),
    "data",
  );
  assert.equal(scan.claims.length, 1);
  assert.equal(scan.claims[0]!.operation, "github-delivery");
});

test("a callback LockJournalError is propagated once instead of being treated as contention", async () => {
  const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-callback-"));
  const callbackError = new LockJournalError(
    "LOCK_QUEUED",
    "callback-owned lock error",
  );
  let calls = 0;
  await assert.rejects(
    withGitHubJournal(
      githubRoot,
      "association",
      "associations",
      async () => {
        calls += 1;
        throw callbackError;
      },
      { timeoutMs: 20, pollIntervalMs: 5 },
    ),
    (error: unknown) => error === callbackError,
  );
  assert.equal(calls, 1);

  const scan = await scanLockJournal(
    path.join(githubRoot, "journals", "association", ASSOCIATION_DIGEST),
    "data",
  );
  assert.equal(scan.claims.length, 1);
  assert.equal(scan.releases.has(scan.claims[0]!.ticket), true);
});
