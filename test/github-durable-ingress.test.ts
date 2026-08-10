import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mergeConfigForTest } from "../src/config.ts";
import { GitHubAppAdapter } from "../src/github/adapter.ts";
import type { GitHubHttpClient } from "../src/github/checks.ts";
import { GitHubDeliveryInbox } from "../src/github/delivery-inbox.ts";
import { FileRunStore } from "../src/store.ts";

const SECRET_ENV = "MASWE_TEST_DURABLE_INGRESS_SECRET";
const SECRET = "durable-ingress-secret";

function config() {
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function signedRequest(deliveryId: string, headSha = "sha-durable") {
  const rawBody = JSON.stringify({
    action: "synchronize",
    installation: { id: 44 },
    repository: { full_name: "owner/repo" },
    pull_request: {
      number: 9,
      head: { sha: headSha, ref: "feature" },
      base: { sha: "base" },
    },
  });
  return {
    deliveryId,
    eventName: "pull_request",
    signatureHeader: `sha256=${createHmac("sha256", SECRET).update(rawBody).digest("hex")}`,
    rawBody,
  };
}

test("durable ingress acknowledges before a blocked downstream dispatch", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-durable-ack-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const dispatchReached = deferred();
  const releaseDispatch = deferred();
  const http: GitHubHttpClient = {
    async request(method, url) {
      if (method === "GET" && url.includes("/pulls/")) {
        dispatchReached.resolve();
        await releaseDispatch.promise;
        return { status: 200, headers: {}, body: { head: { sha: "sha-durable" } } };
      }
      if (method === "GET") return { status: 200, headers: {}, body: { check_runs: [] } };
      return { status: 201, headers: {}, body: { id: 1 } };
    },
  };
  const adapter = new GitHubAppAdapter({
    cwd,
    config: config(),
    store: new FileRunStore(cwd),
    http,
    tokenProvider: async () => "token",
    autoStartWebhookWorker: true,
  } as ConstructorParameters<typeof GitHubAppAdapter>[0]);

  const responsePromise = adapter.handleWebhook(signedRequest("durable-ack"));
  await dispatchReached.promise;
  let raceTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      responsePromise,
      new Promise<never>((_, reject) => {
        raceTimer = setTimeout(
          () => reject(new Error("ingress waited for downstream dispatch")),
          250,
        );
      }),
    ]);
    assert.equal(response.status, 202);
  } finally {
    if (raceTimer !== undefined) clearTimeout(raceTimer);
    releaseDispatch.resolve();
    await Promise.allSettled([responsePromise]);
    await adapter.waitForWebhookIdle();
    await adapter.stopWebhookWorker();
  }
});

test("durable ingress resumes an acknowledged queued event after restart", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-durable-restart-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  let posts = 0;
  const http: GitHubHttpClient = {
    async request(method, url) {
      if (method === "GET" && url.includes("/pulls/")) {
        return { status: 200, headers: {}, body: { head: { sha: "sha-durable" } } };
      }
      if (method === "GET") return { status: 200, headers: {}, body: { check_runs: [] } };
      posts += 1;
      return { status: 201, headers: {}, body: { id: posts } };
    },
  };
  const makeAdapter = () =>
    new GitHubAppAdapter({
      cwd,
      config: config(),
      store: new FileRunStore(cwd),
      http,
      tokenProvider: async () => "token",
    });
  const firstProcess = makeAdapter();
  const accepted = await firstProcess.handleWebhook(signedRequest("durable-restart"));
  assert.equal(accepted.status, 202);
  assert.equal(posts, 0);

  const restarted = makeAdapter();
  await restarted.startWebhookWorker();
  await restarted.waitForWebhookIdle();
  await restarted.stopWebhookWorker();
  assert.equal(posts, 4);

  const replay = await restarted.handleWebhook(signedRequest("durable-restart"));
  assert.equal(replay.status, 200);
  assert.equal(replay.body.duplicate, true);
});

test("queued duplicates are acknowledged and conflicting delivery bytes are rejected", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-durable-duplicate-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const adapter = new GitHubAppAdapter({
    cwd,
    config: config(),
    store: new FileRunStore(cwd),
    http: { async request() { throw new Error("worker must not run"); } },
    tokenProvider: async () => "token",
  });

  assert.equal((await adapter.handleWebhook(signedRequest("durable-duplicate"))).status, 202);
  const duplicate = await adapter.handleWebhook(signedRequest("durable-duplicate"));
  assert.equal(duplicate.status, 202);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(
    (await adapter.handleWebhook(signedRequest("durable-duplicate", "different-sha"))).status,
    409,
  );

  const files = await readdir(path.join(cwd, ".maswe", "github", "inbox", "state"), {
    recursive: true,
  });
  const stateName = files.find((name) => name.endsWith("state.json"));
  assert.ok(stateName);
  const persisted = await readFile(
    path.join(cwd, ".maswe", "github", "inbox", "state", stateName),
    "utf8",
  );
  assert.match(persisted, /"rawBodyDigest":"sha256:[0-9a-f]{64}"/);
  assert.match(persisted, /"event":\{/);
  assert.doesNotMatch(persisted, /signature|token|secret|"rawBody":|"headers":/);
});

test("signed invalid UTF-8 authenticates exact bytes but is rejected without enqueue", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-durable-utf8-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const adapter = new GitHubAppAdapter({
    cwd,
    config: config(),
    store: new FileRunStore(cwd),
    http: { async request() { throw new Error("invalid input must not dispatch"); } },
    tokenProvider: async () => "token",
  });
  const rawBody = Buffer.from([0x7b, 0xff, 0x7d]);
  const response = await adapter.handleWebhook({
    deliveryId: "durable-invalid-utf8",
    eventName: "push",
    signatureHeader: `sha256=${createHmac("sha256", SECRET).update(rawBody).digest("hex")}`,
    rawBody,
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.message, "invalid UTF-8 body");
  const files = await readdir(path.join(cwd, ".maswe", "github", "inbox", "state"), {
    recursive: true,
  });
  assert.equal(files.some((name) => name.endsWith("state.json")), false);
});

test("worker stop bounds drain while preserving active durable work", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-durable-drain-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const dispatchReached = deferred();
  const releaseDispatch = deferred();
  const adapter = new GitHubAppAdapter({
    cwd,
    config: config(),
    store: new FileRunStore(cwd),
    http: {
      async request(method, url) {
        if (method === "GET" && url.includes("/pulls/")) {
          dispatchReached.resolve();
          await releaseDispatch.promise;
          return { status: 200, headers: {}, body: { head: { sha: "sha-durable" } } };
        }
        if (method === "GET") return { status: 200, headers: {}, body: { check_runs: [] } };
        return { status: 201, headers: {}, body: { id: 1 } };
      },
    },
    tokenProvider: async () => "token",
    autoStartWebhookWorker: true,
  });

  assert.equal((await adapter.handleWebhook(signedRequest("durable-drain"))).status, 202);
  await dispatchReached.promise;
  const started = Date.now();
  await adapter.stopWebhookWorker({ drainMs: 50 });
  assert.ok(Date.now() - started < 500);
  releaseDispatch.resolve();
  await adapter.waitForWebhookIdle();
});

test("manual publication preflight does not recover an active webhook lease", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-manual-lease-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const options = {
    cwd,
    config: config(),
    store: new FileRunStore(cwd),
    http: { async request() { throw new Error("manual preflight must not call GitHub"); } },
    tokenProvider: async () => "token",
  } satisfies ConstructorParameters<typeof GitHubAppAdapter>[0];
  const ingress = new GitHubAppAdapter(options);
  assert.equal((await ingress.handleWebhook(signedRequest("manual-active-lease"))).status, 202);

  const inbox = new GitHubDeliveryInbox(path.join(cwd, ".maswe", "github"), {
    leaseMs: 60_000,
  });
  const claimed = await inbox.claimNext();
  assert.ok(claimed);
  const leaseId = claimed.record.leaseId;

  const manual = new GitHubAppAdapter(options);
  await assert.rejects(manual.publishChecksForRun("missing-run"), /missing-run/);

  const hash = createHash("sha256").update("manual-active-lease").digest("hex");
  const state = JSON.parse(
    await readFile(
      path.join(
        cwd,
        ".maswe",
        "github",
        "inbox",
        "state",
        hash.slice(0, 2),
        hash,
        "state.json",
      ),
      "utf8",
    ),
  ) as Record<string, unknown>;
  assert.equal(state.status, "processing");
  assert.equal(state.leaseId, leaseId);
});

test("durable handoff failures emit a local diagnostic before returning 503", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-durable-diagnostic-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const failure = new Error("simulated durable handoff failure");
  const diagnostics: unknown[] = [];
  const adapter = new GitHubAppAdapter({
    cwd,
    config: config(),
    store: new FileRunStore(cwd),
    http: { async request() { throw new Error("failed handoff must not dispatch"); } },
    tokenProvider: async () => "token",
    beforeInboxEnqueue: async () => { throw failure; },
    onWebhookDiagnostic: (error) => diagnostics.push(error),
  });

  const response = await adapter.handleWebhook(signedRequest("durable-diagnostic"));

  assert.equal(response.status, 503);
  assert.deepEqual(diagnostics, [failure]);
});
