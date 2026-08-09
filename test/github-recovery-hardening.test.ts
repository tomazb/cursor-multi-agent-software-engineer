import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitHubDeliveryStore, type DeliveryRecord } from "../src/github/delivery-store.ts";

const CLAIMED_AT = "2026-08-09T11:00:00.000Z";
const COMPLETED_AT = "2026-08-09T11:00:01.000Z";

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

async function writeRecord(filePath: string, record: object): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

test("legacy recovery requires full records with matching identity, status, and timestamps", async (t) => {
  const cases: Array<{
    name: string;
    staging: object;
    reclaim: object;
  }> = [
    {
      name: "delivery id",
      staging: completed("other-delivery", "lease-a"),
      reclaim: processing("d-structural", "lease-a"),
    },
    {
      name: "lease id",
      staging: completed("d-structural", "lease-a"),
      reclaim: processing("d-structural", "lease-b"),
    },
    {
      name: "statuses",
      staging: processing("d-structural", "lease-a"),
      reclaim: processing("d-structural", "lease-a"),
    },
    {
      name: "claimed timestamp",
      staging: completed("d-structural", "lease-a"),
      reclaim: {
        ...processing("d-structural", "lease-a"),
        claimedAt: "2026-08-09T11:00:00.001Z",
      },
    },
    {
      name: "canonical timestamps",
      staging: {
        ...completed("d-structural", "lease-a"),
        completedAt: "2026-08-09 11:00:01",
      },
      reclaim: processing("d-structural", "lease-a"),
    },
    {
      name: "timestamp order",
      staging: {
        ...completed("d-structural", "lease-a"),
        completedAt: "2026-08-09T10:59:59.000Z",
      },
      reclaim: processing("d-structural", "lease-a"),
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-structural-"));
      const deliveries = path.join(root, "deliveries");
      await mkdir(deliveries);
      const canonical = path.join(deliveries, "d-structural.json");
      const staging = `${canonical}.staging.attempt`;
      const reclaim = `${canonical}.reclaim.attempt`;
      await writeRecord(staging, fixture.staging);
      await writeRecord(reclaim, fixture.reclaim);

      const claim = await new GitHubDeliveryStore(root).claim(
        "d-structural",
        Date.parse(CLAIMED_AT),
      );

      assert.equal(claim.claimed, true);
      assert.notEqual(claim.leaseId, "lease-a");
      assert.equal(JSON.parse(await readFile(canonical, "utf8")).status, "processing");
      await access(staging);
      await access(reclaim);
    });
  }
});
