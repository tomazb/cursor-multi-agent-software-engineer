import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitHubAssociationIndex } from "../src/github/association.ts";

test("association lock does not reclaim a live owner based on age alone", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-assoc-age-"));
  const index = new GitHubAssociationIndex(root, { lockStaleMs: 1 });
  // Hold the directory lock by creating it with this process as owner.
  const lockDir = path.join(root, "associations.lock");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(lockDir);
  await writeFile(
    path.join(lockDir, "owner.json"),
    `${JSON.stringify({
      pid: process.pid,
      token: "live-owner",
      at: new Date(Date.now() - 60_000).toISOString(),
    })}\n`,
  );

  await assert.rejects(
    () =>
      index.bind({
        runId: "should-not",
        installationId: 1,
        repository: "owner/repo",
        pullRequestNumber: 1,
        baseSha: "b",
        headSha: "h",
        branch: "x",
      }),
    /Timed out acquiring directory lock/,
  );
});

test("association lock release is identity-bound", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-assoc-id-"));
  const index = new GitHubAssociationIndex(root);
  const locked = index as unknown as {
    withLock: <T>(fn: () => Promise<T>) => Promise<T>;
  };

  await locked.withLock(async () => {
    const { mkdir, rm } = await import("node:fs/promises");
    // Replace our lock directory with a successor owner while we still hold work.
    await rm(path.join(root, "associations.lock"), { recursive: true, force: true });
    await mkdir(path.join(root, "associations.lock"));
    await writeFile(
      path.join(root, "associations.lock", "owner.json"),
      `${JSON.stringify({
        pid: process.pid,
        token: "successor-token",
        at: new Date().toISOString(),
      })}\n`,
    );
  });

  const raw = await readFile(path.join(root, "associations.lock", "owner.json"), "utf8");
  assert.match(raw, /successor-token/);
});
