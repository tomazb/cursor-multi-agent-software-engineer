import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LOCK_JOURNAL_DIRECTORY,
  LockJournalError,
  initializeLockJournal,
  journalPaths,
  type LockJournalErrorCode,
} from "../src/lock-journal.ts";

const ERROR_CODES: LockJournalErrorCode[] = [
  "LOCK_LIVE_OWNER",
  "LOCK_DEAD_OWNER",
  "LOCK_QUEUED",
  "LOCK_CORRUPT",
  "LOCK_INCOMPLETE",
  "LOCK_UNSAFE_PATH_TYPE",
  "LOCK_OWNERSHIP_LOST",
  "ADMIN_RECOVERY_CONCURRENT",
  "LOCK_CLEANUP_FAILED",
  "LOCK_UNSUPPORTED_FILESYSTEM",
  "LOCK_TICKET_OVERFLOW",
];

async function freshRunDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const runDirectory = path.join(root, "run");
  await mkdir(runDirectory);
  return runDirectory;
}

test("semantic lock errors retain stable Issue #11 codes and causes", () => {
  const cause = new Error("platform detail");
  for (const code of ERROR_CODES) {
    const error = new LockJournalError(code, `message for ${code}`, { cause });
    assert.equal(error.name, "LockJournalError");
    assert.equal(error.code, code);
    assert.equal(error.cause, cause);
  }
});

test("initialization creates and validates permanent journal infrastructure", async () => {
  const runDirectory = await freshRunDirectory("maswe-journal-init-");
  await initializeLockJournal(runDirectory);
  await initializeLockJournal(runDirectory);

  const root = path.join(runDirectory, LOCK_JOURNAL_DIRECTORY);
  const manifest = await readFile(path.join(root, "format.json"), "utf8");
  assert.equal(
    manifest,
    '{"format":3,"protocol":"immutable-ticket-journal","ticketWidth":20}\n',
  );
  for (const kind of ["data", "admin", "admin-recovery"] as const) {
    const paths = journalPaths(runDirectory, kind);
    for (const directory of [paths.root, paths.kind, paths.claims, paths.releases, paths.tmp]) {
      assert.equal((await lstat(directory)).isDirectory(), true, directory);
      assert.equal((await lstat(directory)).isSymbolicLink(), false, directory);
    }
  }
});

test("concurrent initializers converge on one safe permanent layout", async () => {
  const runDirectory = await freshRunDirectory("maswe-journal-race-");
  await Promise.all(Array.from({ length: 8 }, () => initializeLockJournal(runDirectory)));
  assert.equal(
    await readFile(path.join(runDirectory, LOCK_JOURNAL_DIRECTORY, "format.json"), "utf8"),
    '{"format":3,"protocol":"immutable-ticket-journal","ticketWidth":20}\n',
  );
});

test("safe pre-manifest initialization can resume", async () => {
  const runDirectory = await freshRunDirectory("maswe-journal-resume-");
  await mkdir(path.join(runDirectory, LOCK_JOURNAL_DIRECTORY));
  await mkdir(path.join(runDirectory, LOCK_JOURNAL_DIRECTORY, "data"));

  await initializeLockJournal(runDirectory);
  assert.equal(
    await readFile(path.join(runDirectory, LOCK_JOURNAL_DIRECTORY, "format.json"), "utf8"),
    '{"format":3,"protocol":"immutable-ticket-journal","ticketWidth":20}\n',
  );
});

test("missing permanent component after manifest publication fails closed", async () => {
  const runDirectory = await freshRunDirectory("maswe-journal-missing-");
  await initializeLockJournal(runDirectory);
  const paths = journalPaths(runDirectory, "data");

  // Simulate external corruption without exercising production cleanup.
  await import("node:fs/promises").then((fs) => fs.rmdir(paths.claims));

  await assert.rejects(
    initializeLockJournal(runDirectory),
    (error: unknown) =>
      error instanceof LockJournalError &&
      error.code === "LOCK_CORRUPT" &&
      /missing permanent/i.test(error.message),
  );
});

test("unsafe journal root symlink is rejected without following or replacing it", async () => {
  const runDirectory = await freshRunDirectory("maswe-journal-link-");
  const target = path.join(path.dirname(runDirectory), "target");
  await mkdir(target);
  const root = path.join(runDirectory, LOCK_JOURNAL_DIRECTORY);
  await symlink(target, root, "dir");

  await assert.rejects(
    initializeLockJournal(runDirectory),
    (error: unknown) =>
      error instanceof LockJournalError && error.code === "LOCK_UNSAFE_PATH_TYPE",
  );
  assert.equal((await lstat(root)).isSymbolicLink(), true);
});
