import assert from "node:assert/strict";
import test from "node:test";
import { redactSecrets } from "../src/redaction.ts";
import * as redactionModule from "../src/redaction.ts";

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

test("redacts standalone bearer tokens, URL credentials, and assignments", () => {
  const input = [
    "Bearer standalone-secret-value",
    "request failed at https://alice:super-secret@example.invalid/private",
    "api_key=synthetic-secret-value",
    "token: synthetic-secret-value",
    "endpoint=https://service.internal.invalid/run?access_token=synthetic-secret-value&safe=yes",
  ].join("\n");

  const redacted = redactSecrets(input);

  for (const secret of [
    "standalone-secret-value",
    "super-secret",
    "synthetic-secret-value",
  ]) {
    assert.equal(redacted.includes(secret), false, `leaked ${secret}`);
  }
  assert.match(redacted, /Bearer \[REDACTED\]/);
  assert.match(redacted, /https:\/\/alice:\[REDACTED\]@example\.invalid\/private/);
  assert.match(redacted, /safe=yes/);
});

test("redacts multiple synthetic secret forms at the start, middle, and end", () => {
  const input = [
    "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA starts the line",
    "middle sk-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB value",
    "Authorization: Bearer bearer-secret-value",
    "xoxb-CCCCCCCCCCCCCCCCCCCC",
    "aws_secret_access_key=AWS-SYNTHETIC-SECRET",
    "ends with token=synthetic-secret-value",
  ].join("\n");

  const redacted = redactSecrets(input);

  assert.equal(redacted.includes("ghp_AAAAAAAAA"), false);
  assert.equal(redacted.includes("sk-BBBBBBBBB"), false);
  assert.equal(redacted.includes("bearer-secret-value"), false);
  assert.equal(redacted.includes("CCCCCCCCCCCC"), false);
  assert.equal(redacted.includes("AWS-SYNTHETIC-SECRET"), false);
  assert.equal(redacted.includes("synthetic-secret-value"), false);
  assert.match(redacted, /starts the line/);
  assert.match(redacted, /middle/);
  assert.match(redacted, /ends with/);
});

test("sanitizes controls and bounds diagnostics by Unicode code points", () => {
  const sanitizeDiagnostic = (
    redactionModule as Record<string, unknown>
  ).sanitizeDiagnostic;
  assert.equal(typeof sanitizeDiagnostic, "function");
  if (typeof sanitizeDiagnostic !== "function") return;

  const result = sanitizeDiagnostic(
    `safe\u0000text\u001b[31m ${"😀".repeat(20)}\nnext\tline`,
    32,
  ) as { text: string; truncated: boolean };

  assert.equal(result.truncated, true);
  assert.ok([...result.text].length <= 32);
  assert.match(result.text, /… \[truncated\]$/);
  assert.doesNotMatch(result.text, /[\u0000\u001b]/);
});

test("redacts before truncating near a secret boundary", () => {
  const sanitizeDiagnostic = (
    redactionModule as Record<string, unknown>
  ).sanitizeDiagnostic;
  assert.equal(typeof sanitizeDiagnostic, "function");
  if (typeof sanitizeDiagnostic !== "function") return;

  const result = sanitizeDiagnostic(
    `${"safe-".repeat(8)}token=synthetic-secret-value trailing context`,
    56,
  ) as { text: string; truncated: boolean };

  assert.equal(result.truncated, true);
  assert.equal(result.text.includes("synthetic-secret-value"), false);
  assert.equal(result.text.includes("synthetic-"), false);
  assert.ok([...result.text].length <= 56);
});

test("diagnostic sanitization is deterministic for multiline mixed content", () => {
  const sanitizeDiagnostic = (
    redactionModule as Record<string, unknown>
  ).sanitizeDiagnostic;
  assert.equal(typeof sanitizeDiagnostic, "function");
  if (typeof sanitizeDiagnostic !== "function") return;

  const input = [
    "request failed safely",
    "Authorization: Bearer bearer-secret-value",
    "details remain useful",
    "-----BEGIN PRIVATE KEY-----",
    "synthetic-private-key",
    "-----END PRIVATE KEY-----",
  ].join("\n");
  const first = sanitizeDiagnostic(input, 2_048);
  const second = sanitizeDiagnostic(input, 2_048);

  assert.deepEqual(first, second);
  assert.equal(
    JSON.stringify(first).includes("bearer-secret-value"),
    false,
  );
  assert.equal(
    JSON.stringify(first).includes("synthetic-private-key"),
    false,
  );
  assert.match(JSON.stringify(first), /details remain useful/);
});

test("diagnostic bound includes the marker and has exact Unicode edge behavior", () => {
  const sanitizeDiagnostic = redactionModule.sanitizeDiagnostic;
  const exact = `${"a".repeat(15)}😀`;
  const within = sanitizeDiagnostic(exact, 16);
  const over = sanitizeDiagnostic(`${exact}b`, 16);

  assert.deepEqual(within, { text: exact, truncated: false });
  assert.equal(over.truncated, true);
  assert.equal([...over.text].length, 16);
  assert.match(over.text, /… \[truncated\]$/);
});
