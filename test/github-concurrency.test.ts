import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { CheckPublisher, type GitHubHttpClient } from "../src/github/checks.ts";
import { GitHubAssociationIndex } from "../src/github/association.ts";
import { GitHubSideEffectStore } from "../src/github/side-effect-store.ts";
import type { RunRecord } from "../src/domain.ts";

function emptyRun(): RunRecord {
  return {
    schemaVersion: 1,
    version: 1,
    id: "run-1",
    title: "t",
    request: "r",
    repositoryPath: "/tmp",
    state: "PR_REVIEW",
    createdAt: "",
    updatedAt: "",
    approvals: { brainstorm: false, design: false },
    counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
    config: DEFAULT_CONFIG,
    artifacts: [],
    events: [],
  };
}

test("concurrent check publishers serialize creates for the same key", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-conc-"));
  const sideEffects = new GitHubSideEffectStore(root);
  let posts = 0;
  let nextId = 1;
  const http: GitHubHttpClient = {
    async request(method, url) {
      if (method === "GET") return { status: 200, headers: {}, body: { check_runs: [] } };
      if (method === "POST" && url.includes("/check-runs")) {
        posts += 1;
        // Yield so the other publisher can race without the lock.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { status: 201, headers: {}, body: { id: nextId++ } };
      }
      if (method === "PATCH") return { status: 200, headers: {}, body: { id: 1 } };
      return { status: 200, headers: {}, body: {} };
    },
  };

  const makePublisher = () =>
    new CheckPublisher({
      http,
      sideEffects,
      readOnlyChecks: true,
      owner: "owner",
      repo: "repo",
      pullRequestNumber: 1,
      token: "token",
      sleepFn: async () => {},
    });

  const run = emptyRun();
  await Promise.all([
    makePublisher().publishForHeadSha(run, "sha"),
    makePublisher().publishForHeadSha(run, "sha"),
  ]);
  // Four checks, each created once despite two concurrent publishers.
  assert.equal(posts, 4);
});

test("association index reclaim abandoned locks and survive concurrent binds", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-assoc-lock-"));
  const index = new GitHubAssociationIndex(root, { lockStaleMs: 1 });
  await writeFile(
    path.join(root, "associations.lock"),
    `${JSON.stringify({ pid: 999_999_999, at: new Date(Date.now() - 60_000).toISOString() })}\n`,
  );

  await Promise.all([
    index.bind({
      runId: "a",
      installationId: 1,
      repository: "owner/repo",
      pullRequestNumber: 1,
      baseSha: "b",
      headSha: "h1",
      branch: "one",
    }),
    index.bind({
      runId: "b",
      installationId: 1,
      repository: "owner/repo",
      pullRequestNumber: 2,
      baseSha: "b",
      headSha: "h2",
      branch: "two",
    }),
  ]);

  assert.equal((await index.find("owner/repo", 1))?.runId, "a");
  assert.equal((await index.find("owner/repo", 2))?.runId, "b");
});
