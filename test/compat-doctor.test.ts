import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { FileRunStore } from "../src/store.ts";
import { CursorCliRuntime } from "../src/runtimes/cursor-cli.ts";

test("load fails closed or migrates v0.1 run records missing version", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-migrate-"));
  const store = new FileRunStore(cwd);
  const runDir = path.join(cwd, ".maswe", "runs", "legacy-run");
  await mkdir(path.join(runDir, "artifacts"), { recursive: true });
  const legacy = {
    schemaVersion: 1,
    id: "legacy-run",
    title: "legacy",
    request: "old",
    repositoryPath: cwd,
    state: "CREATED",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    approvals: { brainstorm: false, design: false },
    counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
    config: DEFAULT_CONFIG,
    artifacts: [],
    events: [],
  };
  await writeFile(path.join(runDir, "run.json"), `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

  const loaded = await store.load("legacy-run");
  assert.equal(typeof loaded.version, "number");
  assert.ok(loaded.version >= 1);
  assert.ok(Array.isArray(loaded.artifacts));
});

test("doctor checks the configured stdin prompt transport path", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.kind = "cursor-cli";
  config.runtime.command = process.execPath;
  config.policy.promptTransport = "stdin";
  // Use node itself as a stand-in command: doctor should still report transport probe intent.
  const runtime = new CursorCliRuntime(config);
  const report = await runtime.doctor();
  const transport = report.checks.find((c) => c.name === "prompt-transport");
  assert.ok(transport);
  assert.match(transport.message, /stdin/i);
  const probe = report.checks.find((c) => c.name === "prompt-transport-probe");
  assert.ok(probe, "doctor must probe configured stdin execution path");
});
