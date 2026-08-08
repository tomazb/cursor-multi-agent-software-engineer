import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitHubSideEffectStore } from "../src/github/side-effect-store.ts";
import {
  assertReadOnlyChecksMode,
  buildCheckConclusions,
  CheckPublisher,
  type GitHubHttpClient,
} from "../src/github/checks.ts";
import type { RunRecord } from "../src/domain.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

test("side-effect store remembers GitHub resource ids by idempotency key", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-side-"));
  const store = new GitHubSideEffectStore(root);
  const key = "check-run:owner/repo/1/sha/quality/1";
  assert.equal(await store.get(key), undefined);
  await store.put(key, { resourceId: 99, kind: "check-run" });
  assert.deepEqual(await store.get(key), { resourceId: 99, kind: "check-run" });
});

test("read-only mode rejects write side effects", () => {
  assert.doesNotThrow(() => assertReadOnlyChecksMode(true, "checks"));
  assert.throws(() => assertReadOnlyChecksMode(true, "push"), /read-only/i);
  assert.throws(() => assertReadOnlyChecksMode(true, "pull_request_write"), /read-only/i);
  assert.throws(() => assertReadOnlyChecksMode(true, "comment_reply"), /read-only/i);
});

test("buildCheckConclusions binds success only to matching evidence SHA", () => {
  const run = {
    schemaVersion: 1,
    version: 1,
    id: "run-1",
    title: "t",
    request: "r",
    repositoryPath: "/tmp",
    state: "PR_REVIEW",
    createdAt: "",
    updatedAt: "",
    approvals: { brainstorm: true, design: true },
    counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
    config: DEFAULT_CONFIG,
    artifacts: [
      {
        name: "02-brainstorm.md",
        logicalName: "02-brainstorm.md",
        attempt: 1,
        path: "x",
        sha256: "a".repeat(64),
        createdAt: "",
      },
      {
        name: "03-design.md",
        logicalName: "03-design.md",
        attempt: 1,
        path: "x",
        sha256: "b".repeat(64),
        createdAt: "",
      },
    ],
    events: [],
    evidence: {
      quality: { headSha: "sha-good", passed: true, at: "t" },
      verification: { headSha: "sha-good", passed: true, at: "t" },
    },
  } as RunRecord;

  const good = buildCheckConclusions(run, "sha-good");
  assert.equal(good["MASWE / deterministic quality"].conclusion, "success");
  assert.equal(good["MASWE / independent verification"].conclusion, "success");
  assert.equal(good["MASWE / specification compliance"].conclusion, "success");
  assert.equal(good["MASWE / review comments resolved"].conclusion, "neutral");

  const stale = buildCheckConclusions(run, "sha-other");
  assert.equal(stale["MASWE / deterministic quality"].conclusion, "neutral");
  assert.equal(stale["MASWE / independent verification"].conclusion, "neutral");
});

test("CheckPublisher creates checks idempotently and invalidates prior SHA success", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-checks-"));
  const sideEffects = new GitHubSideEffectStore(root);
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  let nextId = 1;
  const http: GitHubHttpClient = {
    async request(method, url, options) {
      calls.push({ method, url, body: options?.body });
      if (method === "POST" && url.includes("/check-runs")) {
        const id = nextId++;
        return { status: 201, headers: {}, body: { id } };
      }
      if (method === "PATCH" && url.includes("/check-runs/")) {
        return { status: 200, headers: {}, body: { id: Number(url.split("/").pop()) } };
      }
      return { status: 200, headers: {}, body: {} };
    },
  };

  const publisher = new CheckPublisher({
    http,
    sideEffects,
    readOnlyChecks: true,
    owner: "owner",
    repo: "repo",
    pullRequestNumber: 1,
    token: "token",
  });

  const run = {
    schemaVersion: 1,
    version: 1,
    id: "run-1",
    title: "t",
    request: "r",
    repositoryPath: "/tmp",
    state: "PR_REVIEW",
    createdAt: "",
    updatedAt: "",
    approvals: { brainstorm: true, design: true },
    counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
    config: DEFAULT_CONFIG,
    artifacts: [],
    events: [],
    evidence: {
      quality: { headSha: "sha1", passed: true, at: "t" },
      verification: { headSha: "sha1", passed: true, at: "t" },
    },
  } as RunRecord;

  const first = await publisher.publishForHeadSha(run, "sha1");
  assert.equal(first.createdOrUpdated.length, 4);
  const postCount = calls.filter((c) => c.method === "POST").length;
  assert.equal(postCount, 4);

  // Idempotent retry: no new POSTs for same SHA/attempt
  await publisher.publishForHeadSha(run, "sha1");
  assert.equal(calls.filter((c) => c.method === "POST").length, 4);

  // New SHA: prior success invalidated via PATCH cancel/neutral, new checks for sha2
  run.evidence = {
    quality: { headSha: "sha2", passed: true, at: "t" },
    verification: { headSha: "sha2", passed: true, at: "t" },
  };
  await publisher.publishForHeadSha(run, "sha2", { previousHeadSha: "sha1" });
  assert.ok(calls.some((c) => c.method === "PATCH"));
  assert.ok(calls.filter((c) => c.method === "POST").length >= 8);
});

test("CheckPublisher surfaces rate limits without recording success", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-rl-"));
  const sideEffects = new GitHubSideEffectStore(root);
  const http: GitHubHttpClient = {
    async request() {
      return {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "9999999999" },
        body: { message: "API rate limit exceeded" },
      };
    },
  };
  const publisher = new CheckPublisher({
    http,
    sideEffects,
    readOnlyChecks: true,
    owner: "owner",
    repo: "repo",
    pullRequestNumber: 1,
    token: "token",
  });
  const run = {
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
  } as RunRecord;

  await assert.rejects(() => publisher.publishForHeadSha(run, "sha"), /rate limit/i);
  assert.equal(await sideEffects.get("check-run:owner/repo/1/sha/MASWE / specification compliance/1"), undefined);
});
