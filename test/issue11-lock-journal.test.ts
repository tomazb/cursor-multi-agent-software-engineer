import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  unlink,
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
  publishClaimRelease,
  publishLockClaim,
  recoverCurrentLock,
  releaseBasename,
  scanLockJournal,
  validateClaimOwnership,
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

test("pre-manifest published records are rejected as impossible initialization state", async () => {
  const runDirectory = await freshRunDirectory("maswe-journal-preseeded-");
  const paths = journalPaths(runDirectory, "data");
  await mkdir(paths.claims, { recursive: true });
  await writeFile(
    path.join(paths.claims, "00000000000000000001.json"),
    canonicalClaim(CLAIM_INPUT).bytes,
  );

  await assert.rejects(
    initializeLockJournal(runDirectory),
    (error: unknown) =>
      error instanceof LockJournalError && error.code === "LOCK_CORRUPT",
  );
  await assert.rejects(readFile(paths.manifest, "utf8"), /ENOENT/);
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

test("unsupported hard-link publication fails closed under injected filesystem semantics", async () => {
  const runDirectory = await freshRunDirectory("maswe-journal-no-link-");
  await assert.rejects(
    initializeLockJournal(runDirectory, {
      linkFile: async () => {
        const error = new Error("hard links unavailable") as NodeJS.ErrnoException;
        error.code = "ENOTSUP";
        throw error;
      },
    }),
    (error: unknown) =>
      error instanceof LockJournalError &&
      error.code === "LOCK_UNSUPPORTED_FILESYSTEM",
  );
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

test("claim and temporary symlinks are rejected without being followed", async () => {
  const runDirectory = await freshRunDirectory("maswe-journal-entry-link-");
  await initializeLockJournal(runDirectory);
  const paths = journalPaths(runDirectory, "data");
  const outside = path.join(path.dirname(runDirectory), "outside");
  await writeFile(outside, canonicalClaim(CLAIM_INPUT).bytes);
  await symlink(outside, path.join(paths.claims, "00000000000000000001.json"));
  await assert.rejects(
    scanLockJournal(runDirectory, "data"),
    (error: unknown) =>
      error instanceof LockJournalError && error.code === "LOCK_UNSAFE_PATH_TYPE",
  );

  const secondRun = await freshRunDirectory("maswe-journal-temp-link-");
  await initializeLockJournal(secondRun);
  const secondPaths = journalPaths(secondRun, "data");
  await symlink(outside, path.join(secondPaths.tmp, `.claim.${CLAIM_INPUT.owner}.tmp`));
  await assert.rejects(
    scanLockJournal(secondRun, "data"),
    (error: unknown) =>
      error instanceof LockJournalError && error.code === "LOCK_UNSAFE_PATH_TYPE",
  );
});

test("malformed filenames and unsupported record versions fail closed", async () => {
  const malformedRun = await freshRunDirectory("maswe-journal-name-");
  await initializeLockJournal(malformedRun);
  await writeFile(
    path.join(journalPaths(malformedRun, "data").claims, "1.json"),
    canonicalClaim(CLAIM_INPUT).bytes,
  );
  await assert.rejects(
    scanLockJournal(malformedRun, "data"),
    (error: unknown) =>
      error instanceof LockJournalError && error.code === "LOCK_CORRUPT",
  );

  const versionRun = await freshRunDirectory("maswe-journal-version-");
  await initializeLockJournal(versionRun);
  await writeFile(
    path.join(
      journalPaths(versionRun, "data").claims,
      "00000000000000000001.json",
    ),
    canonicalClaim(CLAIM_INPUT).bytes.replace('"format":3', '"format":4'),
  );
  await assert.rejects(
    scanLockJournal(versionRun, "data"),
    (error: unknown) =>
      error instanceof LockJournalError && error.code === "LOCK_CORRUPT",
  );
});

test("wrong-digest, duplicate, and missing-target releases fail closed", async () => {
  const wrongDigestRun = await freshRunDirectory("maswe-journal-release-wrong-");
  const claim = await publishLockClaim(wrongDigestRun, "data", "store-write");
  const paths = journalPaths(wrongDigestRun, "data");
  const canonical = canonicalRelease(claim.claim);
  await writeFile(
    path.join(paths.releases, releaseBasename(claim.claim)),
    canonical.bytes.replace(claim.claimDigest.slice(-1), "0"),
  );
  await assert.rejects(
    scanLockJournal(wrongDigestRun, "data"),
    (error: unknown) =>
      error instanceof LockJournalError && error.code === "LOCK_CORRUPT",
  );

  const duplicateRun = await freshRunDirectory("maswe-journal-release-duplicate-");
  const duplicateClaim = await publishLockClaim(duplicateRun, "data", "store-write");
  const duplicatePaths = journalPaths(duplicateRun, "data");
  const release = canonicalRelease(duplicateClaim.claim);
  await writeFile(
    path.join(duplicatePaths.releases, releaseBasename(duplicateClaim.claim)),
    release.bytes,
  );
  await writeFile(
    path.join(duplicatePaths.releases, `duplicate-${releaseBasename(duplicateClaim.claim)}`),
    release.bytes,
  );
  await assert.rejects(
    scanLockJournal(duplicateRun, "data"),
    (error: unknown) =>
      error instanceof LockJournalError && error.code === "LOCK_CORRUPT",
  );

  const missingRun = await freshRunDirectory("maswe-journal-release-missing-");
  await initializeLockJournal(missingRun);
  await writeFile(
    path.join(journalPaths(missingRun, "data").releases, releaseBasename(claim.claim)),
    canonical.bytes,
  );
  await assert.rejects(
    scanLockJournal(missingRun, "data"),
    (error: unknown) =>
      error instanceof LockJournalError && error.code === "LOCK_CORRUPT",
  );
});

test("enumeration order cannot change numeric claim order", async () => {
  const runDirectory = await freshRunDirectory("maswe-journal-listing-order-");
  await initializeLockJournal(runDirectory);
  const paths = journalPaths(runDirectory, "data");
  const second = canonicalClaim({
    ...CLAIM_INPUT,
    ticket: 2n,
    owner: "8d196f64-9811-4f6c-9234-a43f12847e93",
  });
  await writeFile(path.join(paths.claims, "00000000000000000002.json"), second.bytes);
  await writeFile(
    path.join(paths.claims, "00000000000000000001.json"),
    canonicalClaim(CLAIM_INPUT).bytes,
  );
  assert.deepEqual(
    (await scanLockJournal(runDirectory, "data")).claims.map((claim) => claim.ticket),
    ["00000000000000000001", "00000000000000000002"],
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

test("claim publication rejects a changed prepared temporary before linking", async () => {
  const runDirectory = await freshRunDirectory("maswe-journal-prelink-");
  const paths = journalPaths(runDirectory, "data");

  await assert.rejects(
    publishLockClaim(runDirectory, "data", "store-write", {
      transition: async (event) => {
        if (event !== "CLAIM_PREPARED") return;
        const [basename] = await readdir(paths.tmp);
        assert.ok(basename);
        const temporaryPath = path.join(paths.tmp, basename);
        await chmod(temporaryPath, 0o600);
        await writeFile(temporaryPath, "changed-after-close\n");
      },
    }),
    (error: unknown) =>
      error instanceof LockJournalError && error.code === "LOCK_CORRUPT",
  );
  assert.deepEqual(await readdir(paths.claims), []);
});

test("claim publication preserves both validation and cleanup failures", async () => {
  const runDirectory = await freshRunDirectory("maswe-journal-dual-failure-");
  const paths = journalPaths(runDirectory, "data");

  await assert.rejects(
    publishLockClaim(runDirectory, "data", "store-write", {
      transition: async (event) => {
        if (event !== "CLAIM_PREPARED") return;
        const [basename] = await readdir(paths.tmp);
        assert.ok(basename);
        const temporaryPath = path.join(paths.tmp, basename);
        await unlink(temporaryPath);
        await symlink(path.join(runDirectory, "outside"), temporaryPath);
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(
        error.errors.map((item) =>
          item instanceof LockJournalError ? item.code : "UNKNOWN"
        ),
        ["LOCK_UNSAFE_PATH_TYPE", "LOCK_UNSAFE_PATH_TYPE"],
      );
      return true;
    },
  );
  assert.deepEqual(await readdir(paths.claims), []);
});

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

test("exact-range ownership keeps higher claims queued until every predecessor is released", async () => {
  const runDirectory = await freshRunDirectory("maswe-journal-owner-");
  const first = await publishLockClaim(runDirectory, "data", "store-write");
  const second = await publishLockClaim(runDirectory, "data", "store-write");
  const third = await publishLockClaim(runDirectory, "data", "store-write");

  await validateClaimOwnership(first);
  await assert.rejects(
    validateClaimOwnership(second),
    (error: unknown) =>
      error instanceof LockJournalError && error.code === "LOCK_QUEUED",
  );
  await publishClaimRelease(first);
  await validateClaimOwnership(second);
  await assert.rejects(
    validateClaimOwnership(third),
    (error: unknown) =>
      error instanceof LockJournalError && error.code === "LOCK_QUEUED",
  );
  await publishClaimRelease(second);
  await validateClaimOwnership(third);
});

test("concurrent owner and recoverer releases converge on one canonical marker", async () => {
  const runDirectory = await freshRunDirectory("maswe-journal-release-");
  const owner = await publishLockClaim(runDirectory, "data", "store-write");

  const releases = await Promise.all([
    publishClaimRelease(owner),
    publishClaimRelease(owner),
  ]);
  assert.equal(releases[0].bytes, releases[1].bytes);
  assert.deepEqual(
    await readdir(journalPaths(runDirectory, "data").releases),
    [releaseBasename(owner.claim)],
  );
  await assert.rejects(
    validateClaimOwnership(owner),
    (error: unknown) =>
      error instanceof LockJournalError && error.code === "LOCK_OWNERSHIP_LOST",
  );
});

test("late former-owner release cannot modify or release a successor claim", async () => {
  const runDirectory = await freshRunDirectory("maswe-journal-late-");
  const former = await publishLockClaim(runDirectory, "data", "store-write");
  const successor = await publishLockClaim(runDirectory, "data", "store-write");
  await publishClaimRelease(former);
  await validateClaimOwnership(successor);
  const successorBytes = canonicalClaim({
    kind: successor.claim.kind,
    ticket: successor.ticket,
    owner: successor.owner,
    pid: successor.claim.pid,
    process: successor.claim.process,
    at: successor.claim.at,
    operation: successor.claim.operation,
  }).bytes;

  await publishClaimRelease(former);
  await validateClaimOwnership(successor);
  assert.equal(
    await readFile(
      path.join(
        journalPaths(runDirectory, "data").claims,
        `${successor.claim.ticket}.json`,
      ),
      "utf8",
    ),
    successorBytes,
  );
  assert.equal(
    (await readdir(journalPaths(runDirectory, "data").releases)).includes(
      releaseBasename(successor.claim),
    ),
    false,
  );
});

test("legacy ticket zero is exact, immutable, and required before v3 ownership", async () => {
  const runDirectory = await freshRunDirectory("maswe-journal-legacy-");
  const legacyPath = path.join(runDirectory, ".lock");
  const legacyBytes = `${JSON.stringify({
    pid: process.pid,
    owner: "legacy-live-owner",
    at: "2026-07-24T10:00:00.000Z",
  })}\n`;
  await writeFile(legacyPath, legacyBytes);
  const claimant = await publishLockClaim(runDirectory, "data", "store-write");

  await assert.rejects(
    validateClaimOwnership(claimant),
    (error: unknown) =>
      error instanceof LockJournalError &&
      ["LOCK_QUEUED", "LOCK_LIVE_OWNER"].includes(error.code),
  );
  await assert.rejects(
    recoverCurrentLock(runDirectory, "data", { force: false }),
    (error: unknown) =>
      error instanceof LockJournalError && error.code === "LOCK_LIVE_OWNER",
  );
  await recoverCurrentLock(runDirectory, "data", { force: true });
  assert.equal(await readFile(legacyPath, "utf8"), legacyBytes);
  await validateClaimOwnership(claimant);

  await writeFile(legacyPath, legacyBytes.replace("legacy-live-owner", "mutated-owner"));
  await assert.rejects(
    validateClaimOwnership(claimant),
    (error: unknown) =>
      error instanceof LockJournalError && error.code === "LOCK_CORRUPT",
  );
});

test("dead legacy ticket zero is explicitly recoverable without force", async () => {
  const runDirectory = await freshRunDirectory("maswe-journal-legacy-dead-");
  const legacyPath = path.join(runDirectory, ".admin.lock");
  const legacyBytes = `${JSON.stringify({
    pid: 1_000_000_001,
    owner: "legacy-dead-owner",
    at: "2026-07-24T10:00:00.000Z",
  })}\n`;
  await writeFile(legacyPath, legacyBytes);
  await recoverCurrentLock(runDirectory, "admin", { force: false });
  assert.equal(await readFile(legacyPath, "utf8"), legacyBytes);
});

test("corrupt legacy ticket zero remains fail closed without force", async () => {
  const runDirectory = await freshRunDirectory("maswe-journal-legacy-corrupt-");
  const legacyPath = path.join(runDirectory, ".lock");
  await writeFile(legacyPath, "{partial");
  await assert.rejects(
    recoverCurrentLock(runDirectory, "data", { force: false }),
    (error: unknown) =>
      error instanceof LockJournalError && error.code === "LOCK_CORRUPT",
  );
  await recoverCurrentLock(runDirectory, "data", { force: true });
  assert.equal(await readFile(legacyPath, "utf8"), "{partial");
});

test("forced corrupt-claim resolution is bound to exact raw bytes and preserves the claim", async () => {
  const runDirectory = await freshRunDirectory("maswe-journal-raw-claim-");
  await initializeLockJournal(runDirectory);
  const paths = journalPaths(runDirectory, "data");
  const claimPath = path.join(paths.claims, "00000000000000000001.json");
  const corruptBytes = '{"format":3,"record":"claim","ticket":"00000000000000000001"';
  await writeFile(claimPath, corruptBytes);

  await assert.rejects(
    recoverCurrentLock(runDirectory, "data", { force: false }),
    (error: unknown) =>
      error instanceof LockJournalError && error.code === "LOCK_CORRUPT",
  );
  await recoverCurrentLock(runDirectory, "data", { force: true });
  assert.equal(await readFile(claimPath, "utf8"), corruptBytes);

  const successor = await publishLockClaim(runDirectory, "data", "store-write");
  assert.equal(successor.ticket, 2n);
  await validateClaimOwnership(successor);

  await writeFile(claimPath, `${corruptBytes} `);
  await assert.rejects(
    validateClaimOwnership(successor),
    (error: unknown) =>
      error instanceof LockJournalError && error.code === "LOCK_CORRUPT",
  );
});

test("corrupt-claim recovery digests exact binary bytes without UTF-8 replacement", async () => {
  const runDirectory = await freshRunDirectory("maswe-journal-raw-binary-");
  await initializeLockJournal(runDirectory);
  const paths = journalPaths(runDirectory, "data");
  const rawBytes = Buffer.from([0xff, 0xfe, 0x00, 0x7b]);
  await writeFile(
    path.join(paths.claims, "00000000000000000001.json"),
    rawBytes,
  );

  await recoverCurrentLock(runDirectory, "data", { force: true });
  const expectedDigest = createHash("sha256").update(rawBytes).digest("hex");
  assert.deepEqual(await readdir(paths.releases), [
    `data.00000000000000000001.raw.${expectedDigest}.json`,
  ]);
});

test("corrupt administrative-recovery claims remain fail closed under force", async () => {
  const runDirectory = await freshRunDirectory("maswe-journal-raw-recovery-");
  await initializeLockJournal(runDirectory);
  const paths = journalPaths(runDirectory, "admin-recovery");
  await writeFile(
    path.join(paths.claims, "00000000000000000001.json"),
    "{corrupt-recovery-claim",
  );

  await assert.rejects(
    recoverCurrentLock(runDirectory, "admin-recovery", { force: true }),
    (error: unknown) =>
      error instanceof LockJournalError && error.code === "LOCK_CORRUPT",
  );
  assert.deepEqual(await readdir(paths.releases), []);
});

test("recovery always targets the smallest unreleased ticket before higher corruption", async () => {
  const runDirectory = await freshRunDirectory("maswe-journal-recovery-order-");
  const live = await publishLockClaim(runDirectory, "data", "store-write");
  const paths = journalPaths(runDirectory, "data");
  await writeFile(
    path.join(paths.claims, "00000000000000000002.json"),
    "{higher-corrupt-claim",
  );

  await assert.rejects(
    recoverCurrentLock(runDirectory, "data", { force: false }),
    (error: unknown) =>
      error instanceof LockJournalError && error.code === "LOCK_LIVE_OWNER",
  );
  await recoverCurrentLock(runDirectory, "data", { force: true });
  assert.deepEqual(await readdir(paths.releases), [releaseBasename(live.claim)]);
});

test(
  "Linux process-start identity prevents PID reuse from preserving a dead claim",
  { skip: process.platform !== "linux" },
  async () => {
    const runDirectory = await freshRunDirectory("maswe-journal-pid-reuse-");
    await initializeLockJournal(runDirectory);
    const paths = journalPaths(runDirectory, "data");
    const reusedPid = canonicalClaim({
      ...CLAIM_INPUT,
      pid: process.pid,
      process: {
        startedAt: "2026-07-24T10:00:00.000Z",
        platformIdentity:
          "linux:550e8400-e29b-41d4-a716-446655440000:0",
      },
    });
    await writeFile(
      path.join(paths.claims, "00000000000000000001.json"),
      reusedPid.bytes,
    );
    await recoverCurrentLock(runDirectory, "data", { force: false });
    assert.equal(
      (await scanLockJournal(runDirectory, "data")).releases.has(
        reusedPid.record.ticket,
      ),
      true,
    );
  },
);

test("production lock lifecycle never deletes published journals or canonical records", async () => {
  const [journalSource, storeSource] = await Promise.all([
    readFile(new URL("../src/lock-journal.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/store.ts", import.meta.url), "utf8"),
  ]);
  const production = `${journalSource}\n${storeSource}`;
  assert.doesNotMatch(production, /\brm(?:Sync)?\s*\(/);
  assert.doesNotMatch(production, /\brmdir(?:Sync)?\s*\(/);
  assert.doesNotMatch(journalSource, /unlink\s*\(\s*(?:finalPath|claimPath|releasePath)/);
  assert.doesNotMatch(journalSource, /rename\s*\(/);
  assert.doesNotMatch(journalSource, /recursive\s*:/);
  assert.doesNotMatch(storeSource, /\bunlink\s*\(/);
  assert.doesNotMatch(storeSource, /\.lock-journal-v3[\s\S]*\brename\s*\(/);
});
