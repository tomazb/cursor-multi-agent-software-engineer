import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { FileRunStore, migrateRunRecord } from "../src/store.ts";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";

type JsonSchema = {
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  const?: unknown;
  type?: string | string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
  pattern?: string;
  enum?: unknown[];
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
      assert.ok(key in obj, `${label}.${key} required`);
    }
    for (const [key, child] of Object.entries(effective.properties ?? {})) {
      if (key in obj) assertMatches(root, child, obj[key], `${label}.${key}`);
    }
  }
  if (effective.type === "array") {
    assert.ok(Array.isArray(value), label);
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
  if (effective.type === "integer" || effective.type === "number") {
    assert.equal(typeof value, "number", label);
    if (effective.minimum !== undefined) assert.ok(Number(value) >= effective.minimum, label);
    if (effective.maximum !== undefined) assert.ok(Number(value) <= effective.maximum, label);
  }
  if (effective.type === "boolean") {
    assert.equal(typeof value, "boolean", label);
  }
}

test("DEFAULT_CONFIG satisfies config JSON schema required shape", async () => {
  const schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/config.schema.json"), "utf8"),
  ) as JsonSchema;
  assertMatches(schema, schema, DEFAULT_CONFIG, "config");
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
  const runtimeSchema = failureSchema?.properties?.runtime;
  assert.ok(runtimeSchema, "failure.runtime schema");
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
  assert.equal(
    attemptsSchema?.items?.properties?.message?.maxLength,
    512,
  );
  assert.equal(
    attemptsSchema?.items?.properties?.model?.maxLength,
    256,
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
    "runtime" in (migrated.failure as Record<string, unknown>),
    false,
  );
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
