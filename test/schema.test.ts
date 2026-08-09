import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { MasweConfig, RuntimeFailureCode } from "../src/domain.ts";
import { FileRunStore, migrateRunRecord } from "../src/store.ts";
import os from "node:os";

type JsonSchema = {
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  allOf?: JsonSchema[];
  if?: JsonSchema;
  then?: JsonSchema;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  const?: unknown;
  type?: string | string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  enum?: unknown[];
  additionalProperties?: boolean;
};

function resolveRef(root: JsonSchema, schema: JsonSchema): JsonSchema {
  if (!schema.$ref) return schema;
  const match = schema.$ref.match(/^#\/\$defs\/(.+)$/);
  if (!match) throw new Error(`Unsupported $ref ${schema.$ref}`);
  const resolved = root.$defs?.[match[1]!];
  if (!resolved) throw new Error(`Missing $ref target ${schema.$ref}`);
  return resolved;
}

function assertMatches(root: JsonSchema, schema: JsonSchema, value: unknown, label: string): void {
  const effective = resolveRef(root, schema);
  for (const child of effective.allOf ?? []) {
    assertMatches(root, child, value, `${label}.allOf`);
  }
  if (effective.if && effective.then) {
    let conditionMatches = true;
    try {
      assertMatches(root, effective.if, value, `${label}.if`);
    } catch {
      conditionMatches = false;
    }
    if (conditionMatches) {
      assertMatches(root, effective.then, value, `${label}.then`);
    }
  }
  if (effective.const !== undefined) {
    assert.equal(value, effective.const, `${label} const`);
  }
  if (effective.enum) {
    assert.ok(effective.enum.includes(value), `${label} enum`);
  }
  if (effective.type === "object") {
    assert.equal(typeof value, "object", label);
    assert.ok(value && !Array.isArray(value), label);
    const obj = value as Record<string, unknown>;
    for (const key of effective.required ?? []) {
      assert.ok(Object.hasOwn(obj, key), `${label}.${key} required`);
    }
    for (const [key, child] of Object.entries(effective.properties ?? {})) {
      if (Object.hasOwn(obj, key)) {
        assertMatches(root, child, obj[key], `${label}.${key}`);
      }
    }
    if (effective.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        assert.ok(
          Object.hasOwn(effective.properties ?? {}, key),
          `${label}.${key} additionalProperties`,
        );
      }
    }
  }
  if (effective.type === "array") {
    assert.ok(Array.isArray(value), label);
    if (effective.minItems !== undefined) {
      assert.ok(
        (value as unknown[]).length >= effective.minItems,
        `${label} minItems`,
      );
    }
    if (effective.maxItems !== undefined) {
      assert.ok(
        (value as unknown[]).length <= effective.maxItems,
        `${label} maxItems`,
      );
    }
    if (effective.items) {
      for (const [index, item] of (value as unknown[]).entries()) {
        assertMatches(root, effective.items, item, `${label}[${index}]`);
      }
    }
  }
  if (effective.type === "string") {
    assert.equal(typeof value, "string", label);
    if (effective.minLength) assert.ok(String(value).length >= effective.minLength, label);
    if (effective.maxLength) assert.ok(String(value).length <= effective.maxLength, label);
    if (effective.pattern) {
      assert.match(String(value), new RegExp(effective.pattern), `${label} pattern`);
    }
  }
  if (effective.type === "integer") {
    assert.equal(typeof value, "number", label);
    assert.ok(Number.isInteger(value), `${label} integer`);
    if (effective.minimum !== undefined) assert.ok(Number(value) >= effective.minimum, label);
    if (effective.maximum !== undefined) assert.ok(Number(value) <= effective.maximum, label);
  }
  if (effective.type === "number") {
    assert.equal(typeof value, "number", label);
    if (effective.minimum !== undefined) assert.ok(Number(value) >= effective.minimum, label);
    if (effective.maximum !== undefined) assert.ok(Number(value) <= effective.maximum, label);
  }
  if (effective.type === "boolean") {
    assert.equal(typeof value, "boolean", label);
  }
}

async function loadConfigSchema(): Promise<JsonSchema> {
  return JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/config.schema.json"), "utf8"),
  ) as JsonSchema;
}

function configWithGitHubApp(
  overrides: Partial<NonNullable<MasweConfig["githubApp"]>> = {},
): MasweConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.githubApp = {
    enabled: true,
    readOnlyChecks: true,
    webhookSecretEnv: "MASWE_GITHUB_WEBHOOK_SECRET",
    appIdEnv: "MASWE_GITHUB_APP_ID",
    privateKeyEnv: "MASWE_GITHUB_APP_PRIVATE_KEY",
    allowedRepositories: ["owner/repo"],
    ...overrides,
  };
  return config;
}

test("schema assertion rejects fractional values for integer fields", () => {
  const integerSchema = { type: "integer" };

  assert.throws(
    () => assertMatches(integerSchema, integerSchema, 1.5, "integer"),
    /integer integer/,
  );
});

test("DEFAULT_CONFIG satisfies config JSON schema required shape", async () => {
  const schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/config.schema.json"), "utf8"),
  ) as JsonSchema;
  assertMatches(schema, schema, DEFAULT_CONFIG, "config");
});

test("config schema rejects enabled GitHub App write mode", async () => {
  const schema = await loadConfigSchema();
  const config = configWithGitHubApp({ readOnlyChecks: false });

  assert.throws(
    () => assertMatches(schema, schema, config, "config.githubApp.write-mode"),
    /const/,
  );
});

test("config schema rejects an enabled GitHub App with an empty allowlist", async () => {
  const schema = await loadConfigSchema();
  const config = configWithGitHubApp({ allowedRepositories: [] });

  assert.throws(
    () => assertMatches(schema, schema, config, "config.githubApp.empty-allowlist"),
    /minItems/,
  );
});

test("config schema accepts an enabled read-only GitHub App with an allowed repository", async () => {
  const schema = await loadConfigSchema();
  const config = configWithGitHubApp();

  assert.doesNotThrow(() =>
    assertMatches(schema, schema, config, "config.githubApp.enabled"),
  );
});

test("config schema accepts a disabled GitHub App with an empty allowlist", async () => {
  const schema = await loadConfigSchema();
  const config = configWithGitHubApp({ enabled: false, allowedRepositories: [] });

  assert.doesNotThrow(() =>
    assertMatches(schema, schema, config, "config.githubApp.disabled"),
  );
});

test("config schema requires the normalized doctor probe timeout", async () => {
  const schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/config.schema.json"), "utf8"),
  ) as JsonSchema;

  assert.ok(
    schema.properties?.policy?.required?.includes("doctorProbeTimeoutMs"),
    "policy.doctorProbeTimeoutMs must be required by the normalized config schema",
  );
});

test("persisted run records satisfy run-record schema required shape", async () => {
  const schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/run-record.schema.json"), "utf8"),
  ) as JsonSchema;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-schema-"));
  const store = new FileRunStore(cwd);
  const run = await store.create("schema", "check", DEFAULT_CONFIG);
  assertMatches(schema, schema, run, "run");
});

test("run-record schema validates optional bounded durable runtime failure metadata", async () => {
  const schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/run-record.schema.json"), "utf8"),
  ) as JsonSchema;
  const failureSchema = schema.properties?.failure;
  const runtimeSchemaReference = failureSchema?.properties?.runtime;
  assert.ok(runtimeSchemaReference, "failure.runtime schema");
  const runtimeSchema = resolveRef(schema, runtimeSchemaReference);
  assert.deepEqual(runtimeSchema.required, [
    "attempts",
    "totalAttempts",
    "omittedAttempts",
    "aggregateTruncated",
  ]);

  const sample = {
    attempts: [
      {
        model: "cursor-grok-4.5-high",
        code: "cursor-cli-non-zero",
        message: "Cursor CLI exited non-zero.",
        requestedModel: "cursor-grok-4.5-high",
        configuredModel: "cursor-grok-4.5-high",
        exitCode: 7,
        timedOut: false,
        durationMs: 42,
        promptTransport: "stdin",
        stderrPresent: true,
        truncated: false,
      },
    ],
    totalAttempts: 1,
    omittedAttempts: 0,
    aggregateTruncated: false,
  };
  assertMatches(schema, runtimeSchema, sample, "failure.runtime");

  const attemptsSchema = runtimeSchema.properties?.attempts;
  assert.equal(attemptsSchema?.maxItems, 8);
  assert.ok(attemptsSchema?.items);
  const attemptSchema = resolveRef(schema, attemptsSchema.items);
  assert.equal(
    attemptSchema.properties?.message?.maxLength,
    512,
  );
  assert.equal(
    attemptSchema.properties?.model?.maxLength,
    256,
  );
});

test("durable runtime schema accepts only its documented nested allowlist", async () => {
  const schema = JSON.parse(
    await readFile(
      path.join(process.cwd(), "schemas/run-record.schema.json"),
      "utf8",
    ),
  ) as JsonSchema;
  const runtimeReference = schema.properties?.failure?.properties?.runtime;
  assert.ok(runtimeReference);
  const runtimeSchema = resolveRef(schema, runtimeReference);
  const attemptsSchema = runtimeSchema.properties?.attempts;
  assert.ok(attemptsSchema?.items);
  const attemptSchema = resolveRef(schema, attemptsSchema.items);
  const validAttempt = {
    model: "cursor-grok-4.5-high",
    code: "cursor-cli-non-zero",
    message: "Cursor CLI exited non-zero.",
    requestedModel: "cursor-grok-4.5-high",
    configuredModel: "cursor-grok-4.5-high",
    exitCode: 7,
    timedOut: false,
    durationMs: 42,
    promptTransport: "stdin",
    stderrPresent: true,
    truncated: false,
  };
  const validSummary = {
    attempts: [validAttempt],
    totalAttempts: 1,
    omittedAttempts: 0,
    aggregateTruncated: false,
  };

  assert.doesNotThrow(() =>
    assertMatches(schema, attemptSchema, validAttempt, "validAttempt"),
  );
  assert.doesNotThrow(() =>
    assertMatches(schema, runtimeSchema, validSummary, "validSummary"),
  );

  const invalidCases: Array<{
    label: string;
    target: JsonSchema;
    value: unknown;
  }> = [
    {
      label: "attempt.adapterMetadata",
      target: attemptSchema,
      value: {
        ...validAttempt,
        adapterMetadata: { provider: "unsafe" },
      },
    },
    {
      label: "attempt.stderr",
      target: attemptSchema,
      value: {
        ...validAttempt,
        stderr: "raw runtime stderr",
      },
    },
    {
      label: "attempt.unknownObject",
      target: attemptSchema,
      value: {
        ...validAttempt,
        futureAdapterObject: { nested: true },
      },
    },
    {
      label: "attempt.prototypeNamedProperty",
      target: attemptSchema,
      value: {
        ...validAttempt,
        toString: "must not inherit schema properties",
      },
    },
    {
      label: "summary.arbitrary",
      target: runtimeSchema,
      value: {
        ...validSummary,
        arbitrarySummaryProperty: "unsafe",
      },
    },
  ];
  for (const invalid of invalidCases) {
    assert.throws(
      () =>
        assertMatches(
          schema,
          invalid.target,
          invalid.value,
          invalid.label,
        ),
      /additionalProperties/,
      invalid.label,
    );
  }
});

test("runtime failure code schema enum stays synchronized with the TypeScript union", async () => {
  const schema = JSON.parse(
    await readFile(
      path.join(process.cwd(), "schemas/run-record.schema.json"),
      "utf8",
    ),
  ) as JsonSchema;
  const runtimeCodes = {
    "cursor-cli-non-zero": true,
    "cursor-cli-timeout": true,
    "cursor-cli-spawn": true,
    "cursor-sdk-error": true,
    "runtime-error": true,
    "invalid-transport-json": true,
    "unsupported-response-shape": true,
    "missing-logical-output": true,
  } satisfies Record<RuntimeFailureCode, true>;
  const attemptSchema = resolveRef(
    schema,
    schema.$defs?.durableRuntimeFailureAttempt ?? {},
  );

  assert.deepEqual(
    [...(attemptSchema.properties?.code?.enum ?? [])].sort(),
    Object.keys(runtimeCodes).sort(),
  );
});

test("schema accepts retry and supersede records with allowlisted runtime metadata", async (t) => {
  const schema = JSON.parse(
    await readFile(
      path.join(process.cwd(), "schemas/run-record.schema.json"),
      "utf8",
    ),
  ) as JsonSchema;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-schema-history-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("schema history", "check", DEFAULT_CONFIG);
  const failure = {
    code: "runtime-models-exhausted" as const,
    message: "runtime exhausted",
    at: "2026-07-27T00:00:00.000Z",
    resumeState: "BRAINSTORMING" as const,
    runtime: {
      attempts: [
        {
          model: "cursor-grok-4.5-high",
          code: "cursor-cli-non-zero" as const,
          message: "Cursor CLI exited non-zero.",
          stderrPresent: true,
          truncated: false,
        },
      ],
      totalAttempts: 1,
      omittedAttempts: 0,
      aggregateTruncated: false,
    },
  };
  run.failure = failure;
  await store.save(run);
  const failed = await store.applyEvent(run, "FAIL", "test", {
    reason: failure.message,
    runtime: failure.runtime,
    resumeState: failure.resumeState,
  });
  const previousFailure = failed.failure;
  delete failed.failure;
  const retried = await store.applyEvent(
    failed,
    "RETRY_FROM_FAILED",
    "test",
    {
      resumeState: "BRAINSTORMING",
      previousFailure,
    },
  );
  assert.doesNotThrow(() => assertMatches(schema, schema, retried, "retry"));

  const replacement = await store.create(
    retried.title,
    retried.request,
    retried.config,
  );
  retried.supersededBy = replacement.id;
  replacement.supersedes = retried.id;
  await store.save(retried);
  await store.save(replacement);

  for (const [label, record] of [
    ["superseded", await store.load(retried.id)],
    ["replacement", await store.load(replacement.id)],
  ] as const) {
    assert.doesNotThrow(() => assertMatches(schema, schema, record, label));
  }
});

test("schema version 1 still accepts historical unbounded failure messages", async () => {
  const schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/run-record.schema.json"), "utf8"),
  ) as JsonSchema;
  const failureSchema = schema.properties?.failure;
  assert.ok(failureSchema);

  assert.doesNotThrow(() =>
    assertMatches(
      schema,
      failureSchema,
      {
        message: "historical stderr ".repeat(1_000),
        at: "2026-07-01T00:00:00.000Z",
      },
      "failure",
    )
  );
});

test("schema-version-1 migration loads an old failure record without runtime metadata", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-old-failure-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("old failure", "check", DEFAULT_CONFIG);
  const oldRecord = JSON.parse(JSON.stringify(run)) as Record<string, unknown>;
  oldRecord.failure = {
    code: "workflow-failure",
    message: "historical failure",
    at: "2026-07-01T00:00:00.000Z",
    resumeState: "BRAINSTORMING",
  };

  const migrated = migrateRunRecord(oldRecord);

  assert.deepEqual(migrated.failure, oldRecord.failure);
  assert.equal(
    "runtime" in (migrated.failure as unknown as Record<string, unknown>),
    false,
  );
});

test("schema-version-1 migration bounds and sanitizes optional runtime metadata", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-runtime-migration-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("runtime migration", "check", DEFAULT_CONFIG);
  const canary = "MIGRATION_RUNTIME_CANARY";
  const raw = JSON.parse(JSON.stringify(run)) as Record<string, unknown>;
  raw.failure = {
    code: "runtime-models-exhausted",
    message: `token=${canary}`,
    at: "2026-07-01T00:00:00.000Z",
    runtime: {
      attempts: Array.from({ length: 12 }, (_, index) => ({
        model: `model-${index}\n | forged [runtime-error]: entry`,
        code: index === 0 ? "not-a-runtime-code" : "runtime-error",
        message: `token=${canary}-${index}${"x".repeat(1_000)}`,
        requestedModel: `requested-${index}\u0000`,
        stderrPresent: true,
        truncated: false,
        adapterMetadata: { raw: canary },
      })),
      totalAttempts: 12,
      omittedAttempts: 0,
      aggregateTruncated: true,
      adapterMetadata: { raw: canary },
    },
  };

  const migrated = migrateRunRecord(raw);
  const serialized = JSON.stringify(migrated.failure);
  const runtime = migrated.failure?.runtime;

  assert.equal(serialized.includes(canary), false);
  assert.ok(runtime);
  assert.equal(runtime.attempts.length, 8);
  assert.equal(runtime.totalAttempts, 12);
  assert.equal(runtime.omittedAttempts, 4);
  assert.equal(runtime.attempts[0]?.code, "runtime-error");
  assert.ok(
    runtime.attempts.every(
      (attempt) =>
        [...attempt.message].length <= 512 &&
        !/[\r\n\u0000-\u001f\u007f-\u009f]/.test(attempt.model) &&
        !/[\r\n\u0000-\u001f\u007f-\u009f]/.test(
          attempt.requestedModel ?? "",
        ) &&
        !("adapterMetadata" in attempt),
    ),
  );
  assert.equal("adapterMetadata" in runtime, false);
});

test("run-record schema rejects non-hex sha256 digests", async () => {
  const schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/run-record.schema.json"), "utf8"),
  ) as JsonSchema;
  const artifactSchema = schema.properties?.artifacts?.items;
  assert.ok(artifactSchema);
  assert.throws(
    () =>
      assertMatches(
        schema,
        artifactSchema!,
        {
          name: "x",
          logicalName: "x",
          attempt: 1,
          path: "x",
          sha256: "z".repeat(64),
          createdAt: new Date().toISOString(),
        },
        "artifact",
      ),
    /pattern/,
  );
});

test("config schema accepts stream-json outputFormat and rejects unknown values", async () => {
  const schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/config.schema.json"), "utf8"),
  ) as JsonSchema;
  const outputFormat = schema.properties?.runtime?.properties?.outputFormat;
  assert.ok(outputFormat?.enum);
  assert.deepEqual(outputFormat.enum, ["json", "text", "stream-json"]);

  const withStream = structuredClone(DEFAULT_CONFIG);
  withStream.runtime.outputFormat = "stream-json";
  assertMatches(schema, schema, withStream, "config.stream-json");

  const bad = structuredClone(DEFAULT_CONFIG) as { runtime: { outputFormat: string } };
  bad.runtime.outputFormat = "yaml";
  assert.throws(() => assertMatches(schema, schema, bad, "config.bad-format"), /enum/);
});

test("config schema validates doctorProbeTimeoutMs bounds and integer type", async () => {
  const schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/config.schema.json"), "utf8"),
  ) as JsonSchema;

  const min = structuredClone(DEFAULT_CONFIG);
  (min.policy as Record<string, unknown>).doctorProbeTimeoutMs = 1_000;
  assert.doesNotThrow(() => assertMatches(schema, schema, min, "config.doctorProbeTimeoutMs.min"));

  const max = structuredClone(DEFAULT_CONFIG);
  (max.policy as Record<string, unknown>).doctorProbeTimeoutMs = 300_000;
  assert.doesNotThrow(() => assertMatches(schema, schema, max, "config.doctorProbeTimeoutMs.max"));

  const tooLow = structuredClone(DEFAULT_CONFIG);
  (tooLow.policy as Record<string, unknown>).doctorProbeTimeoutMs = 999;
  assert.throws(
    () => assertMatches(schema, schema, tooLow, "config.doctorProbeTimeoutMs.low"),
    /config\.doctorProbeTimeoutMs\.low/,
  );

  const tooHigh = structuredClone(DEFAULT_CONFIG);
  (tooHigh.policy as Record<string, unknown>).doctorProbeTimeoutMs = 300_001;
  assert.throws(
    () => assertMatches(schema, schema, tooHigh, "config.doctorProbeTimeoutMs.high"),
    /config\.doctorProbeTimeoutMs\.high/,
  );

  const fractional = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>;
  (fractional.policy as Record<string, unknown>).doctorProbeTimeoutMs = 1.5;
  assert.throws(
    () => assertMatches(schema, schema, fractional, "config.doctorProbeTimeoutMs.fractional"),
    /integer/,
  );
});
