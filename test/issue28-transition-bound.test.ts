import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type {
  MasweConfig,
  RunRecord,
  WorkflowEventType,
} from "../src/domain.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { renderRun } from "../src/run-rendering.ts";
import { MockRuntime } from "../src/runtimes/mock.ts";
import { FileRunStore, type RunStore } from "../src/store.ts";

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

type FailureInjection =
  | "unchanged-prior"
  | "unchanged-prior-reordered"
  | "partial-failure-metadata"
  | "failure-metadata"
  | "fail-event-details"
  | "historical-prefix";

class FailureInjectionStore implements RunStore {
  private readonly delegate: FileRunStore;
  private readonly injection: FailureInjection;
  private reorderNextLoad = false;

  constructor(
    delegate: FileRunStore,
    injection: FailureInjection,
  ) {
    this.delegate = delegate;
    this.injection = injection;
  }

  create(title: string, request: string, value: MasweConfig): Promise<RunRecord> {
    return this.delegate.create(title, request, value);
  }

  save(run: RunRecord): Promise<void> {
    return this.delegate.save(run);
  }

  async load(runId: string): Promise<RunRecord> {
    const run = await this.delegate.load(runId);
    if (!this.reorderNextLoad) return run;
    this.reorderNextLoad = false;
    return Object.fromEntries(Object.entries(run).reverse()) as unknown as RunRecord;
  }

  list(): Promise<RunRecord[]> {
    return this.delegate.list();
  }

  async applyEvent(
    run: RunRecord,
    type: WorkflowEventType,
    actor: string,
    details?: Record<string, unknown>,
  ): Promise<RunRecord> {
    if (type !== "FAIL") return this.delegate.applyEvent(run, type, actor, details);
    if (this.injection === "unchanged-prior" || this.injection === "unchanged-prior-reordered") {
      this.reorderNextLoad = this.injection === "unchanged-prior-reordered";
      throw new Error("simulated pre-publication failure");
    }

    await this.delegate.applyEvent(run, type, actor, details);
    const observed = await this.delegate.load(run.id);
    if (this.injection === "partial-failure-metadata") {
      delete observed.failure;
    } else if (this.injection === "failure-metadata") {
      observed.failure!.message = "tampered failure metadata";
    } else if (this.injection === "fail-event-details") {
      const event = observed.events.at(-1)!;
      event.actor = "tampered-orchestrator";
      event.details = { ...event.details, tampered: true };
    } else {
      observed.events[0]!.actor = "tampered-history";
    }
    await this.delegate.save(observed);
    throw new Error(`simulated altered ${this.injection} publication`);
  }

  writeArtifact(run: RunRecord, name: string, content: string) {
    return this.delegate.writeArtifact(run, name, content);
  }

  readArtifact(run: RunRecord, name: string) {
    return this.delegate.readArtifact(run, name);
  }
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

test("failure recovery rethrows only an unchanged prior automatic record", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-transition-prior-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const value = config((current) => {
    current.gates.requireBrainstormApproval = false;
  });
  const store = new FileRunStore(cwd);
  const initial = await createRunInState(store, value, "BRAINSTORMING");
  const orchestrator = new Orchestrator(
    cwd,
    value,
    new MockRuntime(),
    new FailureInjectionStore(store, "unchanged-prior"),
    { automaticTransitionLimit: 1 },
  );

  await assert.rejects(
    orchestrator.runUntilBlocked(initial.id),
    /simulated pre-publication failure/,
  );
  const reloaded = await store.load(initial.id);

  assert.equal(reloaded.state, "DESIGNING");
  assert.equal(reloaded.failure, undefined);
  assert.equal(reloaded.events.at(-1)?.type, "APPROVE_BRAINSTORM");
});

test("failure recovery classifies structurally equal reordered prior records as unchanged", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-transition-prior-reordered-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const value = config((current) => {
    current.gates.requireBrainstormApproval = false;
  });
  const store = new FileRunStore(cwd);
  const initial = await createRunInState(store, value, "BRAINSTORMING");
  const orchestrator = new Orchestrator(
    cwd,
    value,
    new MockRuntime(),
    new FailureInjectionStore(store, "unchanged-prior-reordered"),
    { automaticTransitionLimit: 1 },
  );

  await assert.rejects(
    orchestrator.runUntilBlocked(initial.id),
    /simulated pre-publication failure/,
  );
  assert.equal((await store.load(initial.id)).state, "DESIGNING");
});

test("failure recovery rejects every altered failed publication shape", async (t) => {
  for (const injection of [
    "partial-failure-metadata",
    "failure-metadata",
    "fail-event-details",
    "historical-prefix",
  ] as const) {
    await t.test(injection, async (t) => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), `maswe-transition-${injection}-`));
      t.after(async () => rm(cwd, { recursive: true, force: true }));
      const value = config((current) => {
        current.gates.requireBrainstormApproval = false;
      });
      const store = new FileRunStore(cwd);
      const initial = await createRunInState(store, value, "BRAINSTORMING");
      const orchestrator = new Orchestrator(
        cwd,
        value,
        new MockRuntime(),
        new FailureInjectionStore(store, injection),
        { automaticTransitionLimit: 1 },
      );

      await assert.rejects(
        orchestrator.runUntilBlocked(initial.id),
        /Failure publication outcome is ambiguous/,
      );
      const reloaded = await store.load(initial.id);

      assert.equal(reloaded.state, "FAILED");
      assert.equal(reloaded.events.filter((event) => event.type === "FAIL").length, 1);
      if (injection === "partial-failure-metadata") {
        assert.equal(reloaded.failure, undefined);
      } else {
        assert.equal(reloaded.failure?.code, "automatic-transition-limit-exceeded");
      }
    });
  }
});

test("automatic transition limit accepts only positive safe integers", () => {
  for (const limit of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(
      () => new Orchestrator("/tmp/maswe-transition-options", config(), new MockRuntime(), undefined, {
        automaticTransitionLimit: limit,
      }),
      /positive safe integer/,
    );
  }
});
