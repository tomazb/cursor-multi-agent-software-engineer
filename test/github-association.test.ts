import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { GitHubAssociationIndex } from "../src/github/association.ts";
import { FileRunStore } from "../src/store.ts";

test("association index binds and finds a run by repository and PR", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-assoc-"));
  const store = new FileRunStore(cwd);
  const run = await store.create("assoc", "request", DEFAULT_CONFIG);
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));

  await index.bind({
    runId: run.id,
    installationId: 10,
    repository: "owner/repo",
    pullRequestNumber: 3,
    baseSha: "base",
    headSha: "head",
    branch: "maswe/x",
  });

  const found = await index.find("owner/repo", 3);
  assert.equal(found?.runId, run.id);
  assert.equal(found?.suspended, false);
});

test("association index suspends all entries for an installation", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-suspend-"));
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await index.bind({
    runId: "run-a",
    installationId: 77,
    repository: "owner/repo",
    pullRequestNumber: 1,
    baseSha: "b",
    headSha: "h",
    branch: "feature",
  });
  await index.bind({
    runId: "run-b",
    installationId: 88,
    repository: "owner/other",
    pullRequestNumber: 2,
    baseSha: "b",
    headSha: "h",
    branch: "feature",
  });

  await index.suspendInstallation(77);
  assert.equal((await index.find("owner/repo", 1))?.suspended, true);
  assert.equal((await index.find("owner/other", 2))?.suspended, false);
});

test("association index finds all non-suspended branch associations in PR order", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-branch-assoc-"));
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await index.bind({
    runId: "run-five",
    installationId: 10,
    repository: "owner/repo",
    pullRequestNumber: 5,
    baseSha: "base",
    headSha: "head-five",
    branch: "maswe/shared",
  });
  await index.bind({
    runId: "run-two",
    installationId: 10,
    repository: "owner/repo",
    pullRequestNumber: 2,
    baseSha: "base",
    headSha: "head-two",
    branch: "maswe/shared",
  });
  await index.bind({
    runId: "run-suspended",
    installationId: 10,
    repository: "owner/repo",
    pullRequestNumber: 7,
    baseSha: "base",
    headSha: "head-suspended",
    branch: "maswe/shared",
    suspended: true,
  });

  const matches = await index.findAllByRepositoryBranch("owner/repo", "maswe/shared");

  assert.deepEqual(
    matches.map((record) => [record.pullRequestNumber, record.runId]),
    [
      [2, "run-two"],
      [5, "run-five"],
    ],
  );
  const firstMatch = matches[0];
  assert.ok(firstMatch);
  firstMatch.headSha = "mutated-snapshot";
  assert.equal((await index.find("owner/repo", 2))?.headSha, "head-two");
});
