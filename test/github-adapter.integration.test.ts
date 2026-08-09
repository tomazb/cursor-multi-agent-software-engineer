import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mergeConfigForTest } from "../src/config.ts";
import { GitHubAppAdapter } from "../src/github/adapter.ts";
import type { GitHubHttpClient } from "../src/github/checks.ts";
import { GitHubAssociationIndex } from "../src/github/association.ts";
import { GitHubSideEffectStore } from "../src/github/side-effect-store.ts";
import { FileRunStore } from "../src/store.ts";

const SECRET = "integration-webhook-secret";
const SECRET_ENV = "MASWE_TEST_GITHUB_WEBHOOK_SECRET";

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`;
}

function testConfig() {
  return mergeConfigForTest({
    runtime: { kind: "mock" },
    quality: { commands: [] },
    githubApp: {
      enabled: true,
      readOnlyChecks: true,
      webhookSecretEnv: SECRET_ENV,
      appIdEnv: "MASWE_TEST_GITHUB_APP_ID",
      privateKeyEnv: "MASWE_TEST_GITHUB_APP_PRIVATE_KEY",
      allowedRepositories: ["owner/repo"],
    },
  });
}

async function setup(options: { liveHead?: string } = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-int-"));
  const store = new FileRunStore(cwd);
  const config = testConfig();
  const posts: unknown[] = [];
  const checkRunHeadShas = new Map<number, string>();
  const patches: Array<{ url: string; body: unknown; headSha: string | undefined }> = [];
  const tokens: Array<{ installationId: number; repository: string }> = [];
  let nextId = 1;
  let rateLimitOnce = false;
  let liveHead = options.liveHead;
  let failAll = false;
  const http: GitHubHttpClient = {
    async request(method, url, options) {
      if (failAll) {
        return {
          status: 500,
          headers: {},
          body: { message: "forced failure" },
        };
      }
      if (rateLimitOnce) {
        rateLimitOnce = false;
        return {
          status: 403,
          headers: { "x-ratelimit-remaining": "0" },
          body: { message: "API rate limit exceeded" },
        };
      }
      if (method === "GET" && url.includes("/pulls/")) {
        return {
          status: 200,
          headers: {},
          body: { head: { sha: liveHead ?? "unknown" } },
        };
      }
      if (method === "GET" && url.includes("/check-runs")) {
        return { status: 200, headers: {}, body: { check_runs: [] } };
      }
      if (method === "POST" && url.includes("/check-runs")) {
        posts.push(options?.body);
        const id = nextId++;
        const headSha = (options?.body as { head_sha?: unknown } | undefined)?.head_sha;
        if (typeof headSha === "string") checkRunHeadShas.set(id, headSha);
        return { status: 201, headers: {}, body: { id } };
      }
      if (method === "PATCH") {
        const checkRunId = Number(url.match(/\/check-runs\/(\d+)$/)?.[1]);
        patches.push({
          url,
          body: options?.body,
          headSha: checkRunHeadShas.get(checkRunId),
        });
        return { status: 200, headers: {}, body: { id: 1 } };
      }
      return { status: 200, headers: {}, body: {} };
    },
  };
  const adapter = new GitHubAppAdapter({
    cwd,
    config,
    store,
    http,
    tokenProvider: async (installationId, repository) => {
      tokens.push({ installationId, repository });
      return "test-token";
    },
  });
  return {
    cwd,
    store,
    adapter,
    posts,
    patches,
    tokens,
    setLiveHead(sha: string) {
      liveHead = sha;
    },
    enableRateLimitOnce() {
      rateLimitOnce = true;
    },
    setFailAll(value: boolean) {
      failAll = value;
    },
  };
}

function prPayload(headSha: string, number = 9) {
  return {
    action: "synchronize",
    installation: { id: 44 },
    repository: { full_name: "owner/repo" },
    pull_request: {
      number,
      head: { sha: headSha, ref: "maswe/run-1" },
      base: { sha: "basebase" },
    },
  };
}

test("integration: forged signature makes no state change", async () => {
  process.env[SECRET_ENV] = SECRET;
  const { adapter, posts } = await setup();
  const body = JSON.stringify(prPayload("sha1"));
  const result = await adapter.handleWebhook({
    deliveryId: "del-forged",
    eventName: "pull_request",
    signatureHeader: sign("tampered"),
    rawBody: body,
  });
  assert.equal(result.status, 401);
  assert.equal(posts.length, 0);
});

test("integration: replayed completed delivery does not duplicate checks", async () => {
  process.env[SECRET_ENV] = SECRET;
  const { adapter, posts, store } = await setup({ liveHead: "sha1" });
  const run = await store.create("assoc", "req", testConfig());
  run.workspace = {
    baseSha: "base",
    headSha: "sha1",
    branch: "maswe/run-1",
    fingerprint: "fp",
    remote: "https://github.com/owner/repo.git",
  };
  run.evidence = {
    quality: { headSha: "sha1", passed: true, at: "t" },
    verification: { headSha: "sha1", passed: true, at: "t" },
  };
  await store.save(run);

  const body = JSON.stringify(prPayload("sha1"));
  const first = await adapter.handleWebhook({
    deliveryId: "del-replay",
    eventName: "pull_request",
    signatureHeader: sign(body),
    rawBody: body,
  });
  assert.equal(first.status, 200);
  const postCount = posts.length;
  assert.ok(postCount >= 4);

  const second = await adapter.handleWebhook({
    deliveryId: "del-replay",
    eventName: "pull_request",
    signatureHeader: sign(body),
    rawBody: body,
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(posts.length, postCount);
});

test("integration: failed delivery can be retried with the same id", async () => {
  process.env[SECRET_ENV] = SECRET;
  const { adapter, setFailAll, posts } = await setup({ liveHead: "sha-rl" });
  setFailAll(true);
  const body = JSON.stringify(prPayload("sha-rl"));
  await assert.rejects(
    () =>
      adapter.handleWebhook({
        deliveryId: "del-rl-retry",
        eventName: "pull_request",
        signatureHeader: sign(body),
        rawBody: body,
      }),
    /forced failure|HTTP 500/i,
  );
  setFailAll(false);
  const retry = await adapter.handleWebhook({
    deliveryId: "del-rl-retry",
    eventName: "pull_request",
    signatureHeader: sign(body),
    rawBody: body,
  });
  assert.equal(retry.status, 200);
  assert.ok(posts.length >= 4);
});

test("integration: unassociated PR uses the event installation token", async () => {
  process.env[SECRET_ENV] = SECRET;
  const { adapter, tokens, posts } = await setup({ liveHead: "sha-u" });
  const body = JSON.stringify(prPayload("sha-u"));
  const result = await adapter.handleWebhook({
    deliveryId: "del-unassoc",
    eventName: "pull_request",
    signatureHeader: sign(body),
    rawBody: body,
  });
  assert.equal(result.status, 200);
  assert.ok(tokens.some((t) => t.installationId === 44 && t.repository === "owner/repo"));
  assert.ok(posts.length >= 4);
});

test("integration: new head SHA invalidates prior success conclusions", async () => {
  process.env[SECRET_ENV] = SECRET;
  const { adapter, posts, patches, store, setLiveHead } = await setup({ liveHead: "sha1" });
  const run = await store.create("sha-order", "req", testConfig());
  run.workspace = {
    baseSha: "base",
    headSha: "sha1",
    branch: "maswe/run-1",
    fingerprint: "fp",
    remote: "https://github.com/owner/repo.git",
  };
  run.evidence = {
    quality: { headSha: "sha1", passed: true, at: "t" },
    verification: { headSha: "sha1", passed: true, at: "t" },
  };
  await store.save(run);

  const body1 = JSON.stringify(prPayload("sha1"));
  await adapter.handleWebhook({
    deliveryId: "del-sha1",
    eventName: "pull_request",
    signatureHeader: sign(body1),
    rawBody: body1,
  });

  setLiveHead("sha2");
  const body2 = JSON.stringify(prPayload("sha2"));
  await adapter.handleWebhook({
    deliveryId: "del-sha2",
    eventName: "pull_request",
    signatureHeader: sign(body2),
    rawBody: body2,
  });
  assert.ok(patches.length > 0);
  const sha2Quality = posts.filter(
    (body) =>
      (body as { head_sha?: string; name?: string }).head_sha === "sha2" &&
      (body as { name?: string }).name === "MASWE / deterministic quality",
  );
  assert.ok(sha2Quality.length >= 1);
  assert.equal((sha2Quality[0] as { conclusion: string }).conclusion, "neutral");

  const loaded = await store.load(run.id);
  assert.equal(loaded.evidence?.quality, undefined);
  assert.equal(loaded.github?.headSha, "sha2");
});

test("integration: stale out-of-order head is ignored", async () => {
  process.env[SECRET_ENV] = SECRET;
  const { adapter, store, setLiveHead } = await setup({ liveHead: "sha2" });
  const run = await store.create("stale", "req", testConfig());
  run.workspace = {
    baseSha: "base",
    headSha: "sha1",
    branch: "maswe/run-1",
    fingerprint: "fp",
    remote: "https://github.com/owner/repo.git",
  };
  await store.save(run);

  await adapter.handleWebhook({
    deliveryId: "del-newer",
    eventName: "pull_request",
    signatureHeader: sign(JSON.stringify(prPayload("sha2"))),
    rawBody: JSON.stringify(prPayload("sha2")),
  });
  assert.equal((await store.load(run.id)).github?.headSha, "sha2");

  setLiveHead("sha2");
  await adapter.handleWebhook({
    deliveryId: "del-stale",
    eventName: "pull_request",
    signatureHeader: sign(JSON.stringify(prPayload("sha1"))),
    rawBody: JSON.stringify(prPayload("sha1")),
  });
  assert.equal((await store.load(run.id)).github?.headSha, "sha2");
});

test("integration: installation deletion suspends run records", async () => {
  process.env[SECRET_ENV] = SECRET;
  const { adapter, cwd, store, posts } = await setup();
  const run = await store.create("suspend-me", "req", testConfig());
  run.github = {
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "b",
    headSha: "h",
    branch: "feature",
    suspended: false,
  };
  await store.save(run);
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await index.bind({
    runId: run.id,
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "b",
    headSha: "h",
    branch: "feature",
  });

  const body = JSON.stringify({ action: "deleted", installation: { id: 44 } });
  const result = await adapter.handleWebhook({
    deliveryId: "del-install",
    eventName: "installation",
    signatureHeader: sign(body),
    rawBody: body,
  });
  assert.equal(result.status, 200);
  assert.equal((await index.find("owner/repo", 9))?.suspended, true);
  assert.equal((await store.load(run.id)).github?.suspended, true);

  const syncBody = JSON.stringify(prPayload("sha-after-suspend"));
  const after = await adapter.handleWebhook({
    deliveryId: "del-after-suspend",
    eventName: "pull_request",
    signatureHeader: sign(syncBody),
    rawBody: syncBody,
  });
  assert.equal(after.status, 200);
  assert.equal(posts.length, 0);
});

test("integration: does not steal another PR's associated run", async () => {
  process.env[SECRET_ENV] = SECRET;
  const { adapter, store } = await setup({ liveHead: "other" });
  const run = await store.create("pr-one", "req", testConfig());
  run.github = {
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 1,
    baseSha: "b",
    headSha: "h",
    branch: "maswe/other",
    suspended: false,
  };
  run.workspace = {
    baseSha: "b",
    headSha: "h",
    branch: "maswe/other",
    fingerprint: "fp",
    remote: "https://github.com/owner/repo.git",
  };
  await store.save(run);

  const body = JSON.stringify(prPayload("other", 99));
  await adapter.handleWebhook({
    deliveryId: "del-other-pr",
    eventName: "pull_request",
    signatureHeader: sign(body),
    rawBody: body,
  });
  const loaded = await store.load(run.id);
  assert.equal(loaded.github?.pullRequestNumber, 1);
  assert.equal(loaded.github?.headSha, "h");
});

test("integration: push events invalidate every matching PR association", async () => {
  process.env[SECRET_ENV] = SECRET;
  const { adapter, posts, patches, store, cwd, setLiveHead } = await setup({
    liveHead: "sha-push",
  });
  const firstRun = await store.create("first-push-run", "req", testConfig());
  firstRun.workspace = {
    baseSha: "base",
    headSha: "old-first",
    branch: "maswe/run-1",
    fingerprint: "fp",
    remote: "https://github.com/owner/repo.git",
  };
  firstRun.evidence = {
    quality: { headSha: "old-first", passed: true, at: "t" },
    verification: { headSha: "old-first", passed: true, at: "t" },
  };
  firstRun.github = {
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: "old-first",
    branch: "maswe/run-1",
    suspended: false,
  };
  await store.save(firstRun);

  const secondRun = await store.create("second-push-run", "req", testConfig());
  secondRun.workspace = {
    baseSha: "base",
    headSha: "old-second",
    branch: "maswe/run-1",
    fingerprint: "fp",
    remote: "https://github.com/owner/repo.git",
  };
  secondRun.evidence = {
    quality: { headSha: "old-second", passed: true, at: "t" },
    verification: { headSha: "old-second", passed: true, at: "t" },
  };
  secondRun.github = {
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 10,
    baseSha: "base",
    headSha: "old-second",
    branch: "maswe/run-1",
    suspended: false,
  };
  await store.save(secondRun);

  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await index.bind({
    runId: firstRun.id,
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: "old-first",
    branch: "maswe/run-1",
  });
  await index.bind({
    runId: secondRun.id,
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 10,
    baseSha: "base",
    headSha: "old-second",
    branch: "maswe/run-1",
  });

  await adapter.publishChecksForRun(firstRun.id);
  await adapter.publishChecksForRun(secondRun.id);
  const postCountBeforePush = posts.length;

  setLiveHead("sha-push");
  const body = JSON.stringify({
    ref: "refs/heads/maswe/run-1",
    after: "sha-push",
    installation: { id: 44 },
    repository: { full_name: "owner/repo" },
  });
  const result = await adapter.handleWebhook({
    deliveryId: "del-push",
    eventName: "push",
    signatureHeader: sign(body),
    rawBody: body,
  });
  assert.equal(result.status, 200);
  const loadedFirst = await store.load(firstRun.id);
  const loadedSecond = await store.load(secondRun.id);
  assert.equal(loadedFirst.github?.headSha, "sha-push");
  assert.equal(loadedFirst.evidence?.quality, undefined);
  assert.equal(loadedSecond.github?.headSha, "sha-push");
  assert.equal(loadedSecond.evidence?.quality, undefined);

  assert.equal(patches.filter((patch) => patch.headSha === "old-first").length, 4);
  assert.equal(patches.filter((patch) => patch.headSha === "old-second").length, 4);
  assert.deepEqual(
    patches.map((patch) => (patch.body as { conclusion?: string }).conclusion),
    Array(8).fill("cancelled"),
  );
  assert.equal(
    posts
      .slice(postCountBeforePush)
      .filter((post) => {
        const headSha = (post as { head_sha?: unknown }).head_sha;
        return typeof headSha === "string" && ["old-first", "old-second"].includes(headSha);
      })
      .length,
    0,
  );
});

test("integration: live-head lookup failure fails closed", async () => {
  process.env[SECRET_ENV] = SECRET;
  const { adapter, store, cwd } = await setup({ liveHead: "sha-new" });
  const run = await store.create("fail-closed", "req", testConfig());
  run.workspace = {
    baseSha: "base",
    headSha: "sha-new",
    branch: "maswe/run-1",
    fingerprint: "fp",
    remote: "https://github.com/owner/repo.git",
  };
  await store.save(run);
  await adapter.handleWebhook({
    deliveryId: "del-new-head",
    eventName: "pull_request",
    signatureHeader: sign(JSON.stringify(prPayload("sha-new"))),
    rawBody: JSON.stringify(prPayload("sha-new")),
  });
  assert.equal((await store.load(run.id)).github?.headSha, "sha-new");

  const failingHttp: GitHubHttpClient = {
    async request(method) {
      if (method === "GET") {
        return { status: 500, headers: {}, body: { message: "boom" } };
      }
      return { status: 201, headers: {}, body: { id: 99 } };
    },
  };
  const badAdapter = new GitHubAppAdapter({
    cwd,
    config: testConfig(),
    store,
    http: failingHttp,
    tokenProvider: async () => "token",
  });
  await assert.rejects(
    () =>
      badAdapter.handleWebhook({
        deliveryId: "del-old-after-fail",
        eventName: "pull_request",
        signatureHeader: sign(JSON.stringify(prPayload("sha-old"))),
        rawBody: JSON.stringify(prPayload("sha-old")),
      }),
    /Failed to resolve current PR head/i,
  );
  assert.equal((await store.load(run.id)).github?.headSha, "sha-new");
});

test("integration: installation_repositories.removed suspends every listed repo", async () => {
  process.env[SECRET_ENV] = SECRET;
  const { store, cwd } = await setup();
  const runOne = await store.create("r1", "req", testConfig());
  runOne.github = {
    installationId: 44,
    repository: "owner/one",
    pullRequestNumber: 1,
    baseSha: "b",
    headSha: "h",
    branch: "a",
    suspended: false,
  };
  await store.save(runOne);
  const runTwo = await store.create("r2", "req", testConfig());
  runTwo.github = {
    installationId: 44,
    repository: "owner/two",
    pullRequestNumber: 2,
    baseSha: "b",
    headSha: "h",
    branch: "b",
    suspended: false,
  };
  await store.save(runTwo);
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await index.bind({
    runId: runOne.id,
    installationId: 44,
    repository: "owner/one",
    pullRequestNumber: 1,
    baseSha: "b",
    headSha: "h",
    branch: "a",
  });
  await index.bind({
    runId: runTwo.id,
    installationId: 44,
    repository: "owner/two",
    pullRequestNumber: 2,
    baseSha: "b",
    headSha: "h",
    branch: "b",
  });

  // Allowlist both for this test config by writing a dedicated adapter.
  const config = mergeConfigForTest({
    runtime: { kind: "mock" },
    quality: { commands: [] },
    githubApp: {
      enabled: true,
      readOnlyChecks: true,
      webhookSecretEnv: SECRET_ENV,
      appIdEnv: "MASWE_TEST_GITHUB_APP_ID",
      privateKeyEnv: "MASWE_TEST_GITHUB_APP_PRIVATE_KEY",
      allowedRepositories: ["owner/one", "owner/two", "owner/repo"],
    },
  });
  const multiAdapter = new GitHubAppAdapter({
    cwd,
    config,
    store,
    http: {
      async request() {
        return { status: 200, headers: {}, body: {} };
      },
    },
    tokenProvider: async () => "token",
  });

  const body = JSON.stringify({
    action: "removed",
    installation: { id: 44 },
    repositories_removed: [{ full_name: "owner/one" }, { full_name: "owner/two" }],
  });
  const result = await multiAdapter.handleWebhook({
    deliveryId: "del-multi-removed",
    eventName: "installation_repositories",
    signatureHeader: sign(body),
    rawBody: body,
  });
  assert.equal(result.status, 200);
  assert.equal((await index.find("owner/one", 1))?.suspended, true);
  assert.equal((await index.find("owner/two", 2))?.suspended, true);
  assert.equal((await store.load(runOne.id)).github?.suspended, true);
  assert.equal((await store.load(runTwo.id)).github?.suspended, true);
});
