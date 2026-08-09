import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitHubDeliveryStore } from "../src/github/delivery-store.ts";

test("a crash after durable completion staging recovers completed without redispatch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-stage-crash-"));
  let stagedPath: string | undefined;
  let injectCrash = true;
  const store = new GitHubDeliveryStore(root, {
    staleProcessingMs: 60_000,
    afterCompletionStaged: async (filePath, stagingPath) => {
      if (!injectCrash) return;
      injectCrash = false;
      stagedPath = stagingPath;
      const staged = JSON.parse(await readFile(stagingPath, "utf8")) as {
        deliveryId: string;
        status: string;
        leaseId: string;
        claimedAt: string;
        completedAt?: string;
      };
      const canonical = JSON.parse(await readFile(filePath, "utf8")) as {
        status: string;
        leaseId: string;
      };
      assert.equal(staged.deliveryId, "d-stage-crash");
      assert.equal(staged.status, "completed");
      assert.equal(typeof staged.completedAt, "string");
      assert.equal(canonical.status, "processing");
      assert.equal(canonical.leaseId, staged.leaseId);
      throw new Error("simulated crash after durable staging");
    },
  });

  const first = await store.claim("d-stage-crash");
  assert.ok(first.leaseId);
  await assert.rejects(
    () => store.complete("d-stage-crash", first.leaseId!),
    /simulated crash/,
  );
  assert.ok(stagedPath);
  await access(stagedPath);

  const retry = await store.claim("d-stage-crash");
  assert.equal(retry.claimed, false);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.status, "completed");
  const canonical = JSON.parse(
    await readFile(path.join(root, "deliveries", "d-stage-crash.json"), "utf8"),
  ) as { status: string; leaseId: string };
  assert.equal(canonical.status, "completed");
  assert.equal(canonical.leaseId, first.leaseId);
});
