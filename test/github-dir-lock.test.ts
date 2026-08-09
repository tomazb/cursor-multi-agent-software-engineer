import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withDirLock } from "../src/github/lock-ownership.ts";
import { GitHubSideEffectStore } from "../src/github/side-effect-store.ts";
import { GitHubAssociationIndex } from "../src/github/association.ts";
import { createHash } from "node:crypto";

test("dir lock does not create an absence window against a live owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-dir-live-"));
  const lockDir = path.join(root, "lock.d");
  let contenderEntered = false;

  const holder = withDirLock(lockDir, async () => {
    await assert.rejects(
      () =>
        withDirLock(
          lockDir,
          async () => {
            contenderEntered = true;
          },
          { timeoutMs: 150 },
        ),
      /Timed out/,
    );
  });

  await holder;
  assert.equal(contenderEntered, false);
});

test("dir lock reclaim aborts if owner metadata changes after death check", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-dir-race-"));
  const lockDir = path.join(root, "lock.d");
  await mkdir(lockDir);
  await writeFile(
    path.join(lockDir, "owner.json"),
    `${JSON.stringify({ pid: 999_999_999, token: "dead", at: new Date().toISOString() })}\n`,
  );

  let entered = false;
  await assert.rejects(
    () =>
      withDirLock(
        lockDir,
        async () => {
          entered = true;
        },
        {
          timeoutMs: 200,
          afterDeadConfirmed: async (dir) => {
            await writeFile(
              path.join(dir, "owner.json"),
              `${JSON.stringify({ pid: process.pid, token: "live", at: new Date().toISOString() })}\n`,
            );
          },
        },
      ),
    /Timed out/,
  );
  assert.equal(entered, false);
  assert.match(await readFile(path.join(lockDir, "owner.json"), "utf8"), /live/);
});

test("create-lock uses dir locks and preserves live successor metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-create-dir-"));
  const key = "k";
  const lockName = `${createHash("sha256").update(key).digest("hex")}.json.lock`;
  const lockDir = path.join(root, "side-effect-create-locks", lockName);
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    path.join(lockDir, "owner.json"),
    `${JSON.stringify({ pid: 999_999_999, token: "dead", at: new Date().toISOString() })}\n`,
  );

  const store = new GitHubSideEffectStore(root, {
    afterDeadConfirmed: async (dir) => {
      await writeFile(
        path.join(dir, "owner.json"),
        `${JSON.stringify({ pid: process.pid, token: "live", at: new Date().toISOString() })}\n`,
      );
    },
  });

  let entered = false;
  await assert.rejects(
    () =>
      store.withCreateLock(
        key,
        async () => {
          entered = true;
        },
        { timeoutMs: 200 },
      ),
    /Timed out/,
  );
  assert.equal(entered, false);
  assert.match(await readFile(path.join(lockDir, "owner.json"), "utf8"), /live/);
});

test("association dir lock does not mutate index over live successor metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-assoc-dir-"));
  const lockDir = path.join(root, "associations.lock");
  await mkdir(lockDir);
  await writeFile(
    path.join(lockDir, "owner.json"),
    `${JSON.stringify({ pid: 999_999_999, token: "dead", at: new Date().toISOString() })}\n`,
  );

  const index = new GitHubAssociationIndex(root, {
    afterDeadConfirmed: async (dir) => {
      await writeFile(
        path.join(dir, "owner.json"),
        `${JSON.stringify({ pid: process.pid, token: "live", at: new Date().toISOString() })}\n`,
      );
    },
  });

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
    /Timed out/,
  );
  assert.equal(await index.find("owner/repo", 1), undefined);
  assert.match(await readFile(path.join(lockDir, "owner.json"), "utf8"), /live/);
});
