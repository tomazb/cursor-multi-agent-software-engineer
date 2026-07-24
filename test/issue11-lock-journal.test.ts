import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LOCK_JOURNAL_DIRECTORY,
  MAX_LOCK_TICKET,
  LockJournalError,
  canonicalClaim,
  canonicalRelease,
  formatLockTicket,
  initializeLockJournal,
  journalPaths,
  parseClaimBytes,
  parseReleaseBytes,
  publishLockClaim,
  releaseBasename,
  scanLockJournal,
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

const CLAIM_INPUT = {
  kind: "data" as const,
  ticket: 1n,
  owner: "550e8400-e29b-41d4-a716-446655440000",
  pid: 12345,
  process: {
    startedAt: "2026-07-24T10:00:00.000Z",
    platformIdentity: null,
  },
  at: "2026-07-24T10:00:01.000Z",
  operation: "store-write" as const,
};

test("tickets use canonical fixed-width BigInt encoding and fail closed on overflow", () => {
  assert.equal(formatLockTicket(1n), "00000000000000000001");
  assert.equal(formatLockTicket(MAX_LOCK_TICKET), "99999999999999999999");
  assert.throws(
    () => formatLockTicket(0n),
    (error: unknown) =>
      error instanceof LockJournalError && error.code === "LOCK_CORRUPT",
  );
  assert.throws(
    () => formatLockTicket(MAX_LOCK_TICKET + 1n),
    (error: unknown) =>
      error instanceof LockJournalError && error.code === "LOCK_TICKET_OVERFLOW",
  );
});

test("claim encoding is canonical, digest-bound, and rejects mutation", () => {
  const claim = canonicalClaim(CLAIM_INPUT);
  assert.equal(claim.record.ticket, "00000000000000000001");
  assert.match(claim.record.claimDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(parseClaimBytes(claim.bytes, "data", 1n).claimDigest, claim.record.claimDigest);

  const unknownField = claim.bytes.replace(
    ',"claimDigest"',
    ',"unexpected":true,"claimDigest"',
  );
  assert.throws(
    () => parseClaimBytes(unknownField, "data", 1n),
    (error: unknown) =>
      error instanceof LockJournalError && error.code === "LOCK_CORRUPT",
  );
  assert.throws(
    () => parseClaimBytes(claim.bytes.replace('"pid":12345', '"pid":12346'), "data", 1n),
    (error: unknown) =>
      error instanceof LockJournalError && error.code === "LOCK_CORRUPT",
  );
});

test("one deterministic release identity is derived only from the exact claim", () => {
  const claim = canonicalClaim(CLAIM_INPUT).record;
  const first = canonicalRelease(claim);
  const second = canonicalRelease(claim);
  assert.equal(first.bytes, second.bytes);
  assert.deepEqual(first.record, second.record);
  assert.equal(
    releaseBasename(claim),
    `data.00000000000000000001.${claim.owner}.${claim.claimDigest.slice("sha256:".length)}.json`,
  );
  assert.equal(
    parseReleaseBytes(first.bytes, claim).releaseDigest,
    first.record.releaseDigest,
  );
  assert.equal(first.bytes.includes("reason"), false);
  assert.equal(first.bytes.includes("releasedBy"), false);
  assert.equal(first.bytes.includes('"at"'), false);
});

test("journal scan validates a contiguous range and ignores only ordinary temp records", async () => {
  const runDirectory = await freshRunDirectory("maswe-journal-scan-");
  await initializeLockJournal(runDirectory);
  const paths = journalPaths(runDirectory, "data");
  const claim1 = canonicalClaim(CLAIM_INPUT);
  const claim2 = canonicalClaim({
    ...CLAIM_INPUT,
    ticket: 2n,
    owner: "8d196f64-9811-4f6c-9234-a43f12847e93",
  });
  await writeFile(path.join(paths.claims, "00000000000000000001.json"), claim1.bytes);
  await writeFile(path.join(paths.tmp, `.claim.${CLAIM_INPUT.owner}.tmp`), "partial");

  const one = await scanLockJournal(runDirectory, "data");
  assert.equal(one.claims.length, 1);
  assert.equal(one.highestTicket, 1n);

  await writeFile(path.join(paths.claims, "00000000000000000003.json"), claim2.bytes);
  await assert.rejects(
    scanLockJournal(runDirectory, "data"),
    (error: unknown) =>
      error instanceof LockJournalError && error.code === "LOCK_CORRUPT",
  );
});

test("journal scan rejects malformed names, links, and conflicting release interpretation", async () => {
  const runDirectory = await freshRunDirectory("maswe-journal-corrupt-");
  await initializeLockJournal(runDirectory);
  const paths = journalPaths(runDirectory, "data");
  const claim = canonicalClaim(CLAIM_INPUT);
  await writeFile(path.join(paths.claims, "00000000000000000001.json"), claim.bytes);
  await symlink(
    path.join(paths.claims, "00000000000000000001.json"),
    path.join(paths.releases, releaseBasename(claim.record)),
  );

  await assert.rejects(
    scanLockJournal(runDirectory, "data"),
    (error: unknown) =>
      error instanceof LockJournalError && error.code === "LOCK_UNSAFE_PATH_TYPE",
  );
});

function barrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived === parties) release();
    await waiting;
  };
}

test("two claimants may propose one ticket but publish contiguous unique claims", async () => {
  const runDirectory = await freshRunDirectory("maswe-journal-allocate-");
  const proposed = barrier(2);
  const proposals: string[] = [];
  const publish = (actor: string) =>
    publishLockClaim(runDirectory, "data", "store-write", {
      transition: async (event, context) => {
        if (event === "CLAIM_TICKET_PROPOSED") {
          proposals.push(`${actor}:${context.ticket}`);
          await proposed();
        }
      },
    });

  const [left, right] = await Promise.all([publish("left"), publish("right")]);
  assert.deepEqual(new Set([left.ticket, right.ticket]), new Set([1n, 2n]));
  assert.deepEqual(
    proposals.slice(0, 2).map((entry) => entry.split(":")[1]),
    ["00000000000000000001", "00000000000000000001"],
  );
  assert.equal(
    proposals.at(-1)?.split(":")[1],
    "00000000000000000002",
    "the conflict loser must rescan and propose the contiguous successor",
  );
  const scan = await scanLockJournal(runDirectory, "data");
  assert.deepEqual(scan.claims.map((claim) => claim.ticket), [
    "00000000000000000001",
    "00000000000000000002",
  ]);
});

test("three concurrent claimants allocate a gap-free numeric sequence", async () => {
  const runDirectory = await freshRunDirectory("maswe-journal-three-");
  const proposed = barrier(3);
  const handles = await Promise.all(
    Array.from({ length: 3 }, () =>
      publishLockClaim(runDirectory, "admin", "admin-serialize", {
        transition: async (event) => {
          if (event === "CLAIM_TICKET_PROPOSED") await proposed();
        },
      }),
    ),
  );
  assert.deepEqual(
    handles.map((handle) => handle.ticket).sort((a, b) => (a < b ? -1 : 1)),
    [1n, 2n, 3n],
  );
  assert.equal((await scanLockJournal(runDirectory, "admin")).highestTicket, 3n);
});
