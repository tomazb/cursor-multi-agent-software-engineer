import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mergeConfigForTest } from "../src/config.ts";
import { GitHubAppAdapter } from "../src/github/adapter.ts";
import type { GitHubHttpClient } from "../src/github/checks.ts";
import { GitHubDeliveryStore } from "../src/github/delivery-store.ts";
import { FileRunStore } from "../src/store.ts";

const SECRET = "delivery-semantics-secret";
const SECRET_ENV = "MASWE_TEST_GITHUB_WEBHOOK_DELIVERY_SECRET";

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`;
}

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

function prPayload() {
  return {
    action: "synchronize",
    installation: { id: 44 },
    repository: { full_name: "owner/repo" },
    pull_request: {
      number: 9,
      head: { sha: "sha-new", ref: "feature" },
      base: { sha: "sha-base" },
    },
  };
}

async function setup(options: {
  http?: GitHubHttpClient;
  tokenProvider?: () => Promise<string>;
  deliveryMonitor?: {
    onStaleReclaim?: (deliveryId: string, previousLeaseId: string | undefined) => void;
    onOwnerMismatch?: (
      op: "complete" | "fail",
      deliveryId: string,
      providedLeaseId: string,
      currentLeaseId: string | undefined,
    ) => void;
  };
} = {}) {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-delivery-semantics-"));
  const githubRoot = path.join(cwd, ".maswe", "github");
  const deliveries = new GitHubDeliveryStore(githubRoot);
  const http: GitHubHttpClient = options.http ?? {
    async request(method) {
      if (method === "POST") return { status: 201, headers: {}, body: { id: 1 } };
      return { status: 200, headers: {}, body: { check_runs: [] } };
    },
  };
  const adapter = new GitHubAppAdapter({
    cwd,
    config: config(),
    store: new FileRunStore(cwd),
    http,
    tokenProvider: options.tokenProvider ?? (async () => "token"),
    ...(options.deliveryMonitor ? { deliveryMonitor: options.deliveryMonitor } : {}),
  });
  return { adapter, deliveries, githubRoot };
}

function request(deliveryId: string, eventName: string, body: string) {
  return {
    deliveryId,
    eventName,
    signatureHeader: sign(body),
    rawBody: body,
  };
}

test("completed duplicate is acknowledged without redispatch", async () => {
  const { adapter, deliveries } = await setup();
  const claim = await deliveries.claim("completed-duplicate");
  assert.ok(claim.leaseId);
  assert.deepEqual(await deliveries.complete("completed-duplicate", claim.leaseId), { ok: true });

  const result = await adapter.handleWebhook(
    request("completed-duplicate", "gollum", JSON.stringify({})),
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.duplicate, true);
});

test("live processing duplicate returns retryable 503", async () => {
  const { adapter, deliveries } = await setup();
  await deliveries.claim("processing-duplicate");

  const result = await adapter.handleWebhook(
    request("processing-duplicate", "gollum", JSON.stringify({})),
  );
  assert.equal(result.status, 503);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.duplicate, true);
});

test("unsupported event and action are durably completed without dispatch", async () => {
  let requests = 0;
  const { adapter, deliveries } = await setup({
    http: {
      async request() {
        requests += 1;
        return { status: 500, headers: {}, body: {} };
      },
    },
  });

  const unsupportedEvent = JSON.stringify({});
  const eventResult = await adapter.handleWebhook(
    request("unsupported-event", "gollum", unsupportedEvent),
  );
  assert.equal(eventResult.status, 200);
  assert.equal((await deliveries.claim("unsupported-event")).status, "completed");

  const unsupportedAction = JSON.stringify({ ...prPayload(), action: "labeled" });
  const actionResult = await adapter.handleWebhook(
    request("unsupported-action", "pull_request", unsupportedAction),
  );
  assert.equal(actionResult.status, 200);
  assert.equal((await deliveries.claim("unsupported-action")).status, "completed");
  assert.equal(requests, 0);
});

test("malformed supported payload returns 400 only after releasing its exact lease", async () => {
  const { adapter, deliveries } = await setup();
  const body = JSON.stringify({ action: "synchronize" });
  const result = await adapter.handleWebhook(request("malformed-supported", "pull_request", body));
  assert.equal(result.status, 400);

  const retry = await deliveries.claim("malformed-supported");
  assert.equal(retry.claimed, true);
});

test("supported dispatch failure releases its exact lease so redelivery can claim", async () => {
  let failing = true;
  const { adapter, deliveries } = await setup({
    http: {
      async request() {
        if (failing) throw new Error("transient GitHub API failure");
        return { status: 201, headers: {}, body: { id: 1 } };
      },
    },
  });
  const body = JSON.stringify(prPayload());
  await assert.rejects(
    () => adapter.handleWebhook(request("dispatch-retry", "pull_request", body)),
    /transient GitHub API failure/,
  );
  const retryClaim = await deliveries.claim("dispatch-retry");
  assert.equal(retryClaim.claimed, true);
  assert.ok(retryClaim.leaseId);
  assert.deepEqual(await deliveries.fail("dispatch-retry", "test release", retryClaim.leaseId), {
    ok: true,
  });

  failing = false;
  const retry = await adapter.handleWebhook(request("dispatch-retry", "pull_request", body));
  assert.equal(retry.status, 200);
});

test("invalid JSON is 400 only when failure cleanup succeeds", async () => {
  const { adapter, deliveries } = await setup();
  const body = "{";
  const result = await adapter.handleWebhook(request("invalid-json-ok", "push", body));
  assert.equal(result.status, 400);
  assert.equal((await deliveries.claim("invalid-json-ok")).claimed, true);

  const internal = (adapter as unknown as { deliveries: GitHubDeliveryStore }).deliveries;
  internal.fail = async () => ({ ok: false, reason: "owner_mismatch" });
  await assert.rejects(
    () => adapter.handleWebhook(request("invalid-json-rejected", "push", body)),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "invalid JSON body");
      assert.ok(error.cause instanceof Error);
      assert.match(error.cause.message, /failure rejected|owner_mismatch/i);
      return true;
    },
  );
});

test("failure cleanup rejection preserves the primary error and exposes cleanup cause", async () => {
  const { adapter } = await setup({
    http: {
      async request() {
        throw new Error("primary dispatch failure");
      },
    },
  });
  const internal = (adapter as unknown as { deliveries: GitHubDeliveryStore }).deliveries;
  internal.fail = async () => ({ ok: false, reason: "owner_mismatch" });
  const body = JSON.stringify(prPayload());
  await assert.rejects(
    () => adapter.handleWebhook(request("failed-cleanup", "pull_request", body)),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "primary dispatch failure");
      assert.ok(error.cause instanceof Error);
      assert.match(error.cause.message, /failure rejected|owner_mismatch/i);
      return true;
    },
  );
});

test("adapter constructor exposes stale reclaim and owner mismatch monitoring", async () => {
  const diagnostics: string[] = [];
  let githubRoot = "";
  let deliveries: GitHubDeliveryStore;
  const initialized = await setup({
    deliveryMonitor: {
      onStaleReclaim: (deliveryId, previousLeaseId) =>
        diagnostics.push(`reclaim:${deliveryId}:${previousLeaseId}`),
      onOwnerMismatch: (op, deliveryId, _providedLeaseId, currentLeaseId) =>
        diagnostics.push(`mismatch:${op}:${deliveryId}:${currentLeaseId}`),
    },
    tokenProvider: async () => {
      const canonical = path.join(githubRoot, "deliveries", "owner-mismatch.json");
      const record = JSON.parse(await readFile(canonical, "utf8")) as {
        deliveryId: string;
        status: "processing";
        leaseId: string;
        claimedAt: string;
      };
      await writeFile(
        canonical,
        `${JSON.stringify({ ...record, claimedAt: new Date(Date.now() - 600_000).toISOString() })}\n`,
      );
      await deliveries.claim("owner-mismatch");
      return "token";
    },
  });
  githubRoot = initialized.githubRoot;
  deliveries = initialized.deliveries;

  const stale = await deliveries.claim("stale-monitor", Date.now() - 600_000);
  assert.ok(stale.leaseId);
  const ignored = JSON.stringify({});
  assert.equal(
    (await initialized.adapter.handleWebhook(request("stale-monitor", "gollum", ignored))).status,
    200,
  );
  assert.ok(diagnostics.some((entry) => entry === `reclaim:stale-monitor:${stale.leaseId}`));

  const body = JSON.stringify(prPayload());
  await assert.rejects(
    () => initialized.adapter.handleWebhook(request("owner-mismatch", "pull_request", body)),
    /completion rejected|owner_mismatch/i,
  );
  assert.ok(
    diagnostics.some((entry) => entry.startsWith("mismatch:complete:owner-mismatch:")),
  );
});
