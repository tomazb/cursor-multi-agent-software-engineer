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

async function setup() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-int-"));
  const store = new FileRunStore(cwd);
  const config = testConfig();
  const posts: unknown[] = [];
  const patches: unknown[] = [];
  let nextId = 1;
  let rateLimitOnce = false;
  const http: GitHubHttpClient = {
    async request(method, url, options) {
      if (rateLimitOnce) {
        rateLimitOnce = false;
        return {
          status: 403,
          headers: { "x-ratelimit-remaining": "0" },
          body: { message: "API rate limit exceeded" },
        };
      }
      if (method === "POST" && url.includes("/check-runs")) {
        posts.push(options?.body);
        return { status: 201, headers: {}, body: { id: nextId++ } };
      }
      if (method === "PATCH") {
        patches.push(options?.body);
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
    tokenProvider: async () => "test-token",
  });
  return {
    cwd,
    store,
    adapter,
    posts,
    patches,
    enableRateLimitOnce() {
      rateLimitOnce = true;
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
  const { adapter, cwd, posts } = await setup();
  const body = JSON.stringify(prPayload("sha1"));
  const result = await adapter.handleWebhook({
    deliveryId: "del-forged",
    eventName: "pull_request",
    signatureHeader: sign("tampered"),
    rawBody: body,
  });
  assert.equal(result.status, 401);
  assert.equal(posts.length, 0);
  const sideEffects = new GitHubSideEffectStore(path.join(cwd, ".maswe", "github"));
  assert.equal(
    await sideEffects.get("check-run:owner/repo/9/sha1/MASWE / deterministic quality/1"),
    undefined,
  );
});

test("integration: replayed delivery does not duplicate checks", async () => {
  process.env[SECRET_ENV] = SECRET;
  const { adapter, posts, store } = await setup();
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
  assert.equal(first.body.duplicate, undefined);
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

test("integration: new head SHA invalidates prior success conclusions", async () => {
  process.env[SECRET_ENV] = SECRET;
  const { adapter, posts, patches, store } = await setup();
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
  const successPosts = posts.filter(
    (body) => (body as { conclusion?: string }).conclusion === "success",
  );
  assert.ok(successPosts.length >= 2);

  // Evidence still sha1; event moves to sha2 → quality/verify must not succeed for sha2
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

test("integration: rate limit does not record a successful side effect", async () => {
  process.env[SECRET_ENV] = SECRET;
  const { adapter, enableRateLimitOnce, cwd } = await setup();
  enableRateLimitOnce();
  const body = JSON.stringify(prPayload("sha-rl"));
  await assert.rejects(
    () =>
      adapter.handleWebhook({
        deliveryId: "del-rl",
        eventName: "pull_request",
        signatureHeader: sign(body),
        rawBody: body,
      }),
    /rate limit/i,
  );
  const sideEffects = new GitHubSideEffectStore(path.join(cwd, ".maswe", "github"));
  assert.equal(
    await sideEffects.get("check-run:owner/repo/9/sha-rl/MASWE / specification compliance/1"),
    undefined,
  );
});

test("integration: installation deletion suspends associations", async () => {
  process.env[SECRET_ENV] = SECRET;
  const { adapter, cwd, posts } = await setup();
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await index.bind({
    runId: "run-x",
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

  const syncBody = JSON.stringify(prPayload("sha-after-suspend"));
  const after = await adapter.handleWebhook({
    deliveryId: "del-after-suspend",
    eventName: "pull_request",
    signatureHeader: sign(syncBody),
    rawBody: syncBody,
  });
  assert.equal(after.status, 200);
  // Suspended association: no check posts for that bound run path
  assert.equal(posts.length, 0);
});
