import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test("redacts synthetic modern GitHub fine-grained PAT shapes", () => {
  const token =
    "github_pat_11SYNTHETICREDACTIONONLY_abcdefghijklmnopqrstuvwxyz0123456789";
  const redacted = redactSecrets(`provider rejected ${token}`);

  assert.equal(redacted.includes(token), false);
  assert.equal(redacted, "provider rejected [REDACTED]");
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
  assert.match(redacted, /https:\/\/\[REDACTED\]@example\.invalid\/private/);
  assert.match(redacted, /safe=yes/);
});

test("redacts HTTP username-only URI userinfo", () => {
  const redacted = redactSecrets(
    "https://opaque-http-credential@example.invalid/repo",
  );
  assert.equal(redacted.includes("opaque-http-credential"), false);
  assert.match(
    redacted,
    /https:\/\/\[REDACTED\]@example\.invalid\/repo/,
  );
});

test("redacts SSH and git+https username-only URI userinfo without changing ordinary email text", () => {
  const input = [
    "ssh://opaque-ssh-credential@example.invalid:2222/repo?ref=main#readme",
    "git+https://opaque-git-credential@example.invalid/org/repo.git",
    "contact release-engineering@example.invalid for help",
  ].join("\n");
  const redacted = redactSecrets(input);

  assert.equal(redacted.includes("opaque-ssh-credential"), false);
  assert.equal(redacted.includes("opaque-git-credential"), false);
  assert.match(
    redacted,
    /ssh:\/\/\[REDACTED\]@example\.invalid:2222\/repo\?ref=main#readme/,
  );
  assert.match(
    redacted,
    /git\+https:\/\/\[REDACTED\]@example\.invalid\/org\/repo\.git/,
  );
  assert.match(redacted, /release-engineering@example\.invalid/);
});

test("redacts malformed credential-like URI authorities fail-safely", () => {
  const input = [
    "https://opaque-missing-host@",
    "ssh://first:second:opaque@example.invalid/repo",
  ].join("\n");

  const redacted = redactSecrets(input);

  assert.equal(redacted.includes("opaque-missing-host"), false);
  assert.equal(redacted.includes("first:second:opaque"), false);
  assert.equal(
    redacted,
    [
      "https://[REDACTED]@",
      "ssh://[REDACTED]@example.invalid/repo",
    ].join("\n"),
  );
});

test("redacts provider-prefixed API key assignments", () => {
  const input = [
    "CURSOR_API_KEY=cursor-prefixed-synthetic-value",
    "OPENAI_API_KEY: openai-prefixed-synthetic-value",
    'ANTHROPIC_API_KEY="anthropic-prefixed-synthetic-value"',
  ].join("\n");

  const redacted = redactSecrets(input);

  assert.equal(redacted.includes("cursor-prefixed-synthetic-value"), false);
  assert.equal(redacted.includes("openai-prefixed-synthetic-value"), false);
  assert.equal(redacted.includes("anthropic-prefixed-synthetic-value"), false);
  assert.equal(redacted.match(/\[REDACTED\]/g)?.length, 3);
  assert.equal(
    redacted,
    [
      "CURSOR_API_KEY=[REDACTED]",
      "OPENAI_API_KEY: [REDACTED]",
      'ANTHROPIC_API_KEY="[REDACTED]"',
    ].join("\n"),
  );
});

test("redacts JSON-quoted secret, token, and signature assignments", () => {
  const input =
    '{"access_token":"json-access-value","secret":"json-secret-value","signature":"json-signature-value","sig":"json-sig-value"}';

  const redacted = redactSecrets(input);

  for (const secret of [
    "json-access-value",
    "json-secret-value",
    "json-signature-value",
    "json-sig-value",
  ]) {
    assert.equal(redacted.includes(secret), false, `leaked ${secret}`);
  }
  assert.equal(
    redacted,
    '{"access_token":"[REDACTED]","secret":"[REDACTED]","signature":"[REDACTED]","sig":"[REDACTED]"}',
  );
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

test("redacts a long assignment crossing the retained diagnostic boundary", () => {
  const prefix = "safe ".repeat(403);
  const secret = "boundary-secret-prefix-" + "z".repeat(32_000);
  const result = redactionModule.sanitizeDiagnostic(
    `${prefix}token=${secret}`,
    2_048,
  );

  assert.equal(result.truncated, true);
  assert.equal(result.text.includes("boundary-secret-prefix"), false);
  assert.equal(result.text.includes("token=boundary"), false);
  assert.match(result.text, /token=\[REDACTED\]/);
  assert.ok([...result.text].length <= 2_048);
});

test("assignment sanitizer work scales below the former quadratic curve", () => {
  const moduleUrl = new URL("../src/redaction.ts", import.meta.url).href;
  const script = `
    import { performance } from "node:perf_hooks";
    import { sanitizeDiagnostic } from ${JSON.stringify(moduleUrl)};

    function median(values) {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    }

    function measure(size) {
      const input = "A-".repeat(size / 2);
      const samples = [];
      sanitizeDiagnostic(input, 2_048);
      for (let index = 0; index < 3; index += 1) {
        const started = performance.now();
        sanitizeDiagnostic(input, 2_048);
        samples.push(performance.now() - started);
      }
      return median(samples);
    }

    const smallMs = measure(20_000);
    const largeMs = measure(40_000);
    process.stdout.write(JSON.stringify({ smallMs, largeMs, ratio: largeMs / smallMs }));
  `;
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      script,
    ],
    { encoding: "utf8", timeout: 15_000 },
  );

  assert.equal(
    result.status,
    0,
    `sanitizer scaling probe failed: ${result.stderr}`,
  );
  const measured = JSON.parse(result.stdout) as {
    smallMs: number;
    largeMs: number;
    ratio: number;
  };
  assert.ok(
    measured.ratio < 3,
    `doubling adversarial input scaled ${measured.ratio.toFixed(2)}x (${measured.smallMs.toFixed(2)}ms -> ${measured.largeMs.toFixed(2)}ms)`,
  );
});

test("assignment sanitizer handles large match-heavy input within a hard bound", () => {
  const moduleUrl = new URL("../src/redaction.ts", import.meta.url).href;
  const script = `
    import { sanitizeDiagnostic } from ${JSON.stringify(moduleUrl)};
    const input = Array.from(
      { length: 20_000 },
      (_, index) => "TOKEN=synthetic-match-" + index,
    ).join("\\n");
    const result = sanitizeDiagnostic(input, 2_048);
    if (!result.truncated || result.text.includes("synthetic-match-")) process.exit(2);
  `;
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      script,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );

  assert.equal(
    result.status,
    0,
    `match-heavy sanitizer probe failed: ${result.stderr}`,
  );
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

test("bounds very large diagnostics without materializing every code point", () => {
  const moduleUrl = new URL("../src/redaction.ts", import.meta.url).href;
  const script = `
    import { sanitizeDiagnostic } from ${JSON.stringify(moduleUrl)};
    const result = sanitizeDiagnostic("x".repeat(64_000_000), 128);
    if (!result.truncated || [...result.text].length !== 128) process.exit(2);
  `;
  const result = spawnSync(
    process.execPath,
    [
      "--max-old-space-size=48",
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      script,
    ],
    { encoding: "utf8", timeout: 20_000 },
  );

  assert.equal(
    result.status,
    0,
    `constrained-heap sanitizer failed: ${result.stderr}`,
  );
});
