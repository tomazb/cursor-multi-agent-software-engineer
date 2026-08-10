import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { createInstallationAccessToken } from "../src/github/token.ts";

test("createInstallationAccessToken scopes checks write to one repository", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  let seenBody: unknown;
  let seenMethod: string | undefined;
  let seenUrl: string | undefined;
  let seenHeaders: Record<string, string> | undefined;
  const token = await createInstallationAccessToken({
    appId: "123",
    privateKeyPem: pem,
    installationId: 9,
    repository: "owner/repo",
    http: {
      async request(method, url, options) {
        seenMethod = method;
        seenUrl = url;
        seenHeaders = options?.headers;
        seenBody = options?.body;
        return { status: 201, headers: {}, body: { token: "ghs_test" } };
      },
    },
  });
  assert.equal(token, "ghs_test");
  assert.equal(seenMethod, "POST");
  assert.equal(seenUrl, "https://api.github.com/app/installations/9/access_tokens");
  assert.equal(seenHeaders?.["content-type"], "application/json");
  assert.deepEqual(seenBody, {
    repositories: ["repo"],
    permissions: {
      checks: "write",
      pull_requests: "read",
      metadata: "read",
    },
  });
});

test("createInstallationAccessToken rejects a malformed repository before requesting a token", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  let requests = 0;

  await assert.rejects(
    createInstallationAccessToken({
      appId: "123",
      privateKeyPem: pem,
      installationId: 9,
      repository: "missing-owner-name",
      http: {
        async request() {
          requests += 1;
          return { status: 201, headers: {}, body: { token: "too-broad" } };
        },
      },
    }),
    /owner\/name/,
  );
  assert.equal(requests, 0);
});

test("createInstallationAccessToken rejects an explicit read-only policy opt-out", async () => {
  let requests = 0;
  await assert.rejects(
    createInstallationAccessToken({
      appId: "unused",
      privateKeyPem: "must-not-be-parsed",
      installationId: 9,
      repository: "owner/repo",
      readOnlyChecks: false,
      http: {
        async request() {
          requests += 1;
          return { status: 201, headers: {}, body: { token: "too-broad" } };
        },
      },
    }),
    /read-only checks policy/i,
  );
  assert.equal(requests, 0);
});
