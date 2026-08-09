import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
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
