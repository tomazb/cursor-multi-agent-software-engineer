import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitHubDeliveryStore } from "../src/github/delivery-store.ts";

test("expired owner cannot complete a reclaimed successor claim", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-lease-"));
  const events: string[] = [];
  const store = new GitHubDeliveryStore(root, {
    // Long TTL; reclaim only via explicit aged claimedAt rewrite.
    staleProcessingMs: 60_000,
    onStaleReclaim: (deliveryId) => events.push(`reclaim:${deliveryId}`),
    onOwnerMismatch: (op, deliveryId) => events.push(`mismatch:${op}:${deliveryId}`),
  });

  const first = await store.claim("d-lease");
  assert.equal(first.claimed, true);
  assert.ok(first.leaseId);

  await writeFile(
    path.join(root, "deliveries", "d-lease.json"),
    `${JSON.stringify({
      deliveryId: "d-lease",
      status: "processing",
      leaseId: first.leaseId,
      claimedAt: new Date(Date.now() - 120_000).toISOString(),
    })}\n`,
  );

  const successor = await store.claim("d-lease");
  assert.equal(successor.claimed, true);
  assert.ok(successor.leaseId);
  assert.notEqual(successor.leaseId, first.leaseId);
  assert.ok(events.some((e) => e.startsWith("reclaim:")));
  assert.equal(store.diagnostics().staleReclaims, 1);

  const staleComplete = await store.complete("d-lease", first.leaseId!);
  assert.equal(staleComplete.ok, false);
  assert.equal(staleComplete.reason, "owner_mismatch");
  assert.ok(events.some((e) => e === "mismatch:complete:d-lease"));
  assert.equal(store.diagnostics().ownerMismatchAttempts, 1);

  const stillProcessing = await store.claim("d-lease");
  assert.equal(stillProcessing.claimed, false);
  assert.equal(stillProcessing.duplicate, true);
  assert.equal(stillProcessing.status, "processing");

  const staleFail = await store.fail("d-lease", "late", first.leaseId!);
  assert.equal(staleFail.ok, false);
  assert.equal(staleFail.reason, "owner_mismatch");
  assert.equal(store.diagnostics().ownerMismatchAttempts, 2);

  const afterStaleFail = await store.claim("d-lease");
  assert.equal(afterStaleFail.status, "processing");

  const ok = await store.complete("d-lease", successor.leaseId!);
  assert.equal(ok.ok, true);
  const replay = await store.claim("d-lease");
  assert.equal(replay.status, "completed");
});
