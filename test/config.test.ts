import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.ts";

test("config merges user values with safe defaults", async () => {
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
});

test("environment variables override role models", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-env-"));
  process.env.MASWE_MODEL_VERIFIER = "verified-model";
  try {
    const config = await loadConfig(cwd);
    assert.equal(config.roles.verifier.model, "verified-model");
  } finally {
    delete process.env.MASWE_MODEL_VERIFIER;
  }
});
