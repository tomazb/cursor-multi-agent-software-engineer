import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  processAliveConservative,
  processDefinitelyDead,
  reclaimDeadOwnerLock,
  unlinkIfBytesMatch,
} from "../src/github/lock-ownership.ts";

test("processDefinitelyDead is true only for ESRCH", () => {
  const original = process.kill;
  const cases: Array<{ code: string; dead: boolean }> = [
    { code: "ESRCH", dead: true },
    { code: "EPERM", dead: false },
    { code: "EINVAL", dead: false },
    { code: "EAGAIN", dead: false },
  ];
  for (const { code, dead } of cases) {
    (process as { kill: typeof process.kill }).kill = ((pid: number, signal?: number | string) => {
      if (signal === 0) {
        const err = new Error(code) as NodeJS.ErrnoException;
        err.code = code;
        throw err;
      }
      return original.call(process, pid, signal as Parameters<typeof process.kill>[1]);
    }) as typeof process.kill;
    try {
      assert.equal(processDefinitelyDead(12345), dead, code);
      assert.equal(processAliveConservative(12345), !dead, code);
    } finally {
      process.kill = original;
    }
  }
});

test("unlinkIfBytesMatch never deletes a successor written after path move", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-unlink-move-"));
  const lockPath = path.join(root, "lock");
  const expected = `${JSON.stringify({ pid: 999_999_999, token: "dead" })}\n`;
  const live = `${JSON.stringify({ pid: process.pid, token: "live-successor" })}\n`;
  await writeFile(lockPath, expected);

  await unlinkIfBytesMatch(lockPath, expected, {
    afterPathMoved: async (filePath) => {
      await writeFile(filePath, live);
    },
  });
  assert.equal(await readFile(lockPath, "utf8"), live);
});

test("reclaimDeadOwnerLock does not reclaim malformed locks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-reclaim-malformed-"));
  const lockPath = path.join(root, "lock");
  await writeFile(lockPath, "not-json{");
  assert.equal(await reclaimDeadOwnerLock(lockPath), false);
  assert.equal(await readFile(lockPath, "utf8"), "not-json{");
});

test("reclaimDeadOwnerLock does not delete a successor inserted before path move", async () => {
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

test("reclaimDeadOwnerLock does not delete a successor inserted after path move", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-reclaim-after-move-"));
  const lockPath = path.join(root, "lock");
  const dead = `${JSON.stringify({ pid: 999_999_999, token: "dead", at: new Date().toISOString() })}\n`;
  const live = `${JSON.stringify({ pid: process.pid, token: "live-successor", at: new Date().toISOString() })}\n`;
  await writeFile(lockPath, dead);

  await reclaimDeadOwnerLock(lockPath, {
    afterPathMoved: async (filePath) => {
      await writeFile(filePath, live);
    },
  });
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
