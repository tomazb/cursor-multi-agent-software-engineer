import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { createInstallationAccessToken } from "../src/github/token.ts";

test("createInstallationAccessToken scopes checks write to one repository", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  let seenBody: unknown;
  const token = await createInstallationAccessToken({
    appId: "123",
    privateKeyPem: pem,
    installationId: 9,
    repository: "repo",
    readOnlyChecks: true,
    http: {
      async request(_method, _url, options) {
        seenBody = options?.body;
        return { status: 201, headers: {}, body: { token: "ghs_test" } };
      },
    },
  });
  assert.equal(token, "ghs_test");
  assert.deepEqual(seenBody, {
    repositories: ["repo"],
    permissions: { checks: "write", metadata: "read" },
  });
});
