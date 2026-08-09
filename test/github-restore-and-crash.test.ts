import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitHubDeliveryStore, type DeliveryRecord } from "../src/github/delivery-store.ts";

const CLAIMED_AT = "2026-08-09T12:00:00.000Z";
const COMPLETED_AT = "2026-08-09T12:00:01.000Z";

function processing(deliveryId: string, leaseId: string): DeliveryRecord {
  return { deliveryId, status: "processing", leaseId, claimedAt: CLAIMED_AT };
}

function completed(deliveryId: string, leaseId: string): DeliveryRecord {
  return {
    ...processing(deliveryId, leaseId),
    status: "completed",
    completedAt: COMPLETED_AT,
  };
}

async function writeRecord(filePath: string, record: DeliveryRecord): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

test("processing canonical plus same-lease completed staging finishes completion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-current-stage-"));
  const deliveries = path.join(root, "deliveries");
  await mkdir(deliveries);
  const canonical = path.join(deliveries, "d-current.json");
  await writeRecord(canonical, processing("d-current", "lease-current"));
  await writeRecord(
    `${canonical}.staging.crash-before-replace`,
    completed("d-current", "lease-current"),
  );

  const retry = await new GitHubDeliveryStore(root).claim("d-current");

  assert.equal(retry.claimed, false);
  assert.equal(retry.status, "completed");
  assert.deepEqual(JSON.parse(await readFile(canonical, "utf8")), {
    deliveryId: "d-current",
    status: "completed",
    leaseId: "lease-current",
    claimedAt: CLAIMED_AT,
    completedAt: COMPLETED_AT,
  });
});

test("a matching legacy staging/reclaim pair recovers missing or truncated canonical", async (t) => {
  for (const canonicalState of ["missing", "truncated"] as const) {
    await t.test(canonicalState, async () => {
      const deliveryId = `d-${canonicalState}`;
      const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-legacy-pair-"));
      const deliveries = path.join(root, "deliveries");
      await mkdir(deliveries);
      const canonical = path.join(deliveries, `${deliveryId}.json`);
      await writeRecord(
        `${canonical}.staging.legacy-attempt`,
        completed(deliveryId, "lease-legacy"),
      );
      await writeRecord(
        `${canonical}.reclaim.legacy-attempt`,
        processing(deliveryId, "lease-legacy"),
      );
      if (canonicalState === "truncated") {
        await writeFile(canonical, "{\"deliveryId\":", "utf8");
      }

      const retry = await new GitHubDeliveryStore(root).claim(deliveryId);

      assert.equal(retry.claimed, false);
      assert.equal(retry.duplicate, true);
      assert.equal(retry.status, "completed");
      const recovered = JSON.parse(await readFile(canonical, "utf8")) as DeliveryRecord;
      assert.equal(recovered.status, "completed");
      assert.equal(recovered.leaseId, "lease-legacy");
    });
  }
});
