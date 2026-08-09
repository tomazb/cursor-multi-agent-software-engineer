import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  processAliveConservative,
  reclaimDeadOwnerLock,
} from "../src/github/lock-ownership.ts";
import { GitHubSideEffectStore } from "../src/github/side-effect-store.ts";
import { GitHubAssociationIndex } from "../src/github/association.ts";

test("processAliveConservative treats EPERM as alive", () => {
  const original = process.kill;
  (process as { kill: typeof process.kill }).kill = ((pid: number, signal?: number | string) => {
    if (signal === 0) {
      const err = new Error("EPERM") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    }
    return original.call(process, pid, signal as Parameters<typeof process.kill>[1]);
  }) as typeof process.kill;
  try {
    assert.equal(processAliveConservative(12345), true);
  } finally {
    process.kill = original;
  }
});

test("processAliveConservative treats ESRCH as dead", () => {
  const original = process.kill;
  (process as { kill: typeof process.kill }).kill = ((pid: number, signal?: number | string) => {
    if (signal === 0) {
      const err = new Error("ESRCH") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    }
    return original.call(process, pid, signal as Parameters<typeof process.kill>[1]);
  }) as typeof process.kill;
  try {
    assert.equal(processAliveConservative(12345), false);
  } finally {
    process.kill = original;
  }
});

test("reclaimDeadOwnerLock does not delete a successor inserted after the dead check", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-reclaim-race-"));
  const lockPath = path.join(root, "lock");
  const dead = `${JSON.stringify({ pid: 999_999_999, token: "dead", at: new Date().toISOString() })}\n`;
  const live = `${JSON.stringify({ pid: process.pid, token: "live-successor", at: new Date().toISOString() })}\n`;
  await writeFile(lockPath, dead);

  const reclaimed = await reclaimDeadOwnerLock(lockPath, {
    afterDeadConfirmed: async () => {
      await writeFile(lockPath, live);
    },
  });
  assert.equal(reclaimed, false);
  assert.equal(await readFile(lockPath, "utf8"), live);
});

test("reclaimDeadOwnerLock does not delete on non-ENOENT read failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-reclaim-err-"));
  const lockPath = path.join(root, "lock-as-dir");
  await mkdir(lockPath);
  const reclaimed = await reclaimDeadOwnerLock(lockPath);
  assert.equal(reclaimed, false);
  const { stat } = await import("node:fs/promises");
  assert.equal((await stat(lockPath)).isDirectory(), true);
});

test("create-lock reclaim preserves successor inserted after dead check", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-create-race-"));
  const store = new GitHubSideEffectStore(root, {
    afterDeadConfirmed: async (lockPath) => {
      await writeFile(
        lockPath,
        `${JSON.stringify({ pid: process.pid, token: "live", at: new Date().toISOString() })}\n`,
      );
    },
  });
  const key = "k";
  const lockDir = path.join(root, "side-effect-create-locks");
  await mkdir(lockDir, { recursive: true });
  const lockName = `${createHash("sha256").update(key).digest("hex")}.json.lock`;
  await writeFile(
    path.join(lockDir, lockName),
    `${JSON.stringify({ pid: 999_999_999, token: "dead", at: new Date().toISOString() })}\n`,
  );

  await assert.rejects(
    () => store.withCreateLock(key, async () => {}, { timeoutMs: 200 }),
    /Timed out acquiring check-create lock/,
  );
  const raw = await readFile(path.join(lockDir, lockName), "utf8");
  assert.match(raw, /live/);
});

test("association reclaim preserves successor inserted after dead check", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-assoc-race-"));
  const index = new GitHubAssociationIndex(root, {
    afterDeadConfirmed: async (lockPath) => {
      await writeFile(
        lockPath,
        `${JSON.stringify({ pid: process.pid, token: "live", at: new Date().toISOString() })}\n`,
      );
    },
  });
  await writeFile(
    path.join(root, "associations.lock"),
    `${JSON.stringify({ pid: 999_999_999, token: "dead", at: new Date().toISOString() })}\n`,
  );

  await assert.rejects(
    () =>
      index.bind({
        runId: "x",
        installationId: 1,
        repository: "owner/repo",
        pullRequestNumber: 1,
        baseSha: "b",
        headSha: "h",
        branch: "b",
      }),
    /Timed out acquiring GitHub association index lock/,
  );
  assert.match(await readFile(path.join(root, "associations.lock"), "utf8"), /live/);
});
