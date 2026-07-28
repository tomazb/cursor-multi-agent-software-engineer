import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, mergeConfigForTest, migrateConfig } from "../src/config.ts";

const MASWE_ENV_KEYS = [
  "MASWE_RUNTIME",
  "MASWE_MODEL_BRAINSTORMER",
  "MASWE_MODEL_DESIGNER",
  "MASWE_MODEL_BUILDER",
  "MASWE_MODEL_VERIFIER",
  "MASWE_MODEL_PR_RESOLVER",
] as const;

function snapshotMasweEnv(): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of MASWE_ENV_KEYS) snapshot[key] = process.env[key];
  return snapshot;
}

function restoreMasweEnv(snapshot: Record<string, string | undefined>): void {
  for (const key of MASWE_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearMasweEnv(): void {
  for (const key of MASWE_ENV_KEYS) delete process.env[key];
}

test("config merges user values with safe defaults", async () => {
  const env = snapshotMasweEnv();
  clearMasweEnv();
  try {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-config-"));
    await mkdir(path.join(cwd, ".maswe"));
    await writeFile(
      path.join(cwd, ".maswe", "config.json"),
      JSON.stringify({
        runtime: { kind: "mock" },
        roles: { builder: { model: "custom-builder" } },
        quality: { commands: [] },
      }),
    );
    const config = await loadConfig(cwd);
    assert.equal(config.runtime.kind, "mock");
    assert.equal(config.roles.builder.model, "custom-builder");
    assert.equal(config.roles.verifier.model, "gpt-5.6-sol-high");
    assert.deepEqual(config.quality.commands, []);
  } finally {
    restoreMasweEnv(env);
  }
});

test("environment variables override role models", async () => {
  const env = snapshotMasweEnv();
  clearMasweEnv();
  process.env.MASWE_MODEL_VERIFIER = "verified-model";
  try {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-env-"));
    const config = await loadConfig(cwd);
    assert.equal(config.roles.verifier.model, "verified-model");
  } finally {
    restoreMasweEnv(env);
  }
});

test("host MASWE_MODEL_* env does not leak into file-backed defaults merge", async () => {
  const env = snapshotMasweEnv();
  clearMasweEnv();
  process.env.MASWE_MODEL_BUILDER = "cursor-grok-4.5-high";
  try {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-config-env-leak-"));
    await mkdir(path.join(cwd, ".maswe"));
    await writeFile(
      path.join(cwd, ".maswe", "config.json"),
      JSON.stringify({
        runtime: { kind: "mock" },
        roles: { builder: { model: "custom-builder" } },
        quality: { commands: [] },
      }),
    );
    // Without isolation, loadConfig would prefer the host env model.
    const polluted = await loadConfig(cwd);
    assert.equal(polluted.roles.builder.model, "cursor-grok-4.5-high");

    clearMasweEnv();
    const isolated = await loadConfig(cwd);
    assert.equal(isolated.roles.builder.model, "custom-builder");
  } finally {
    restoreMasweEnv(env);
  }
});

test("doctorProbeTimeoutMs defaults to 60000 when omitted", () => {
  const migrated = migrateConfig({
    policy: { commandTimeoutMs: 2_000 },
  });
  assert.equal(migrated.policy.doctorProbeTimeoutMs, 60_000);
});

test("doctorProbeTimeoutMs accepts explicit bounds and rejects invalid values", () => {
  assert.equal(
    mergeConfigForTest({ policy: { doctorProbeTimeoutMs: 1_000 } }).policy.doctorProbeTimeoutMs,
    1_000,
  );
  assert.equal(
    mergeConfigForTest({ policy: { doctorProbeTimeoutMs: 300_000 } }).policy.doctorProbeTimeoutMs,
    300_000,
  );

  const invalid = [0, -1, 999, 300_001, Number.NaN, Number.POSITIVE_INFINITY, 1.5];
  for (const value of invalid) {
    assert.throws(
      () => mergeConfigForTest({ policy: { doctorProbeTimeoutMs: value } }),
      /doctorProbeTimeoutMs/i,
      String(value),
    );
  }
});
