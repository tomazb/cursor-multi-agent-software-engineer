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

test("resolveConfigModels rewrites all role models to exact IDs", () => {
  const resolved = resolveConfigModels(DEFAULT_CONFIG, CATALOGUE);
  assert.equal(resolved.roles.brainstormer.model, "cursor-grok-4.5-high");
  assert.equal(resolved.roles.designer.model, "cursor-claude-fable-5-high");
  assert.equal(resolved.roles.designer.fallbackModels?.[0], "cursor-claude-opus-4.8-high");
  assert.equal(resolved.roles.verifier.model, "gpt-5.6-sol-high");
});

test("pickCatalogueModel prefers env override when present, else grok family", () => {
  assert.equal(pickCatalogueModel(CATALOGUE, "cursor-grok-4.5-low"), "cursor-grok-4.5-low");
  assert.equal(pickCatalogueModel(CATALOGUE, "missing-model"), "cursor-grok-4.5-high");
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
