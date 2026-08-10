import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { GitHubAssociationIndex } from "../src/github/association.ts";
import { GitHubSideEffectStore } from "../src/github/side-effect-store.ts";
import { FileRunStore } from "../src/store.ts";

function sideEffectPath(root: string, key: string): string {
  const digest = createHash("sha256").update(key).digest("hex");
  return path.join(root, "side-effects", `${digest}.json`);
}

function associationRecord() {
  return {
    runId: "run-hostile",
    installationId: 1,
    repository: "owner/repo",
    pullRequestNumber: 1,
    baseSha: "base",
    headSha: "head",
    branch: "feature",
    suspended: false,
    updatedAt: "2026-08-10T00:00:00.000Z",
  };
}

test("association reads reject a symlinked authoritative index", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-association-symlink-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const outside = path.join(root, "outside.json");
  await writeFile(
    outside,
    `${JSON.stringify({ "owner/repo#1": associationRecord() })}\n`,
    "utf8",
  );
  const githubRoot = path.join(root, "github");
  await mkdir(githubRoot);
  await symlink(outside, path.join(githubRoot, "associations.json"));

  await assert.rejects(
    new GitHubAssociationIndex(githubRoot).find("owner/repo", 1),
    /ordinary|symbolic|unsafe/i,
  );
});

test("association reads reject an oversized authoritative index", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-association-oversized-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const githubRoot = path.join(root, "github");
  await mkdir(githubRoot);
  await writeFile(path.join(githubRoot, "associations.json"), Buffer.alloc(1_048_577, 0x20));

  await assert.rejects(
    new GitHubAssociationIndex(githubRoot).find("owner/repo", 1),
    /bounded|too large|ordinary/i,
  );
});

test("side-effect reads reject symlinks and non-exact persisted identity", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-side-effect-hostile-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const key = "check-run:owner/repo/1/head/check/1";
  const directory = path.join(root, "side-effects");
  await mkdir(directory);
  const outside = path.join(root, "outside.json");
  await writeFile(
    outside,
    `${JSON.stringify({ idempotencyKey: key, resourceId: 999, kind: "check-run" })}\n`,
    "utf8",
  );
  await symlink(outside, sideEffectPath(root, key));
  await assert.rejects(new GitHubSideEffectStore(root).get(key), /ordinary|symbolic|unsafe/i);
  await rm(sideEffectPath(root, key));

  for (const record of [
    { idempotencyKey: "different-key", resourceId: 1, kind: "check-run" },
    { idempotencyKey: key, resourceId: 0, kind: "check-run" },
    { idempotencyKey: key, resourceId: 1.5, kind: "check-run" },
    { idempotencyKey: key, resourceId: 1, kind: "issue" },
    { idempotencyKey: key, resourceId: 1, kind: "check-run", token: "secret" },
  ]) {
    await writeFile(sideEffectPath(root, key), `${JSON.stringify(record)}\n`, "utf8");
    await assert.rejects(
      new GitHubSideEffectStore(root).get(key),
      /invalid GitHub side-effect record/i,
      JSON.stringify(record),
    );
  }

  await writeFile(sideEffectPath(root, key), Buffer.alloc(1_048_577, 0x20));
  await assert.rejects(
    new GitHubSideEffectStore(root).get(key),
    /bounded|too large|ordinary/i,
  );
});

test("side-effect writes reject a symlinked namespace without mutating its target", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-side-effect-namespace-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(root, "side-effects"));

  await assert.rejects(
    new GitHubSideEffectStore(root).put("hostile-key", { resourceId: 1, kind: "check-run" }),
    /ordinary|symbolic|unsafe/i,
  );
  assert.deepEqual(await readdir(outside), []);
});

test("authoritative atomic writes surface file and parent-directory sync failures", async (t) => {
  for (const failure of ["file", "directory"] as const) {
    await t.test(`side-effect ${failure} sync`, async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), `maswe-gh-side-sync-${failure}-`));
      t.after(async () => rm(root, { recursive: true, force: true }));
      const fail = async () => { throw new Error(`simulated ${failure} sync failure`); };
      const store = new GitHubSideEffectStore(root, {
        ...(failure === "file" ? { syncFile: fail } : { syncDirectory: fail }),
      } as never);
      await assert.rejects(
        store.put("sync-key", { resourceId: 1, kind: "check-run" }),
        new RegExp(`${failure} sync failure`),
      );
    });

    await t.test(`association ${failure} sync`, async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), `maswe-gh-association-sync-${failure}-`));
      t.after(async () => rm(root, { recursive: true, force: true }));
      const fail = async () => { throw new Error(`simulated ${failure} sync failure`); };
      const index = new GitHubAssociationIndex(root, {
        ...(failure === "file" ? { syncFile: fail } : { syncDirectory: fail }),
      } as never);
      await assert.rejects(index.bind(associationRecord()), new RegExp(`${failure} sync failure`));
    });

    await t.test(`run ${failure} sync`, async (t) => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), `maswe-run-sync-${failure}-`));
      t.after(async () => rm(cwd, { recursive: true, force: true }));
      const fail = async () => { throw new Error(`simulated ${failure} sync failure`); };
      const store = new FileRunStore(cwd, {
        ...(failure === "file" ? { syncFile: fail } : { syncDirectory: fail }),
      } as never);
      await assert.rejects(
        store.create("sync", "failure", DEFAULT_CONFIG),
        new RegExp(`${failure} sync failure`),
      );
    });
  }
});
