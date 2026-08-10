import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  GitHubJournalError,
  initializeGitHubJournals,
  withGitHubJournal,
} from "../src/github/journal.ts";

const ASSOCIATION_DIGEST =
  "0d0eff7483f9df60bddf94736a2ce4e3e77fe46d895ebd415d72351adb890e30";

function associationJournal(githubRoot: string): string {
  return path.join(
    githubRoot,
    "journals",
    "association",
    ASSOCIATION_DIGEST,
  );
}

function migrationMarker(githubRoot: string): string {
  return path.join(associationJournal(githubRoot), "legacy-migration.json");
}

function deadOwner(token = "dead-owner"): string {
  return `${JSON.stringify({
    pid: 999_999_999,
    token,
    at: "2026-08-09T10:00:00.000Z",
  })}\n`;
}

test("initialization probes the hash-addressed association journal filesystem", async () => {
  const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-init-"));
  await initializeGitHubJournals(githubRoot);
  assert.equal(
    await readFile(
      path.join(associationJournal(githubRoot), ".lock-journal-v3", "format.json"),
      "utf8",
    ),
    '{"format":3,"protocol":"immutable-ticket-journal","ticketWidth":20}\n',
  );
});

test("initialization fails closed when hard-link publication is unavailable", async () => {
  const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-no-link-"));
  await assert.rejects(
    initializeGitHubJournals(githubRoot, {
      linkFile: async () => {
        const error = new Error("hard links unavailable") as NodeJS.ErrnoException;
        error.code = "ENOTSUP";
        throw error;
      },
    }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "GitHub association journal initialization failed",
  );
});

test("dead legacy regular-file ownership publishes digest-bound immutable evidence and retains the path", async () => {
  const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-file-"));
  const legacyPath = path.join(githubRoot, "associations.lock");
  const raw = deadOwner();
  await writeFile(legacyPath, raw, "utf8");

  await initializeGitHubJournals(githubRoot);

  assert.equal(await readFile(legacyPath, "utf8"), raw);
  const markerPath = migrationMarker(githubRoot);
  assert.equal((await lstat(markerPath)).isFile(), true);
  const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
  assert.equal(marker.kind, "association");
  assert.equal(marker.logicalKeyDigest, `sha256:${ASSOCIATION_DIGEST}`);
  assert.equal(
    marker.evidenceDigest,
    `sha256:${createHash("sha256").update(raw).digest("hex")}`,
  );
  assert.equal(typeof marker.migrationDigest, "string");
  assert.equal(JSON.stringify(marker).includes("dead-owner"), false);
});

test("a published exact legacy marker wins over later unrelated PID reuse", async (t) => {
  const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-pid-reuse-"));
  t.after(async () => rm(githubRoot, { recursive: true, force: true }));
  const legacyPath = path.join(githubRoot, "associations.lock");
  const raw = `${JSON.stringify({
    pid: process.pid,
    token: "historical-owner",
    at: "2026-08-09T10:00:00.000Z",
  })}\n`;
  await writeFile(legacyPath, raw, "utf8");

  await initializeGitHubJournals(githubRoot, {
    isProcessDefinitelyDead: (pid) => pid === process.pid,
  });

  let postMarkerLivenessChecks = 0;
  await assert.doesNotReject(
    initializeGitHubJournals(githubRoot, {
      isProcessDefinitelyDead: () => {
        postMarkerLivenessChecks += 1;
        throw new Error("published marker must precede PID classification");
      },
    }),
  );
  assert.equal(postMarkerLivenessChecks, 0);
  assert.equal(await readFile(legacyPath, "utf8"), raw);
  await access(migrationMarker(githubRoot));
});

test("association journals reject every noncanonical logical key", async (t) => {
  const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-association-key-"));
  t.after(async () => rm(githubRoot, { recursive: true, force: true }));

  await assert.rejects(
    withGitHubJournal(
      githubRoot,
      "association",
      "association",
      async () => undefined,
    ),
    /association journal options are invalid/i,
  );
  await assert.doesNotReject(
    withGitHubJournal(
      githubRoot,
      "association",
      "associations",
      async () => undefined,
    ),
  );
});

test("dead legacy directory ownership migrates without deleting the directory", async () => {
  const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-dir-"));
  const logicalKey = "legacy-check";
  const digest = "0b0921d94d255f1b2eae802f8cdb610bd03a77a2af3bb439493e9abd786261e2";
  const legacyPath = path.join(
    githubRoot,
    "side-effect-create-locks",
    `${digest}.json.lock`,
  );
  await mkdir(legacyPath, { recursive: true });
  await writeFile(path.join(legacyPath, "owner.json"), deadOwner(), "utf8");

  await withGitHubJournal(githubRoot, "check-create", logicalKey, async () => undefined);

  assert.equal((await lstat(legacyPath)).isDirectory(), true);
  assert.equal(await readFile(path.join(legacyPath, "owner.json"), "utf8"), deadOwner());
  const marker = path.join(
    githubRoot,
    "journals",
    "check-create",
    digest,
    "legacy-migration.json",
  );
  assert.equal((await lstat(marker)).isFile(), true);
});

test("an empty legacy crash directory publishes identity evidence and remains present", async () => {
  const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-empty-"));
  const legacyPath = path.join(githubRoot, "associations.lock");
  await mkdir(legacyPath);

  await initializeGitHubJournals(githubRoot);

  assert.deepEqual(await readdir(legacyPath), []);
  const marker = JSON.parse(
    await readFile(migrationMarker(githubRoot), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(marker.legacyType, "directory");
  assert.match(String(marker.evidenceDigest), /^sha256:[0-9a-f]{64}$/);
});

test("live, malformed, and changing legacy owners fail closed without migration", async (t) => {
  await t.test("live owner", async () => {
    const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-live-old-"));
    await writeFile(
      path.join(githubRoot, "associations.lock"),
      `${JSON.stringify({
        pid: process.pid,
        token: "live",
        at: "2026-08-09T10:00:00.000Z",
      })}\n`,
      "utf8",
    );
    await assert.rejects(
      initializeGitHubJournals(githubRoot),
      /GitHub association journal migration is blocked by legacy ownership/,
    );
    await assert.rejects(access(migrationMarker(githubRoot)), /ENOENT/);
  });

  await t.test("malformed owner", async () => {
    const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-bad-old-"));
    await writeFile(path.join(githubRoot, "associations.lock"), "not-json\n", "utf8");
    await assert.rejects(
      initializeGitHubJournals(githubRoot),
      /GitHub association journal migration is blocked by malformed legacy ownership/,
    );
    await assert.rejects(access(migrationMarker(githubRoot)), /ENOENT/);
  });

  await t.test("changing owner", async () => {
    const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-changing-"));
    const legacyPath = path.join(githubRoot, "associations.lock");
    await writeFile(legacyPath, deadOwner("first"), "utf8");
    await assert.rejects(
      initializeGitHubJournals(githubRoot, {
        afterLegacyObserved: async () => {
          await writeFile(legacyPath, deadOwner("replacement"), "utf8");
        },
      }),
      /GitHub association journal migration evidence changed/,
    );
    assert.equal(await readFile(legacyPath, "utf8"), deadOwner("replacement"));
    await assert.rejects(access(migrationMarker(githubRoot)), /ENOENT/);
  });
});

test("concurrent migration attempts reconcile one canonical marker without overwriting it", async () => {
  const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-migrate-race-"));
  await writeFile(path.join(githubRoot, "associations.lock"), deadOwner(), "utf8");
  let publicationAttempts = 0;
  await Promise.all(
    Array.from({ length: 8 }, () =>
      initializeGitHubJournals(githubRoot, {
        linkFile: async (existingPath, newPath) => {
          if (path.basename(newPath.toString()) === "legacy-migration.json") {
            publicationAttempts += 1;
          }
          await link(existingPath, newPath);
        },
      }),
    ),
  );

  assert.ok(publicationAttempts >= 1);
  const markerPath = migrationMarker(githubRoot);
  const before = await readFile(markerPath, "utf8");
  await initializeGitHubJournals(githubRoot);
  assert.equal(await readFile(markerPath, "utf8"), before);
  assert.deepEqual(
    (await readdir(associationJournal(githubRoot))).filter(
      (name) => name === "legacy-migration.json",
    ),
    ["legacy-migration.json"],
  );
});

test("legacy migration preserves both publication and temporary cleanup failures", async (t) => {
  const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-migrate-errors-"));
  t.after(async () => rm(githubRoot, { recursive: true, force: true }));
  await writeFile(path.join(githubRoot, "associations.lock"), deadOwner(), "utf8");

  await assert.rejects(
    initializeGitHubJournals(githubRoot, {
      linkFile: async (existingPath, newPath) => {
        await link(existingPath, newPath);
        if (path.basename(newPath.toString()) !== "legacy-migration.json") return;
        await chmod(newPath, 0o600);
        await writeFile(newPath, "corrupted-after-publication\n", "utf8");
        await unlink(existingPath);
        await mkdir(existingPath);
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof GitHubJournalError);
      assert.ok(error.cause instanceof AggregateError);
      assert.equal(error.cause.errors.length, 2);
      return true;
    },
  );
});

test("journal transactions preserve both operation and release failures", async (t) => {
  const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-release-errors-"));
  t.after(async () => rm(githubRoot, { recursive: true, force: true }));
  const operationError = new Error("synthetic operation failure");

  await assert.rejects(
    withGitHubJournal(
      githubRoot,
      "delivery",
      "delivery-with-release-error",
      async () => {
        throw operationError;
      },
      {
        transition: async (event) => {
          if (event === "RELEASE_PREPARED") throw new Error("synthetic release failure");
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], operationError);
      assert.ok(error.errors[1] instanceof GitHubJournalError);
      assert.equal(error.errors[1].code, "GITHUB_JOURNAL_RELEASE_FAILED");
      return true;
    },
  );
});
