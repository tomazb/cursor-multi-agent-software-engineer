import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitHubDeliveryStore, type DeliveryRecord } from "../src/github/delivery-store.ts";
import { withGitHubJournal } from "../src/github/journal.ts";

const CLAIMED_AT = "2026-08-09T10:00:00.000Z";
const COMPLETED_AT = "2026-08-09T10:00:01.000Z";

function processing(deliveryId: string, leaseId: string): DeliveryRecord {
  return { deliveryId, status: "processing", leaseId, claimedAt: CLAIMED_AT };
}

function completed(deliveryId: string, leaseId: string): DeliveryRecord {
  return {
    deliveryId,
    status: "completed",
    leaseId,
    claimedAt: CLAIMED_AT,
    completedAt: COMPLETED_AT,
  };
}

async function writeRecord(filePath: string, record: DeliveryRecord): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

async function deliveryFixture(deliveryId: string): Promise<{
  root: string;
  deliveries: string;
  canonical: string;
  store: GitHubDeliveryStore;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-delivery-journal-"));
  const deliveries = path.join(root, "deliveries");
  await mkdir(deliveries);
  return {
    root,
    deliveries,
    canonical: path.join(deliveries, `${deliveryId}.json`),
    store: new GitHubDeliveryStore(root, { staleProcessingMs: 60_000 }),
  };
}

function delay(milliseconds: number): Promise<"blocked"> {
  return new Promise((resolve) => setTimeout(() => resolve("blocked"), milliseconds));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function waitForClaimCount(claimsDirectory: string, count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      if ((await readdir(claimsDirectory)).length === count) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await delay(10);
  }
  throw new Error(`timed out waiting for ${count} delivery journal claims`);
}

function spawnDeliveryWorker(
  root: string,
  deliveryId: string,
  operation: "claim" | "complete" | "fail",
  leaseId: string,
  resultPath: string,
): Promise<void> {
  const fixture = path.join(import.meta.dirname, "fixtures", "github-delivery-worker.ts");
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", fixture, root, deliveryId, operation, leaseId, resultPath],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`delivery worker failed (${code ?? signal}): ${stderr}`));
    });
  });
}

test("claim, complete, and fail wait for the immutable journal protecting their delivery", async (t) => {
  for (const operation of ["claim", "complete", "fail"] as const) {
    await t.test(operation, async () => {
      const deliveryId = `d-${operation}`;
      const { root, canonical, store } = await deliveryFixture(deliveryId);
      if (operation !== "claim") {
        await writeRecord(canonical, processing(deliveryId, "lease-current"));
      }

      let pending: Promise<unknown> | undefined;
      await withGitHubJournal(root, "delivery", deliveryId, async () => {
        pending =
          operation === "claim"
            ? store.claim(deliveryId)
            : operation === "complete"
              ? store.complete(deliveryId, "lease-current")
              : store.fail(deliveryId, "expected failure", "lease-current");
        const state = await Promise.race([
          pending.then(() => "settled" as const),
          delay(75),
        ]);
        assert.equal(state, "blocked");
      });
      await pending;
    });
  }
});

test("claim, complete, and fail from separate processes serialize on one delivery journal", async () => {
  const deliveryId = "d-process-contention";
  const { root, canonical } = await deliveryFixture(deliveryId);
  await writeRecord(canonical, processing(deliveryId, "lease-current"));
  const resultPaths = ["claim", "complete", "fail"].map((operation) =>
    path.join(root, `${operation}.result.json`),
  );
  const keyDigest = createHash("sha256").update(deliveryId).digest("hex");
  const journalData = path.join(
    root,
    "journals",
    "delivery",
    keyDigest,
    ".lock-journal-v3",
    "data",
  );
  let workers: Promise<void>[] = [];

  await withGitHubJournal(root, "delivery", deliveryId, async () => {
    workers = (["claim", "complete", "fail"] as const).map((operation, index) =>
      spawnDeliveryWorker(
        root,
        deliveryId,
        operation,
        "lease-current",
        resultPaths[index]!,
      ),
    );
    await waitForClaimCount(path.join(journalData, "claims"), 4);
    assert.deepEqual(
      await Promise.all(resultPaths.map((resultPath) => exists(resultPath))),
      [false, false, false],
    );
  });

  await Promise.all(workers);
  for (const resultPath of resultPaths) {
    assert.equal(typeof JSON.parse(await readFile(resultPath, "utf8")), "object");
  }
  assert.equal((await readdir(path.join(journalData, "claims"))).length, 4);
  assert.equal((await readdir(path.join(journalData, "releases"))).length, 4);
});

test("a lone completed staging is not installed when canonical delivery state is absent", async () => {
  const { canonical, store } = await deliveryFixture("d-lone");
  const staging = `${canonical}.staging.only`;
  await writeRecord(staging, completed("d-lone", "lease-a"));

  const claim = await store.claim("d-lone", Date.parse(CLAIMED_AT));

  assert.equal(claim.claimed, true);
  assert.notEqual(claim.leaseId, "lease-a");
  assert.equal(JSON.parse(await readFile(canonical, "utf8")).status, "processing");
  await access(staging);
});

test("an older lone staging lease cannot beat the sole eligible current staging/reclaim pair", async () => {
  const { canonical, store } = await deliveryFixture("d-current");
  await writeRecord(`${canonical}.staging.a-old`, completed("d-current", "lease-a"));
  await writeRecord(`${canonical}.staging.b-current`, completed("d-current", "lease-b"));
  await writeRecord(`${canonical}.reclaim.b-current`, processing("d-current", "lease-b"));

  const claim = await store.claim("d-current");

  assert.equal(claim.claimed, false);
  assert.equal(claim.status, "completed");
  assert.equal(JSON.parse(await readFile(canonical, "utf8")).leaseId, "lease-b");
  await access(`${canonical}.staging.a-old`);
  await assert.rejects(() => access(`${canonical}.staging.b-current`), { code: "ENOENT" });
  await assert.rejects(() => access(`${canonical}.reclaim.b-current`), { code: "ENOENT" });
});

test("failing the current lease keeps an older retained pair from suppressing retry", async () => {
  const deliveryId = "d-failed-current";
  const { canonical, store } = await deliveryFixture(deliveryId);
  await writeRecord(canonical, processing(deliveryId, "lease-b"));
  const olderStaging = `${canonical}.staging.older-a`;
  const olderReclaim = `${canonical}.reclaim.older-a`;
  await writeRecord(olderStaging, completed(deliveryId, "lease-a"));
  await writeRecord(olderReclaim, processing(deliveryId, "lease-a"));

  assert.deepEqual(await store.fail(deliveryId, "retry B", "lease-b"), { ok: true });
  const retry = await store.claim(deliveryId, Date.parse(CLAIMED_AT));

  assert.equal(retry.claimed, true);
  assert.equal(retry.duplicate, false);
  assert.equal(retry.status, "processing");
  assert.notEqual(retry.leaseId, "lease-a");
  assert.notEqual(retry.leaseId, "lease-b");
  await access(olderStaging);
  await access(olderReclaim);
});

test("a crash after durable suppression publication leaves the current lease retryable", async () => {
  const deliveryId = "d-failure-marker-crash";
  const { root, canonical } = await deliveryFixture(deliveryId);
  await writeRecord(canonical, processing(deliveryId, "lease-b"));
  const olderStaging = `${canonical}.staging.older-a`;
  const olderReclaim = `${canonical}.reclaim.older-a`;
  await writeRecord(olderStaging, completed(deliveryId, "lease-a"));
  await writeRecord(olderReclaim, processing(deliveryId, "lease-a"));
  let injectCrash = true;
  let suppressionPath: string | undefined;
  const store = new GitHubDeliveryStore(root, {
    staleProcessingMs: 60_000,
    afterFailureSuppressionPublished: async (_canonical, markerPath) => {
      if (!injectCrash) return;
      injectCrash = false;
      suppressionPath = markerPath;
      throw new Error("simulated crash after failure suppression");
    },
  });

  await assert.rejects(
    () => store.fail(deliveryId, "retry B", "lease-b"),
    /simulated crash after failure suppression/,
  );
  assert.equal(JSON.parse(await readFile(canonical, "utf8")).leaseId, "lease-b");
  assert.ok(suppressionPath);
  await access(suppressionPath);
  await access(olderStaging);
  await access(olderReclaim);

  assert.deepEqual(await store.fail(deliveryId, "retry B", "lease-b"), { ok: true });
  const retry = await store.claim(deliveryId, Date.parse(CLAIMED_AT));
  assert.equal(retry.claimed, true);
  assert.notEqual(retry.leaseId, "lease-a");
  await access(olderStaging);
  await access(olderReclaim);
});

test("fail keeps the processing canonical when suppression directory sync fails", async () => {
  const deliveryId = "d-failure-marker-sync";
  const { root, deliveries, canonical } = await deliveryFixture(deliveryId);
  await writeRecord(canonical, processing(deliveryId, "lease-b"));
  await writeRecord(`${canonical}.staging.older-a`, completed(deliveryId, "lease-a"));
  await writeRecord(`${canonical}.reclaim.older-a`, processing(deliveryId, "lease-a"));
  let directorySyncs = 0;
  const store = new GitHubDeliveryStore(root, {
    staleProcessingMs: 60_000,
    syncDirectory: async (directoryPath) => {
      assert.equal(directoryPath, deliveries);
      directorySyncs += 1;
      throw new Error("simulated suppression directory sync failure");
    },
  });

  await assert.rejects(
    () => store.fail(deliveryId, "retry B", "lease-b"),
    /simulated suppression directory sync failure/,
  );

  assert.equal(directorySyncs, 1);
  assert.equal(JSON.parse(await readFile(canonical, "utf8")).leaseId, "lease-b");
});

test("fail rejects a removal sync failure while leaving suppression recovery safe", async () => {
  const deliveryId = "d-failure-removal-sync";
  const { root, deliveries, canonical } = await deliveryFixture(deliveryId);
  await writeRecord(canonical, processing(deliveryId, "lease-b"));
  const olderStaging = `${canonical}.staging.older-a`;
  const olderReclaim = `${canonical}.reclaim.older-a`;
  await writeRecord(olderStaging, completed(deliveryId, "lease-a"));
  await writeRecord(olderReclaim, processing(deliveryId, "lease-a"));
  let directorySyncs = 0;
  const store = new GitHubDeliveryStore(root, {
    staleProcessingMs: 60_000,
    syncDirectory: async (directoryPath) => {
      assert.equal(directoryPath, deliveries);
      directorySyncs += 1;
      if (directorySyncs === 2) {
        throw new Error("simulated canonical removal sync failure");
      }
    },
  });

  await assert.rejects(
    () => store.fail(deliveryId, "retry B", "lease-b"),
    /simulated canonical removal sync failure/,
  );

  assert.equal(directorySyncs, 2);
  await assert.rejects(() => access(canonical), { code: "ENOENT" });
  const retry = await store.claim(deliveryId, Date.parse(CLAIMED_AT));
  assert.equal(retry.claimed, true);
  assert.notEqual(retry.leaseId, "lease-a");
  await access(olderStaging);
  await access(olderReclaim);
});

test("failure-suppression marker filename must match its canonical publication identity", async (t) => {
  for (const replacementId of [
    "not-a-publication-id",
    "00000000-0000-4000-8000-000000000000",
  ]) {
    await t.test(replacementId, async () => {
      const deliveryId = `d-marker-name-${replacementId.slice(0, 8)}`;
      const { deliveries, canonical, store } = await deliveryFixture(deliveryId);
      await writeRecord(canonical, processing(deliveryId, "lease-b"));
      await writeRecord(`${canonical}.staging.older-a`, completed(deliveryId, "lease-a"));
      await writeRecord(`${canonical}.reclaim.older-a`, processing(deliveryId, "lease-a"));
      assert.deepEqual(await store.fail(deliveryId, "retry B", "lease-b"), { ok: true });
      const canonicalBase = path.basename(canonical);
      const markerNames = (await readdir(deliveries)).filter((name) =>
        name.startsWith(`${canonicalBase}.suppression.`),
      );
      assert.equal(markerNames.length, 1);
      const replacementPath = `${canonical}.suppression.${replacementId}`;
      await rename(path.join(deliveries, markerNames[0]!), replacementPath);

      await assert.rejects(() => store.claim(deliveryId), /suppression|marker/i);

      await access(replacementPath);
      await assert.rejects(() => access(canonical), { code: "ENOENT" });
    });
  }
});

test("a malformed published failure-suppression marker fails closed", async () => {
  const deliveryId = "d-malformed-suppression";
  const { canonical, store } = await deliveryFixture(deliveryId);
  await writeRecord(canonical, processing(deliveryId, "lease-b"));
  await writeFile(`${canonical}.suppression.corrupt`, '{"format":1', "utf8");

  await assert.rejects(
    () => store.fail(deliveryId, "retry B", "lease-b"),
    /suppression|marker/i,
  );

  assert.equal(JSON.parse(await readFile(canonical, "utf8")).leaseId, "lease-b");
});

test("failure suppression does not hide a candidate whose exact artifact bytes changed", async () => {
  const deliveryId = "d-new-artifact-bytes";
  const { canonical, store } = await deliveryFixture(deliveryId);
  await writeRecord(canonical, processing(deliveryId, "lease-b"));
  const stagingPath = `${canonical}.staging.older-a`;
  const reclaimPath = `${canonical}.reclaim.older-a`;
  await writeRecord(stagingPath, completed(deliveryId, "lease-a"));
  await writeRecord(reclaimPath, processing(deliveryId, "lease-a"));
  assert.deepEqual(await store.fail(deliveryId, "retry B", "lease-b"), { ok: true });

  await writeRecord(stagingPath, {
    ...completed(deliveryId, "lease-a"),
    completedAt: "2026-08-09T10:00:02.000Z",
  });
  const retry = await store.claim(deliveryId);

  assert.equal(retry.claimed, false);
  assert.equal(retry.status, "completed");
  assert.equal(JSON.parse(await readFile(canonical, "utf8")).leaseId, "lease-a");
});

test("recovery groups staging and reclaim records by attempt before pairing them", async () => {
  const { canonical, store } = await deliveryFixture("d-attempt");
  await writeRecord(`${canonical}.staging.attempt-a`, completed("d-attempt", "lease-a"));
  await writeRecord(`${canonical}.reclaim.attempt-b`, processing("d-attempt", "lease-a"));

  const claim = await store.claim("d-attempt", Date.parse(CLAIMED_AT));

  assert.equal(claim.claimed, true);
  assert.notEqual(claim.leaseId, "lease-a");
  const evidence = await readdir(path.dirname(canonical));
  assert.ok(evidence.includes(`${path.basename(canonical)}.staging.attempt-a`));
  assert.ok(evidence.includes(`${path.basename(canonical)}.reclaim.attempt-b`));
});

test("multiple compatible but conflicting legacy candidates fail closed and preserve all evidence", async () => {
  const { canonical, store } = await deliveryFixture("d-conflict");
  for (const [attempt, leaseId] of [
    ["attempt-a", "lease-a"],
    ["attempt-b", "lease-b"],
  ] as const) {
    await writeRecord(`${canonical}.staging.${attempt}`, completed("d-conflict", leaseId));
    await writeRecord(`${canonical}.reclaim.${attempt}`, processing("d-conflict", leaseId));
  }

  await assert.rejects(() => store.claim("d-conflict"), /conflict|ambiguous/i);

  await assert.rejects(() => access(canonical), { code: "ENOENT" });
  const evidence = await readdir(path.dirname(canonical));
  assert.deepEqual(
    evidence.sort(),
    [
      `${path.basename(canonical)}.reclaim.attempt-a`,
      `${path.basename(canonical)}.reclaim.attempt-b`,
      `${path.basename(canonical)}.staging.attempt-a`,
      `${path.basename(canonical)}.staging.attempt-b`,
    ],
  );
});
