import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { MasweConfig, RunRecord } from "../src/domain.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { renderRun } from "../src/run-rendering.ts";
import { MockRuntime } from "../src/runtimes/mock.ts";
import { FileRunStore } from "../src/store.ts";

function config(overrides: (value: MasweConfig) => void = () => undefined): MasweConfig {
  const value = structuredClone(DEFAULT_CONFIG);
  value.runtime.kind = "mock";
  value.policy.useIsolatedWorktree = false;
  value.quality.commands = [];
  overrides(value);
  return value;
}

async function createRunInState(
  store: FileRunStore,
  value: MasweConfig,
  state: "BRAINSTORMING" | "BUILDING",
): Promise<RunRecord> {
  const run = await store.create("transition limit", "exercise automatic transitions", value);
  await store.applyEvent(run, "START", "user");
  if (state === "BRAINSTORMING") return run;
  await store.applyEvent(run, "BRAINSTORM_COMPLETED", "brainstormer");
  await store.applyEvent(run, "APPROVE_BRAINSTORM", "user");
  await store.applyEvent(run, "DESIGN_COMPLETED", "designer");
  await store.applyEvent(run, "APPROVE_DESIGN", "user");
  return run;
}

test("an approval gate reached at the automatic transition limit wins", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-transition-gate-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const orchestrator = new Orchestrator(cwd, config(), new MockRuntime(), store, {
    automaticTransitionLimit: 1,
  });

  const run = await orchestrator.start("gate at boundary", "stop for approval");
  const reloaded = await store.load(run.id);

  assert.equal(reloaded.state, "WAITING_FOR_BRAINSTORM_APPROVAL");
  assert.equal(reloaded.failure, undefined);
});

test("a terminal workflow failure reached at the automatic transition limit wins", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-transition-terminal-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const value = config((current) => {
    current.policy.maxBuildVerifyCycles = 1;
  });
  const store = new FileRunStore(cwd);
  const run = await createRunInState(store, value, "BUILDING");
  run.counters.buildVerifyCycles = value.policy.maxBuildVerifyCycles;
  await store.save(run);
  const orchestrator = new Orchestrator(cwd, value, new MockRuntime(), store, {
    automaticTransitionLimit: 1,
  });

  const result = await orchestrator.runUntilBlocked(run.id);
  const reloaded = await store.load(result.id);

  assert.equal(reloaded.state, "FAILED");
  assert.equal(reloaded.failure?.code, "workflow-failure");
  assert.equal(
    reloaded.events.filter((event) => event.type === "FAIL").length,
    1,
  );
});

test("an automatic state beyond the transition limit publishes a resumable stable failure", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-transition-overflow-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const value = config((current) => {
    current.gates.requireBrainstormApproval = false;
  });
  const store = new FileRunStore(cwd);
  const run = await createRunInState(store, value, "BRAINSTORMING");
  const orchestrator = new Orchestrator(cwd, value, new MockRuntime(), store, {
    automaticTransitionLimit: 1,
  });

  const result = await orchestrator.runUntilBlocked(run.id);
  const reloaded = await store.load(result.id);

  assert.equal(reloaded.state, "FAILED");
  assert.equal(reloaded.failure?.code, "automatic-transition-limit-exceeded");
  assert.equal(reloaded.failure?.resumeState, "DESIGNING");
  assert.equal(reloaded.events.at(-1)?.type, "FAIL");
  assert.equal(reloaded.events.at(-1)?.from, "DESIGNING");
  assert.match(renderRun(reloaded), /Failure code: automatic-transition-limit-exceeded/);
});

test("a post-rename failure publication is recovered only as a complete failed run", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-transition-outcome-unknown-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const value = config((current) => {
    current.gates.requireBrainstormApproval = false;
  });
  const initialStore = new FileRunStore(cwd);
  const initial = await createRunInState(initialStore, value, "BRAINSTORMING");
  const priorEventIds = new Set(initial.events.map((event) => event.id));
  let failAfterFailRename = true;
  const failingStore = new FileRunStore(cwd, {
    syncDirectory: async (directoryPath) => {
      if (!failAfterFailRename || path.basename(directoryPath) !== initial.id) return;
      const published = JSON.parse(
        await readFile(path.join(directoryPath, "run.json"), "utf8"),
      ) as RunRecord;
      if (published.state === "FAILED" && published.events.at(-1)?.type === "FAIL") {
        failAfterFailRename = false;
        throw new Error("simulated post-rename failure publication sync failure");
      }
    },
  });
  const orchestrator = new Orchestrator(cwd, value, new MockRuntime(), failingStore, {
    automaticTransitionLimit: 1,
  });

  const result = await orchestrator.runUntilBlocked(initial.id);
  const reloaded = await initialStore.load(result.id);
  const newEvents = reloaded.events.filter((event) => !priorEventIds.has(event.id));
  const newFailEvents = newEvents.filter((event) => event.type === "FAIL");

  assert.equal(reloaded.state, "FAILED");
  assert.equal(reloaded.failure?.code, "automatic-transition-limit-exceeded");
  assert.equal(reloaded.failure?.resumeState, "DESIGNING");
  assert.equal(newEvents.length, 3);
  assert.equal(newFailEvents.length, 1);
  assert.equal(newFailEvents[0]?.from, "DESIGNING");
  assert.equal(newFailEvents[0]?.to, "FAILED");
});
