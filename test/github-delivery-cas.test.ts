import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitHubDeliveryStore } from "../src/github/delivery-store.ts";

function successor(deliveryId: string): string {
  return `${JSON.stringify({
    deliveryId,
    status: "processing",
    leaseId: "successor-lease",
    claimedAt: new Date().toISOString(),
  })}\n`;
}

test("complete is atomic against a successor inserted after lease check", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-cas-complete-"));
  let inject = false;
  const store = new GitHubDeliveryStore(root, {
    staleProcessingMs: 60_000,
    afterLeaseValidated: async (op) => {
      if (op !== "complete" || !inject) return;
      inject = false;
      await writeFile(path.join(root, "deliveries", "d1.json"), successor("d1"));
    },
  });

  const first = await store.claim("d1");
  assert.ok(first.leaseId);
  inject = true;
  const result = await store.complete("d1", first.leaseId!);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "owner_mismatch");

  const parsed = JSON.parse(await readFile(path.join(root, "deliveries", "d1.json"), "utf8")) as {
    leaseId: string;
    status: string;
  };
  assert.equal(parsed.leaseId, "successor-lease");
  assert.equal(parsed.status, "processing");
});

test("complete is atomic against a successor inserted after path move", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-cas-complete-move-"));
  let inject = false;
  const store = new GitHubDeliveryStore(root, {
    staleProcessingMs: 60_000,
    afterPathMoved: async (filePath) => {
      if (!inject) return;
      inject = false;
      await writeFile(filePath, successor("d1b"));
    },
  });

  const first = await store.claim("d1b");
  assert.ok(first.leaseId);
  inject = true;
  const result = await store.complete("d1b", first.leaseId!);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "owner_mismatch");
  assert.equal(
    JSON.parse(await readFile(path.join(root, "deliveries", "d1b.json"), "utf8")).leaseId,
    "successor-lease",
  );
});

test("fail leaves a successor intact when inserted after path move", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-cas-fail-move-"));
  let inject = false;
  const store = new GitHubDeliveryStore(root, {
    staleProcessingMs: 60_000,
    afterPathMoved: async (filePath) => {
      if (!inject) return;
      inject = false;
      await writeFile(filePath, successor("d2"));
    },
  });

  const first = await store.claim("d2");
  assert.ok(first.leaseId);
  inject = true;
  await store.fail("d2", "late", first.leaseId!);
  assert.equal(
    JSON.parse(await readFile(path.join(root, "deliveries", "d2.json"), "utf8")).leaseId,
    "successor-lease",
  );
});

test("complete keeps a successor ledger when install loses the wx race", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-cas-restore-file-"));
  let inject = false;
  const store = new GitHubDeliveryStore(root, {
    staleProcessingMs: 60_000,
    beforeInstall: async (filePath) => {
      if (!inject) return;
      inject = false;
      await writeFile(filePath, successor("d4"));
    },
  });

  const first = await store.claim("d4");
  assert.ok(first.leaseId);
  inject = true;
  const result = await store.complete("d4", first.leaseId!);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "owner_mismatch");

  const raw = await readFile(path.join(root, "deliveries", "d4.json"), "utf8");
  assert.equal(JSON.parse(raw).leaseId, "successor-lease");
  const again = await store.claim("d4");
  assert.equal(again.claimed, false);
  assert.equal(again.status, "processing");
});

test("complete restores the processing record when install fails without a successor", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-cas-restore-throw-"));
  let inject = false;
  const store = new GitHubDeliveryStore(root, {
    staleProcessingMs: 60_000,
    beforeInstall: async () => {
      if (!inject) return;
      inject = false;
      throw new Error("injected install failure");
    },
  });

  const first = await store.claim("d5");
  assert.ok(first.leaseId);
  inject = true;
  const result = await store.complete("d5", first.leaseId!);
  assert.equal(result.ok, false);

  const raw = await readFile(path.join(root, "deliveries", "d5.json"), "utf8");
  assert.equal(JSON.parse(raw).leaseId, first.leaseId);
  assert.equal(JSON.parse(raw).status, "processing");
});
