import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitHubDeliveryStore } from "../src/github/delivery-store.ts";

test("complete is atomic against a successor inserted after lease check", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-cas-complete-"));
  let inject = false;
  const store = new GitHubDeliveryStore(root, {
    staleProcessingMs: 60_000,
    afterLeaseValidated: async (op) => {
      if (op !== "complete" || !inject) return;
      inject = false;
      const successor = {
        deliveryId: "d1",
        status: "processing",
        leaseId: "successor-lease",
        claimedAt: new Date().toISOString(),
      };
      await writeFile(
        path.join(root, "deliveries", "d1.json"),
        `${JSON.stringify(successor)}\n`,
      );
    },
  });

  const first = await store.claim("d1");
  assert.ok(first.leaseId);
  inject = true;
  const result = await store.complete("d1", first.leaseId!);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "owner_mismatch");

  const raw = await readFile(path.join(root, "deliveries", "d1.json"), "utf8");
  const parsed = JSON.parse(raw) as { leaseId: string; status: string };
  assert.equal(parsed.leaseId, "successor-lease");
  assert.equal(parsed.status, "processing");
});

test("fail is atomic against a successor inserted after lease check", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-cas-fail-"));
  let inject = false;
  const store = new GitHubDeliveryStore(root, {
    staleProcessingMs: 60_000,
    afterLeaseValidated: async (op) => {
      if (op !== "fail" || !inject) return;
      inject = false;
      const successor = {
        deliveryId: "d2",
        status: "processing",
        leaseId: "successor-lease",
        claimedAt: new Date().toISOString(),
      };
      await writeFile(
        path.join(root, "deliveries", "d2.json"),
        `${JSON.stringify(successor)}\n`,
      );
    },
  });

  const first = await store.claim("d2");
  assert.ok(first.leaseId);
  inject = true;
  const result = await store.fail("d2", "late", first.leaseId!);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "owner_mismatch");

  const raw = await readFile(path.join(root, "deliveries", "d2.json"), "utf8");
  assert.equal(JSON.parse(raw).leaseId, "successor-lease");
});
