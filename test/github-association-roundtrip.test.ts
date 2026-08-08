import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { FileRunStore } from "../src/store.ts";

test("RunRecord.github association round-trips through FileRunStore", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-github-assoc-"));
  const store = new FileRunStore(cwd);
  const run = await store.create("github assoc", "request", DEFAULT_CONFIG);
  run.github = {
    installationId: 12345,
    repository: "owner/repo",
    pullRequestNumber: 42,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    branch: "maswe/example",
    suspended: false,
  };
  await store.save(run);

  const loaded = await store.load(run.id);
  assert.deepEqual(loaded.github, {
    installationId: 12345,
    repository: "owner/repo",
    pullRequestNumber: 42,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    branch: "maswe/example",
    suspended: false,
  });
});
