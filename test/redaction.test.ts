import assert from "node:assert/strict";
import test from "node:test";
import { redactSecrets } from "../src/redaction.ts";

test("redacts common API tokens and authorization headers", () => {
  const input = [
    "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz012345",
    'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"',
  ].join("\n");
  const redacted = redactSecrets(input);
  assert.doesNotMatch(redacted, /ghp_[A-Za-z0-9]+/);
  assert.doesNotMatch(redacted, /sk-[A-Za-z0-9]+/);
  assert.doesNotMatch(redacted, /wJalrXUtnFEMI/);
  assert.match(redacted, /\[REDACTED\]/);
});

test("redacts PEM private key blocks", () => {
  const input = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7
-----END PRIVATE KEY-----`;
  const redacted = redactSecrets(input);
  assert.doesNotMatch(redacted, /MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7/);
  assert.match(redacted, /BEGIN PRIVATE KEY/);
  assert.match(redacted, /\[REDACTED\]/);
});

test("leaves ordinary text unchanged", () => {
  const input = "Build passed. See docs/SECURITY.md for policy.";
  assert.equal(redactSecrets(input), input);
});
