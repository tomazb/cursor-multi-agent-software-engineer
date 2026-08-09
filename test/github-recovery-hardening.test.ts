import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  compareAndSwapFile,
  recoverCompareAndSwapArtifacts,
} from "../src/github/lock-ownership.ts";
import { GitHubDeliveryStore } from "../src/github/delivery-store.ts";

test("recovery does not delete staging when canonical is truncated", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-trunc-"));
  const filePath = path.join(root, "d.json");
  const staging = `${JSON.stringify({
    deliveryId: "d",
    status: "completed",
    leaseId: "L1",
    claimedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  })}\n`;
  const reclaim = `${JSON.stringify({
    deliveryId: "d",
    status: "processing",
    leaseId: "L1",
    claimedAt: new Date().toISOString(),
  })}\n`;
  const attempt = "attempt1";
  await writeFile(`${filePath}.staging.${attempt}`, staging);
  await writeFile(`${filePath}.reclaim.${attempt}`, reclaim);
  await writeFile(filePath, '{"status":"com'); // truncated

  const recovered = await recoverCompareAndSwapArtifacts(filePath);
  assert.equal(recovered.kind, "installed");
  assert.equal(JSON.parse(recovered.raw).status, "completed");
  assert.equal(JSON.parse(await readFile(filePath, "utf8")).status, "completed");
});

test("delivery claim recovers truncated canonical via staging", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-trunc-claim-"));
  const store = new GitHubDeliveryStore(root, { staleProcessingMs: 60_000 });
  const first = await store.claim("d-trunc");
  assert.ok(first.leaseId);
  const canonical = path.join(root, "deliveries", "d-trunc.json");
  const processing = await readFile(canonical, "utf8");
  const completed = `${JSON.stringify({
    ...JSON.parse(processing),
    status: "completed",
    completedAt: new Date().toISOString(),
  })}\n`;
  const attempt = "a1";
  await writeFile(`${canonical}.staging.${attempt}`, completed);
  await writeFile(`${canonical}.reclaim.${attempt}`, processing);
  await writeFile(canonical, '{"incomplete":');

  const again = await store.claim("d-trunc");
  assert.equal(again.claimed, false);
  assert.equal(again.status, "completed");
  assert.equal(JSON.parse(await readFile(canonical, "utf8")).leaseId, first.leaseId);
});

test("crash after staging before move finishes as completed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-stage-only-"));
  const store = new GitHubDeliveryStore(root, { staleProcessingMs: 60_000 });
  const first = await store.claim("d-stage");
  assert.ok(first.leaseId);
  const canonical = path.join(root, "deliveries", "d-stage.json");
  const processing = await readFile(canonical, "utf8");
  const completed = `${JSON.stringify({
    ...JSON.parse(processing),
    status: "completed",
    completedAt: new Date().toISOString(),
  })}\n`;
  await writeFile(`${canonical}.staging.only`, completed);

  const again = await store.claim("d-stage");
  assert.equal(again.claimed, false);
  assert.equal(again.status, "completed");
  assert.equal(JSON.parse(await readFile(canonical, "utf8")).status, "completed");
  assert.equal(JSON.parse(await readFile(canonical, "utf8")).leaseId, first.leaseId);
});

test("compareAndSwapFile uses attempt-scoped artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-attempt-"));
  const filePath = path.join(root, "d.json");
  const expected = `${JSON.stringify({ leaseId: "A", status: "processing" })}\n`;
  await writeFile(filePath, expected);
  let seenReclaim: string | undefined;
  const ok = await compareAndSwapFile(
    filePath,
    expected,
    `${JSON.stringify({ leaseId: "A", status: "completed" })}\n`,
    {
      afterPathMoved: async (_canonical, reclaimPath) => {
        seenReclaim = reclaimPath;
        const entries = await readdir(path.dirname(filePath));
        assert.ok(entries.some((e) => e.includes(".staging.")));
      },
    },
  );
  assert.equal(ok, true);
  assert.ok(seenReclaim?.includes(".reclaim."));
  assert.notEqual(seenReclaim, `${filePath}.reclaim`);
});
