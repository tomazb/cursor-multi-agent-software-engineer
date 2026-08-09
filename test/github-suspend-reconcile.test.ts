import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mergeConfigForTest } from "../src/config.ts";
import { GitHubAppAdapter } from "../src/github/adapter.ts";
import { GitHubAssociationIndex } from "../src/github/association.ts";
import { FileRunStore } from "../src/store.ts";

const SECRET = "suspend-reconcile-secret";
const SECRET_ENV = "MASWE_TEST_GITHUB_WEBHOOK_SECRET_SUSPEND";

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`;
}

test("redelivery after run-save failure still suspends the authoritative run", async () => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-suspend-rec-"));
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
      allowedRepositories: ["owner/one"],
    },
  });
  const run = await store.create("s1", "req", config);
  run.github = {
    installationId: 44,
    repository: "owner/one",
    pullRequestNumber: 1,
    baseSha: "b",
    headSha: "h",
    branch: "a",
    suspended: false,
  };
  await store.save(run);

  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await index.bind({
    runId: run.id,
    installationId: 44,
    repository: "owner/one",
    pullRequestNumber: 1,
    baseSha: "b",
    headSha: "h",
    branch: "a",
  });

  // Simulate crash after index suspend but before run save: index already suspended, run still active.
  await index.suspendRepository(44, "owner/one");
  assert.equal((await index.find("owner/one", 1))?.suspended, true);
  assert.equal((await store.load(run.id)).github?.suspended, false);

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

  const body = JSON.stringify({
    action: "removed",
    installation: { id: 44 },
    repositories_removed: [{ full_name: "owner/one" }],
  });
  const result = await adapter.handleWebhook({
    deliveryId: "del-suspend-retry",
    eventName: "installation_repositories",
    signatureHeader: sign(body),
    rawBody: body,
  });
  assert.equal(result.status, 200);
  assert.equal((await store.load(run.id)).github?.suspended, true);
});
