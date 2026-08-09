import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitHubSideEffectStore } from "../src/github/side-effect-store.ts";

test("check-create lock reclaim succeeds for confirmed-dead owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-create-lock-"));
  const store = new GitHubSideEffectStore(root);
  const key = "owner/repo/1/sha/check/1";
  const lockDir = path.join(root, "side-effect-create-locks");
  await mkdir(lockDir, { recursive: true });
  const lockName = `${createHash("sha256").update(key).digest("hex")}.json.lock`;
  await writeFile(
    path.join(lockDir, lockName),
    `${JSON.stringify({ pid: 999_999_999, token: "dead-owner", at: new Date().toISOString() })}\n`,
  );

  let ran = false;
  await store.withCreateLock(key, async () => {
    ran = true;
  }, { timeoutMs: 500 });
  assert.equal(ran, true);
});
