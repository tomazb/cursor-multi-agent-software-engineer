import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { FileRunStore } from "../src/store.ts";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";

type JsonSchema = {
  required?: string[];
  properties?: Record<string, JsonSchema & { const?: unknown; type?: string | string[]; minimum?: number; minLength?: number; enum?: unknown[] }>;
  const?: unknown;
  type?: string | string[];
  minimum?: number;
  minLength?: number;
  enum?: unknown[];
};

function assertMatches(schema: JsonSchema, value: unknown, label: string): void {
  if (schema.const !== undefined) {
    assert.equal(value, schema.const, `${label} const`);
  }
  if (schema.enum) {
    assert.ok(schema.enum.includes(value), `${label} enum`);
  }
  if (schema.type === "object") {
    assert.equal(typeof value, "object", label);
    assert.ok(value && !Array.isArray(value), label);
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      assert.ok(key in obj, `${label}.${key} required`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in obj) assertMatches(child, obj[key], `${label}.${key}`);
    }
  }
  if (schema.type === "array") {
    assert.ok(Array.isArray(value), label);
  }
  if (schema.type === "string") {
    assert.equal(typeof value, "string", label);
    if (schema.minLength) assert.ok(String(value).length >= schema.minLength, label);
  }
  if (schema.type === "integer" || schema.type === "number") {
    assert.equal(typeof value, "number", label);
    if (schema.minimum !== undefined) assert.ok(Number(value) >= schema.minimum, label);
  }
  if (schema.type === "boolean") {
    assert.equal(typeof value, "boolean", label);
  }
}

test("DEFAULT_CONFIG satisfies config JSON schema required shape", async () => {
  const schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/config.schema.json"), "utf8"),
  ) as JsonSchema;
  assertMatches(schema, DEFAULT_CONFIG, "config");
});

test("persisted run records satisfy run-record schema required shape", async () => {
  const schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/run-record.schema.json"), "utf8"),
  ) as JsonSchema;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-schema-"));
  const store = new FileRunStore(cwd);
  const run = await store.create("schema", "check", DEFAULT_CONFIG);
  assertMatches(schema, run, "run");
});
