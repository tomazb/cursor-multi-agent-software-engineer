import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { spawnCaptured } from "../src/process.ts";
import { FileRunStore, migrateRunRecord } from "../src/store.ts";
import { CursorCliRuntime } from "../src/runtimes/cursor-cli.ts";

function historicalPersistedConfig() {
  const role = {
    model: "persisted-model",
    reasoning: "high",
    permissions: "read-only",
  };
  return {
    version: 1,
    runtime: {
      kind: "mock",
      command: "persisted-agent",
      outputFormat: "json",
    },
    roles: {
      brainstormer: { ...role },
      designer: { ...role },
      builder: { ...role, permissions: "workspace-write" },
      verifier: { ...role },
      prResolver: { ...role, permissions: "workspace-write" },
    },
    gates: {
      requireBrainstormApproval: true,
      requireDesignApproval: true,
      requireCiPass: true,
      requireVerifierPass: true,
    },
    quality: { commands: [] },
    policy: {
      rejectModelFallback: true,
      maxBuildVerifyCycles: 3,
      maxCommentResolutionCycles: 2,
      allowDirtyWorkspace: false,
    },
  };
}

function historicalRun(config: unknown, id = "historical-run") {
  return {
    schemaVersion: 1,
    version: 1,
    id,
    title: "historical",
    request: "persisted config migration",
    repositoryPath: "/tmp/persisted-repository",
    state: "CREATED",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    approvals: { brainstorm: false, design: false },
    counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
    config,
    artifacts: [],
    events: [],
  };
}

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
    config: historicalPersistedConfig(),
    artifacts: [],
    events: [],
  };
  await writeFile(path.join(runDir, "run.json"), `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

  const loaded = await store.load("legacy-run");
  assert.equal(typeof loaded.version, "number");
  assert.ok(loaded.version >= 1);
  assert.ok(Array.isArray(loaded.artifacts));
});

test("persisted config missing doctorProbeTimeoutMs normalizes to 60000", () => {
  const loaded = migrateRunRecord(historicalRun(historicalPersistedConfig()));
  assert.equal(loaded.config.policy.doctorProbeTimeoutMs, 60_000);
});

test("persisted config preserves an explicit valid doctorProbeTimeoutMs", () => {
  const config = historicalPersistedConfig();
  const loaded = migrateRunRecord(historicalRun({
    ...config,
    policy: {
      ...config.policy,
      doctorProbeTimeoutMs: 42_137,
    },
  }));
  assert.equal(loaded.config.policy.doctorProbeTimeoutMs, 42_137);
});

test("persisted config rejects an explicit invalid doctorProbeTimeoutMs", () => {
  const config = historicalPersistedConfig();
  assert.throws(
    () => migrateRunRecord(historicalRun({
      ...config,
      policy: {
        ...config.policy,
        doctorProbeTimeoutMs: 999,
      },
    })),
    /doctorProbeTimeoutMs/,
  );
});

test("persisted config migration ignores conflicting MASWE environment overrides", () => {
  const variables = [
    "MASWE_RUNTIME",
    "MASWE_MODEL_BRAINSTORMER",
    "MASWE_MODEL_DESIGNER",
    "MASWE_MODEL_BUILDER",
    "MASWE_MODEL_VERIFIER",
    "MASWE_MODEL_PR_RESOLVER",
  ] as const;
  const previous = new Map(variables.map((variable) => [variable, process.env[variable]]));
  const config = historicalPersistedConfig();
  const persisted = {
    ...config,
    runtime: {
      ...config.runtime,
      kind: "mock",
      command: "persisted-runtime-command",
    },
    roles: {
      ...config.roles,
      brainstormer: {
        ...config.roles.brainstormer,
        model: "persisted-brainstormer",
      },
    },
    policy: {
      ...config.policy,
      doctorProbeTimeoutMs: 73_211,
    },
  };

  try {
    process.env.MASWE_RUNTIME = "cursor-sdk";
    process.env.MASWE_MODEL_BRAINSTORMER = "environment-brainstormer";
    process.env.MASWE_MODEL_DESIGNER = "environment-designer";
    process.env.MASWE_MODEL_BUILDER = "environment-builder";
    process.env.MASWE_MODEL_VERIFIER = "environment-verifier";
    process.env.MASWE_MODEL_PR_RESOLVER = "environment-resolver";

    const loaded = migrateRunRecord(historicalRun(persisted));
    assert.equal(loaded.config.runtime.kind, "mock");
    assert.equal(loaded.config.runtime.command, "persisted-runtime-command");
    assert.equal(loaded.config.roles.brainstormer.model, "persisted-brainstormer");
    assert.equal(loaded.config.roles.designer.model, "persisted-model");
    assert.equal(loaded.config.roles.builder.model, "persisted-model");
    assert.equal(loaded.config.roles.verifier.model, "persisted-model");
    assert.equal(loaded.config.roles.prResolver.model, "persisted-model");
    assert.equal(loaded.config.policy.doctorProbeTimeoutMs, 73_211);
  } finally {
    for (const variable of variables) {
      const value = previous.get(variable);
      if (value === undefined) delete process.env[variable];
      else process.env[variable] = value;
    }
  }
});

test("doctor checks the configured stdin prompt transport path", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-node-stand-in-"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.kind = "cursor-cli";
  config.runtime.command = process.execPath;
  config.policy.promptTransport = "stdin";
  // Use node itself as a stand-in command: doctor should still report transport probe intent.
  let probeInvocations = 0;
  let observedProbeTimeout = -1;
  const runtime = new CursorCliRuntime(config, {
    cwd,
    spawnFn: async (command, args, options) => {
      if (args[0] === "-e") {
        probeInvocations += 1;
        observedProbeTimeout = options.timeoutMs;
        assert.equal(options.input, "maswe-stdin-probe");
      }
      return spawnCaptured(command, args, options);
    },
  });
  const report = await runtime.doctor();
  const transport = report.checks.find((c) => c.name === "prompt-transport");
  assert.ok(transport);
  assert.match(transport.message, /stdin/i);
  assert.equal(transport.code, "ok");
  const probe = report.checks.find((c) => c.name === "prompt-transport-probe");
  assert.ok(probe, "doctor must probe configured stdin execution path");
  assert.equal(probe.ok, true);
  assert.equal(probe.code, "ok");
  assert.equal(probeInvocations, 1);
  assert.equal(observedProbeTimeout, config.policy.doctorProbeTimeoutMs);
});
