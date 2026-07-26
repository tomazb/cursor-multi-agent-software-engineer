import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  logicalModelCore,
  pickCatalogueModel,
  resolveConfigModels,
  resolveLogicalModelId,
  resolveProjectModels,
  validatePersistedExactModel,
} from "../src/model-resolution.ts";
import { FileRunStore } from "../src/store.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import type { AgentRuntime, RuntimeDoctorResult, RuntimeRequest, RuntimeResult } from "../src/domain.ts";

const CATALOGUE = [
  "cursor-grok-4.5-high",
  "cursor-grok-4.5-high-fast",
  "cursor-grok-4.5-low",
  "cursor-grok-4.5-medium",
  "cursor-claude-fable-5-high",
  "cursor-claude-opus-4.8-high",
  "gpt-5.6-sol-high",
  "gpt-5.4-high",
];

test("logicalModelCore strips cursor prefix and effort suffixes", () => {
  assert.equal(logicalModelCore("cursor-grok-4.5-high"), "grok-4.5");
  assert.equal(logicalModelCore("cursor-grok-4.5-high-fast"), "grok-4.5");
  assert.equal(logicalModelCore("grok-4.5"), "grok-4.5");
});

test("resolveLogicalModelId returns exact catalogue IDs", () => {
  assert.equal(resolveLogicalModelId("gpt-5.6-sol-high", CATALOGUE), "gpt-5.6-sol-high");
});

test("resolveLogicalModelId resolves logical names to the preferred catalogue ID", () => {
  assert.equal(resolveLogicalModelId("grok-4.5", CATALOGUE), "cursor-grok-4.5-high");
  assert.equal(resolveLogicalModelId("claude-fable-5", CATALOGUE), "cursor-claude-fable-5-high");
});

test("resolveLogicalModelId fails closed when no model matches", () => {
  assert.throws(() => resolveLogicalModelId("no-such-model", CATALOGUE), /Unknown model/);
});

test("resolveLogicalModelId fails closed on ambiguous cross-core matches", () => {
  assert.throws(() => resolveLogicalModelId("gpt-5", CATALOGUE), /Ambiguous model/);
});

test("resolveLogicalModelId keeps explicit high effort when high is available", () => {
  const catalogue = ["cursor-gpt-5.6-sol-medium", "cursor-gpt-5.6-sol-high", "cursor-gpt-5.6-sol-low"];
  assert.equal(resolveLogicalModelId("gpt-5.6-sol-high", catalogue), "cursor-gpt-5.6-sol-high");
});

test("resolveLogicalModelId fails closed when requested high effort is absent", () => {
  const catalogue = ["cursor-gpt-5.6-sol-medium", "cursor-gpt-5.6-sol-low"];
  assert.throws(
    () => resolveLogicalModelId("gpt-5.6-sol-high", catalogue),
    /effort.*high|high.*unavailable|requested effort/i,
  );
});

test("resolveLogicalModelId fails closed when requested medium effort is absent (no silent upgrade)", () => {
  const catalogue = ["cursor-gpt-5.6-sol-high", "cursor-gpt-5.6-sol-low"];
  assert.throws(
    () => resolveLogicalModelId("gpt-5.6-sol-medium", catalogue),
    /effort.*medium|medium.*unavailable|requested effort/i,
  );
});

test("resolveLogicalModelId selects deterministically among same-effort variants", () => {
  const catalogue = [
    "cursor-gpt-5.6-sol-high-fast",
    "cursor-gpt-5.6-sol-high",
    "cursor-gpt-5.6-sol-medium",
  ];
  assert.equal(resolveLogicalModelId("gpt-5.6-sol-high", catalogue), "cursor-gpt-5.6-sol-high");
});

test("resolveLogicalModelId without effort uses documented preference among same core", () => {
  const catalogue = ["cursor-grok-4.5-medium", "cursor-grok-4.5-high", "cursor-grok-4.5-low"];
  assert.equal(resolveLogicalModelId("grok-4.5", catalogue), "cursor-grok-4.5-high");
});

test("resolveProjectModels with rejectModelFallback does not silently downgrade effort", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.policy.rejectModelFallback = true;
  // Catalogue contains only medium for the gpt-5.6-sol family. Other roles use that
  // exact ID so project-level iteration reaches the verifier effort failure.
  config.roles.brainstormer.model = "cursor-gpt-5.6-sol-medium";
  config.roles.designer.model = "cursor-gpt-5.6-sol-medium";
  delete config.roles.designer.fallbackModels;
  config.roles.builder.model = "cursor-gpt-5.6-sol-medium";
  config.roles.verifier.model = "gpt-5.6-sol-high";
  config.roles.prResolver.model = "cursor-gpt-5.6-sol-medium";
  const inputSnapshot = structuredClone(config);
  const catalogue = ["cursor-gpt-5.6-sol-medium"];

  assert.throws(
    () => resolveProjectModels(config, catalogue),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /role ['"]verifier['"]/i);
      assert.match(error.message, /effort.*high|high.*unavailable|requested effort/i);
      return true;
    },
  );
  // Fail-closed: no partially resolved configuration is returned; input is not mutated.
  assert.deepEqual(config, inputSnapshot);
});

test("resolveProjectModels succeeds with matching high effort and leaves input immutable", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.policy.rejectModelFallback = true;
  config.roles.verifier.model = "gpt-5.6-sol-high";
  const inputSnapshot = structuredClone(config);
  const catalogue = [
    "cursor-grok-4.5-high",
    "cursor-claude-fable-5-high",
    "cursor-claude-opus-4.8-high",
    "cursor-gpt-5.6-sol-high",
    "cursor-gpt-5.6-sol-medium",
  ];

  const resolved = resolveProjectModels(config, catalogue);
  assert.equal(resolved.roles.verifier.model, "cursor-gpt-5.6-sol-high");
  assert.equal(resolved.roles.brainstormer.model, "cursor-grok-4.5-high");
  assert.equal(resolved.roles.designer.model, "cursor-claude-fable-5-high");
  assert.equal(resolved.roles.designer.fallbackModels?.[0], "claude-opus-4.8");
  assert.equal(resolved.roles.builder.model, "cursor-grok-4.5-high");
  assert.equal(resolved.roles.prResolver.model, "cursor-gpt-5.6-sol-high");
  assert.notEqual(resolved, config);
  assert.deepEqual(config, inputSnapshot);
  assert.equal(config.roles.verifier.model, "gpt-5.6-sol-high");
});

test("validatePersistedExactModel refuses substitution when high disappears and medium remains", () => {
  assert.throws(
    () => validatePersistedExactModel("gpt-5.6-sol-high", ["cursor-gpt-5.6-sol-medium"]),
    /no longer available|Refusing substitution/i,
  );
});

test("doctor probe and start share effort-aware project resolution", () => {
  const catalogue = [
    "cursor-grok-4.5-high",
    "cursor-claude-fable-5-high",
    "cursor-claude-opus-4.8-high",
    "cursor-gpt-5.6-sol-high",
    "cursor-gpt-5.6-sol-medium",
  ];
  const forStart = resolveProjectModels(DEFAULT_CONFIG, catalogue);
  const doctorProbeModel = resolveLogicalModelId(DEFAULT_CONFIG.roles.brainstormer.model, catalogue);
  assert.equal(forStart.roles.brainstormer.model, doctorProbeModel);
  assert.equal(forStart.roles.verifier.model, "cursor-gpt-5.6-sol-high");
  assert.equal(
    forStart.roles.verifier.model,
    resolveLogicalModelId(DEFAULT_CONFIG.roles.verifier.model, catalogue),
  );
});

test("resolveConfigModels rewrites enabled fallback models to exact IDs", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.policy.rejectModelFallback = false;
  const resolved = resolveConfigModels(config, CATALOGUE);
  assert.equal(resolved.roles.brainstormer.model, "cursor-grok-4.5-high");
  assert.equal(resolved.roles.designer.model, "cursor-claude-fable-5-high");
  assert.equal(resolved.roles.designer.fallbackModels?.[0], "cursor-claude-opus-4.8-high");
  assert.equal(resolved.roles.verifier.model, "gpt-5.6-sol-high");
});

test("pickCatalogueModel accepts an approved exact override and otherwise uses the ordered allowlist", () => {
  assert.equal(pickCatalogueModel(CATALOGUE, "cursor-grok-4.5-low"), "cursor-grok-4.5-low");
  assert.equal(pickCatalogueModel(CATALOGUE), "cursor-grok-4.5-high");
});

test("persisted run continues using resolved model after environment changes", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-model-persist-"));
  await mkdir(path.join(cwd, ".maswe"), { recursive: true });

  const catalogue = [...CATALOGUE];
  class ResolvingMock implements AgentRuntime {
    async listModels(): Promise<string[]> {
      return catalogue;
    }
    async execute(request: RuntimeRequest): Promise<RuntimeResult> {
      return {
        status: "finished",
        output: `# mock\n\nREADY_FOR_BRAINSTORM_APPROVAL\n`,
        requestedModel: request.roleConfig.model,
        actualModel: request.roleConfig.model,
      };
    }
    async doctor(): Promise<RuntimeDoctorResult> {
      return { ok: true, checks: [] };
    }
  }

  process.env.MASWE_MODEL_BRAINSTORMER = "should-not-apply-to-existing-run";
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.runtime.kind = "mock";
    config.policy.useIsolatedWorktree = false;
    config.policy.allowDirtyWorkspace = true;
    const resolved = resolveConfigModels(config, catalogue);
    assert.equal(resolved.roles.brainstormer.model, "cursor-grok-4.5-high");

    const store = new FileRunStore(cwd);
    const orchestrator = new Orchestrator(cwd, resolved, new ResolvingMock(), store);
    const run = await orchestrator.start("persist-models", "short request");
    assert.equal(run.config.roles.brainstormer.model, "cursor-grok-4.5-high");

    // Environment mutation must not rewrite the snapshotted run config.
    const reloaded = await store.load(run.id);
    assert.equal(reloaded.config.roles.brainstormer.model, "cursor-grok-4.5-high");
    assert.notEqual(process.env.MASWE_MODEL_BRAINSTORMER, reloaded.config.roles.brainstormer.model);
  } finally {
    delete process.env.MASWE_MODEL_BRAINSTORMER;
  }
});
