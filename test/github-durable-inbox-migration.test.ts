import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mergeConfigForTest } from "../src/config.ts";
import { GitHubAppAdapter } from "../src/github/adapter.ts";
import { GitHubDeliveryInbox } from "../src/github/delivery-inbox.ts";
import { FileRunStore } from "../src/store.ts";

const SECRET_ENV = "MASWE_TEST_INBOX_MIGRATION_SECRET";
const SECRET = "inbox-migration-secret";

function config() {
  return mergeConfigForTest({
    runtime: { kind: "mock" },
    quality: { commands: [] },
    githubApp: {
      enabled: true,
      readOnlyChecks: true,
      webhookSecretEnv: SECRET_ENV,
      appIdEnv: "MASWE_TEST_APP_ID",
      privateKeyEnv: "MASWE_TEST_PRIVATE_KEY",
      allowedRepositories: ["owner/repo"],
    },
  });
}

function request(deliveryId: string, headSha: string) {
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

async function writeLegacy(
  root: string,
  deliveryId: string,
  status: "processing" | "completed",
): Promise<string> {
  const deliveries = path.join(root, ".maswe", "github", "deliveries");
  await mkdir(deliveries, { recursive: true });
  const canonical = path.join(deliveries, `${deliveryId}.json`);
  await writeFile(
    canonical,
    `${JSON.stringify({
      deliveryId,
      status,
      claimedAt: "2026-08-09T12:00:00.000Z",
      leaseId: "legacy-lease",
      ...(status === "completed" ? { completedAt: "2026-08-09T12:00:01.000Z" } : {}),
    })}\n`,
    "utf8",
  );
  await writeFile(`${canonical}.staging.retained`, "retained-artifact\n", "utf8");
  await writeFile(`${canonical}.suppression.retained`, "retained-suppression\n", "utf8");
  return canonical;
}

test("startup migration turns v1 processing into awaiting-redelivery", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-inbox-v1-processing-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const canonical = await writeLegacy(cwd, "legacy-processing", "processing");
  let posts = 0;
  const adapter = new GitHubAppAdapter({
    cwd,
    config: config(),
    store: new FileRunStore(cwd),
    http: {
      async request(method, url) {
        if (method === "GET" && url.includes("/pulls/")) {
          return { status: 200, headers: {}, body: { head: { sha: "sha-legacy" } } };
        }
        if (method === "GET") return { status: 200, headers: {}, body: { check_runs: [] } };
        posts += 1;
        return { status: 201, headers: {}, body: { id: posts } };
      },
    },
    tokenProvider: async () => "token",
  });

  await adapter.initialize();
  const accepted = await adapter.handleWebhook(request("legacy-processing", "sha-legacy"));
  assert.equal(accepted.status, 202);
  await adapter.startWebhookWorker();
  await adapter.waitForWebhookIdle();
  await adapter.stopWebhookWorker();
  assert.equal(posts, 4);
  await assert.rejects(readFile(canonical, "utf8"), { code: "ENOENT" });

  const hash = createHash("sha256").update("legacy-processing").digest("hex");
  const legacyDirectory = path.join(
    cwd,
    ".maswe",
    "github",
    "inbox",
    "legacy",
    hash.slice(0, 2),
    hash,
  );
  const migratedNames = await readdir(legacyDirectory);
  const stagingName = migratedNames.find((name) => name.includes("staging.retained"));
  const suppressionName = migratedNames.find((name) => name.includes("suppression.retained"));
  assert.ok(stagingName);
  assert.ok(suppressionName);
  assert.equal(await readFile(path.join(legacyDirectory, stagingName), "utf8"), "retained-artifact\n");
  assert.equal(
    await readFile(path.join(legacyDirectory, suppressionName), "utf8"),
    "retained-suppression\n",
  );
});

test("startup migration preserves v1 completed as terminal legacy", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-inbox-v1-completed-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  await writeLegacy(cwd, "legacy-completed", "completed");
  let requests = 0;
  const adapter = new GitHubAppAdapter({
    cwd,
    config: config(),
    store: new FileRunStore(cwd),
    http: { async request() { requests += 1; return { status: 500, headers: {}, body: {} }; } },
    tokenProvider: async () => "token",
  });

  await adapter.initialize();
  const replay = await adapter.handleWebhook(request("legacy-completed", "different-body"));
  assert.equal(replay.status, 200);
  assert.equal(replay.body.duplicate, true);
  assert.equal(requests, 0);
});

test("startup migration fails closed instead of overwriting conflicting retained evidence", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-inbox-v1-conflict-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const deliveryId = "legacy-conflict";
  const canonical = await writeLegacy(cwd, deliveryId, "processing");
  const sourceName = `${path.basename(canonical)}.staging.retained`;
  const hash = createHash("sha256").update(deliveryId).digest("hex");
  const legacyDirectory = path.join(
    cwd,
    ".maswe",
    "github",
    "inbox",
    "legacy",
    hash.slice(0, 2),
    hash,
  );
  await mkdir(legacyDirectory, { recursive: true });
  const retainedPath = path.join(legacyDirectory, sourceName);
  await writeFile(retainedPath, "conflicting-retained-evidence\n", "utf8");
  const adapter = new GitHubAppAdapter({
    cwd,
    config: config(),
    store: new FileRunStore(cwd),
    http: { async request() { throw new Error("migration must fail before API work"); } },
    tokenProvider: async () => "token",
  });

  await assert.rejects(adapter.initialize(), /conflicting legacy delivery evidence/i);
  assert.equal(await readFile(retainedPath, "utf8"), "conflicting-retained-evidence\n");
  assert.equal(await readFile(`${canonical}.staging.retained`, "utf8"), "retained-artifact\n");
});

test("startup fails closed on an unexpected durable queue entry", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-inbox-invalid-queue-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const githubRoot = path.join(cwd, ".maswe", "github");
  const invalidQueueDirectory = path.join(githubRoot, "inbox", "queue", "not-a-prefix");
  await mkdir(invalidQueueDirectory, { recursive: true });
  await writeFile(path.join(invalidQueueDirectory, "stranded.queued"), "", "utf8");

  await assert.rejects(
    new GitHubDeliveryInbox(githubRoot).initialize(),
    /Invalid GitHub durable inbox queue entry/,
  );
});
