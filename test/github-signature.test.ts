import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { verifyGitHubWebhookSignature } from "../src/github/signature.ts";

function sign(secret: string, body: string): string {
  const digest = createHmac("sha256", secret).update(body, "utf8").digest("hex");
  return `sha256=${digest}`;
}

test("verifyGitHubWebhookSignature accepts a valid signature", () => {
  const secret = "test-secret";
  const body = '{"action":"synchronize"}';
  assert.equal(verifyGitHubWebhookSignature(secret, body, sign(secret, body)), true);
});

test("verifyGitHubWebhookSignature rejects a forged signature", () => {
  const secret = "test-secret";
  const body = '{"action":"synchronize"}';
  assert.equal(
    verifyGitHubWebhookSignature(secret, body, sign("other-secret", body)),
    false,
  );
});

test("verifyGitHubWebhookSignature rejects missing or malformed headers", () => {
  const secret = "test-secret";
  const body = "{}";
  assert.equal(verifyGitHubWebhookSignature(secret, body, undefined), false);
  assert.equal(verifyGitHubWebhookSignature(secret, body, "sha1=deadbeef"), false);
  assert.equal(verifyGitHubWebhookSignature(secret, body, "sha256=not-hex"), false);
});
