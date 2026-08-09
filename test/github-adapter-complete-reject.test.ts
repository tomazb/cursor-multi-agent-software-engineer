import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mergeConfigForTest } from "../src/config.ts";
import { GitHubAppAdapter } from "../src/github/adapter.ts";
import { GitHubDeliveryStore } from "../src/github/delivery-store.ts";
import { FileRunStore } from "../src/store.ts";

const SECRET = "adapter-complete-secret";
const SECRET_ENV = "MASWE_TEST_GITHUB_WEBHOOK_SECRET_COMPLETE";

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`;
}

test("adapter does not return 200 when delivery completion is rejected", async () => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-adapter-complete-"));
  const store = new FileRunStore(cwd);
  const config = mergeConfigForTest({
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

  const adapter = new GitHubAppAdapter({
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

  // Replace delivery store complete to reject after a real claim path is hard;
  // instead spy by patching the private deliveries field.
  const deliveries = (adapter as unknown as { deliveries: GitHubDeliveryStore }).deliveries;
  const originalComplete = deliveries.complete.bind(deliveries);
  deliveries.complete = async (deliveryId, leaseId) => {
    await originalComplete(deliveryId, leaseId);
    return { ok: false, reason: "owner_mismatch" };
  };

  const body = JSON.stringify({
    action: "deleted",
    installation: { id: 1 },
  });
  await assert.rejects(
    () =>
      adapter.handleWebhook({
        deliveryId: "del-complete-reject",
        eventName: "installation",
        signatureHeader: sign(body),
        rawBody: body,
      }),
    /completion rejected|owner_mismatch/i,
  );
});
