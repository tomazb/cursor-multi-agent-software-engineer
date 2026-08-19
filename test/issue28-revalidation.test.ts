import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type {
  RevalidationReturnState,
  RunRecord,
  RunWorkspace,
  WorkflowState,
} from "../src/domain.ts";
import {
  assertRevalidationFence,
  captureRevalidationFence,
  RevalidationService,
} from "../src/revalidation.ts";
import { FileRunStore } from "../src/store.ts";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const HEAD_C = "c".repeat(40);
const REQUESTED_AT = "2026-08-18T12:00:00.000Z";
const RETARGETED_AT = "2026-08-18T12:01:00.000Z";

async function tempStore(t: test.TestContext): Promise<FileRunStore> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-revalidation-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return new FileRunStore(cwd);
}

async function runInState(
  store: FileRunStore,
  state: WorkflowState,
): Promise<RunRecord> {
  const run = await store.create("revalidation", "route the latest target", DEFAULT_CONFIG);
  run.state = state;
  await store.save(run);
  return run;
}

function workspace(headSha: string, fingerprint = headSha): RunWorkspace {
  return {
    remote: "https://github.com/owner/repo.git",
    baseSha: HEAD_A,
    headSha,
    branch: "maswe/revalidation",
    fingerprint,
    worktreePath: "/tmp/maswe-revalidation-worktree",
  };
}

async function initialRequest(
  store: FileRunStore,
  gate: RevalidationReturnState = "PR_REVIEW",
): Promise<RunRecord> {
  const run = await runInState(store, gate);
  return new RevalidationService(store).route(run.id, {
    source: "local-workspace",
    previousHeadSha: HEAD_A,
    requestedHeadSha: HEAD_B,
    expectedRunVersion: run.version,
    actor: "local-runner",
    observedWorkspace: workspace(HEAD_B),
    at: REQUESTED_AT,
  });
}

for (const gate of ["PR_READY", "PR_REVIEW"] as const) {
  test(`initial revalidation from ${gate} retains that return gate and publishes once`, async (t) => {
    const store = await tempStore(t);
    const run = await runInState(store, gate);
    run.evidence = {
      quality: { headSha: HEAD_A, passed: true, at: REQUESTED_AT },
      verification: { headSha: HEAD_A, passed: true, at: REQUESTED_AT },
      mergeReady: { headSha: HEAD_A, passed: true, at: REQUESTED_AT },
    };
    await store.save(run);

    const routed = await new RevalidationService(store).route(run.id, {
      source: "local-workspace",
      previousHeadSha: HEAD_A,
      requestedHeadSha: HEAD_B,
      expectedRunVersion: run.version,
      actor: "local-runner",
      observedWorkspace: workspace(HEAD_B),
      at: REQUESTED_AT,
    });

    assert.equal(routed.state, "CI_RUNNING");
    assert.deepEqual(routed.revalidation, {
      returnState: gate,
      source: "local-workspace",
      originHeadSha: HEAD_A,
      requestedHeadSha: HEAD_B,
      generation: 1,
      requestedAt: REQUESTED_AT,
      updatedAt: REQUESTED_AT,
    });
    assert.equal(routed.evidence, undefined);
    assert.equal("targets" in (routed.revalidation as object), false);
    assert.deepEqual(
      routed.events.filter((event) => event.type === "REVALIDATE_REQUESTED").map((event) => ({
        actor: event.actor,
        from: event.from,
        to: event.to,
        details: event.details,
      })),
      [{
        actor: "local-runner",
        from: gate,
        to: "CI_RUNNING",
        details: {
          previousHeadSha: HEAD_A,
          requestedHeadSha: HEAD_B,
          generation: 1,
          returnState: gate,
          source: "local-workspace",
        },
      }],
    );
  });
}

for (const state of ["BUILDING", "CI_RUNNING", "VERIFYING"] as const) {
  test(`active ${state} revalidation retargets only to the new generation`, async (t) => {
    const store = await tempStore(t);
    const run = await initialRequest(store);
    if (state === "BUILDING") await store.applyEvent(run, "CI_FAILED", "quality");
    if (state === "VERIFYING") await store.applyEvent(run, "CI_PASSED", "quality");
    run.evidence = {
      quality: { headSha: HEAD_B, passed: true, at: REQUESTED_AT },
      verification: { headSha: HEAD_B, passed: true, at: REQUESTED_AT },
      mergeReady: { headSha: HEAD_B, passed: true, at: REQUESTED_AT },
    };
    await store.save(run);

    const routed = await new RevalidationService(store).route(run.id, {
      source: "github",
      previousHeadSha: HEAD_B,
      requestedHeadSha: HEAD_C,
      expectedRunVersion: run.version,
      actor: "github-app",
      observedWorkspace: workspace(HEAD_C),
      at: RETARGETED_AT,
    });

    assert.equal(routed.state, "CI_RUNNING");
    assert.deepEqual(routed.revalidation, {
      returnState: "PR_REVIEW",
      source: "github",
      originHeadSha: HEAD_A,
      requestedHeadSha: HEAD_C,
      generation: 2,
      requestedAt: REQUESTED_AT,
      updatedAt: RETARGETED_AT,
    });
    assert.equal(routed.evidence, undefined);
    assert.equal("targets" in (routed.revalidation as object), false);
    const retargets = routed.events.filter((event) => event.type === "REVALIDATION_RETARGETED");
    assert.equal(retargets.length, 1);
    assert.equal(retargets[0]?.from, state);
    assert.equal(retargets[0]?.to, "CI_RUNNING");
    assert.deepEqual(retargets[0]?.details, {
      previousRequestedHeadSha: HEAD_B,
      requestedHeadSha: HEAD_C,
      generation: 2,
      returnState: "PR_REVIEW",
      source: "github",
    });
    assert.deepEqual(
      routed.events.filter((event) => event.type === "REVALIDATE_REQUESTED").length,
      1,
    );
  });
}

test("a newer generation preserves history but makes superseded success evidence unusable", async (t) => {
  const store = await tempStore(t);
  const atB = await initialRequest(store);
  atB.evidence = {
    quality: { headSha: HEAD_B, passed: true, at: REQUESTED_AT },
    verification: { headSha: HEAD_B, passed: true, at: REQUESTED_AT },
    mergeReady: { headSha: HEAD_B, passed: true, at: REQUESTED_AT },
  };
  atB.events.push(
    {
      id: randomUUID(),
      at: REQUESTED_AT,
      type: "CI_PASSED",
      actor: "quality-runner",
      from: "CI_RUNNING",
      to: "VERIFYING",
      details: { headSha: HEAD_B, passed: true, required: true },
    },
    {
      id: randomUUID(),
      at: REQUESTED_AT,
      type: "VERIFY_PASSED_AFTER_REVIEW",
      actor: "verifier",
      from: "VERIFYING",
      to: "PR_REVIEW",
      details: { headSha: HEAD_B },
    },
  );
  await store.save(atB);
  const historicalEvents = structuredClone(atB.events);

  const atC = await new RevalidationService(store).route(atB.id, {
    source: "github",
    previousHeadSha: HEAD_B,
    requestedHeadSha: HEAD_C,
    expectedRunVersion: atB.version,
    actor: "github-app",
    observedWorkspace: workspace(HEAD_C),
    at: RETARGETED_AT,
  });

  assert.deepEqual(atC.events.slice(0, historicalEvents.length), historicalEvents);
  assert.equal(atC.revalidation?.generation, 2);
  assert.equal(atC.revalidation?.requestedHeadSha, HEAD_C);
  assert.equal(atC.evidence, undefined);
  assert.equal((await store.load(atC.id)).evidence, undefined);
});

for (const resumeState of ["BUILDING", "CI_RUNNING", "VERIFYING"] as const) {
  test(`failed ${resumeState} revalidation retarget preserves failure history`, async (t) => {
    const store = await tempStore(t);
    const run = await initialRequest(store);
    if (resumeState === "BUILDING") await store.applyEvent(run, "CI_FAILED", "quality");
    if (resumeState === "VERIFYING") await store.applyEvent(run, "CI_PASSED", "quality");
    run.failure = {
      code: "workflow-failure",
      message: "retry current generation",
      at: REQUESTED_AT,
      resumeState,
    };
    await store.applyEvent(run, "FAIL", "orchestrator", {
      reason: "retry current generation",
      resumeState,
    });
    const historicalFailure = structuredClone(run.failure);
    const historicalFailEvent = structuredClone(run.events.at(-1));

    const routed = await new RevalidationService(store).route(run.id, {
      source: "github",
      previousHeadSha: HEAD_B,
      requestedHeadSha: HEAD_C,
      expectedRunVersion: run.version,
      actor: "github-app",
      at: RETARGETED_AT,
    });

    assert.equal(routed.state, "FAILED");
    assert.deepEqual(routed.revalidation, {
      returnState: "PR_REVIEW",
      source: "github",
      originHeadSha: HEAD_A,
      requestedHeadSha: HEAD_C,
      generation: 2,
      requestedAt: REQUESTED_AT,
      updatedAt: RETARGETED_AT,
    });
    assert.deepEqual(routed.failure, {
      ...historicalFailure,
      resumeState: "CI_RUNNING",
    });
    assert.deepEqual(routed.events.at(-2), historicalFailEvent);
    assert.deepEqual(routed.events.at(-1)?.details, {
      previousRequestedHeadSha: HEAD_B,
      requestedHeadSha: HEAD_C,
      generation: 2,
      returnState: "PR_REVIEW",
      source: "github",
      previousResumeState: resumeState,
    });
  });
}

test("same-target routing is event-free and saves only an exact workspace alignment", async (t) => {
  const store = await tempStore(t);
  const run = await initialRequest(store);
  const before = structuredClone(run);
  const aligned = workspace(HEAD_B, "aligned-fingerprint");

  const saved = await new RevalidationService(store).route(run.id, {
    source: "github",
    previousHeadSha: HEAD_B,
    requestedHeadSha: HEAD_B,
    expectedRunVersion: run.version,
    actor: "github-app",
    observedWorkspace: aligned,
    at: RETARGETED_AT,
  });

  assert.equal(saved.version, before.version + 1);
  assert.deepEqual(saved.workspace, aligned);
  assert.deepEqual(saved.events, before.events);
  assert.deepEqual(saved.revalidation, before.revalidation);
  assert.deepEqual(saved.evidence, before.evidence);

  const unchanged = await new RevalidationService(store).route(saved.id, {
    source: "github",
    previousHeadSha: HEAD_B,
    requestedHeadSha: HEAD_B,
    expectedRunVersion: saved.version,
    actor: "github-app",
    observedWorkspace: aligned,
    at: "2026-08-18T13:00:00.000Z",
  });
  assert.equal(unchanged.version, saved.version);
  assert.deepEqual(unchanged.events, before.events);
  assert.deepEqual(unchanged.revalidation, before.revalidation);
});

test("same-target routing rejects an observed workspace at a different HEAD", async (t) => {
  const store = await tempStore(t);
  const atB = await initialRequest(store);
  const atC = await new RevalidationService(store).route(atB.id, {
    source: "github",
    previousHeadSha: HEAD_B,
    requestedHeadSha: HEAD_C,
    expectedRunVersion: atB.version,
    actor: "github-app",
    at: RETARGETED_AT,
  });
  const before = structuredClone(atC);

  await assert.rejects(
    new RevalidationService(store).route(atC.id, {
      source: "github",
      previousHeadSha: HEAD_C,
      requestedHeadSha: HEAD_C,
      expectedRunVersion: atC.version,
      actor: "local-runner",
      observedWorkspace: workspace(HEAD_B),
    }),
    /workspace.*HEAD|target.*workspace|alignment/i,
  );

  assert.deepEqual(await store.load(atC.id), before);
});

test("active routing rejects a stale expected version after an association-only update", async (t) => {
  const store = await tempStore(t);
  const atB = await initialRequest(store);
  const concurrent = await store.load(atB.id);
  concurrent.github = {
    installationId: 1,
    repository: "owner/repo",
    pullRequestNumber: 28,
    baseSha: HEAD_A,
    headSha: HEAD_C,
    branch: "maswe/revalidation",
  };
  await store.save(concurrent);
  const before = await store.load(atB.id);

  await assert.rejects(
    new RevalidationService(store).route(atB.id, {
      source: "github",
      previousHeadSha: HEAD_B,
      requestedHeadSha: HEAD_B,
      expectedRunVersion: atB.version,
      actor: "github-app",
      observedWorkspace: workspace(HEAD_B),
    }),
    /stale.*version|optimistic.*version/i,
  );

  assert.deepEqual(await store.load(atB.id), before);
});

test("active routing never reverses a newer target when the predecessor is stale", async (t) => {
  const store = await tempStore(t);
  const atB = await initialRequest(store);
  const atC = await new RevalidationService(store).route(atB.id, {
    source: "github",
    previousHeadSha: HEAD_B,
    requestedHeadSha: HEAD_C,
    expectedRunVersion: atB.version,
    actor: "github-app",
    at: RETARGETED_AT,
  });
  const before = structuredClone(atC);

  await assert.rejects(
    new RevalidationService(store).route(atC.id, {
      source: "github",
      previousHeadSha: HEAD_B,
      requestedHeadSha: HEAD_B,
      expectedRunVersion: atC.version,
      actor: "github-app",
    }),
    /stale.*predecessor|target.*changed|optimistic/i,
  );

  assert.deepEqual(await store.load(atC.id), before);
});

test("illegal revalidation requests and persisted contexts fail closed without publication", async (t) => {
  const store = await tempStore(t);
  const noContext = await runInState(store, "BUILDING");
  const noContextVersion = noContext.version;
  await assert.rejects(
    new RevalidationService(store).route(noContext.id, {
      source: "github",
      previousHeadSha: HEAD_A,
      requestedHeadSha: HEAD_B,
      expectedRunVersion: noContext.version,
      actor: "github-app",
    }),
    /illegal.*revalidation|active revalidation/i,
  );
  assert.equal((await store.load(noContext.id)).version, noContextVersion);

  const activeAtIllegalGate = await initialRequest(store);
  const activeVersion = activeAtIllegalGate.version;
  activeAtIllegalGate.state = "PR_REVIEW";
  await assert.rejects(
    store.save(activeAtIllegalGate),
    /revalidation state.*invalid/i,
  );
  assert.equal((await store.load(activeAtIllegalGate.id)).version, activeVersion);

  const failed = await runInState(store, "FAILED");
  assert.ok(activeAtIllegalGate.revalidation);
  failed.revalidation = structuredClone(activeAtIllegalGate.revalidation);
  failed.failure = {
    message: "not a revalidation-resumable failure",
    at: REQUESTED_AT,
    resumeState: "PR_READY",
  };
  await assert.rejects(
    store.save(failed),
    /revalidation.*invalid.*resume/i,
  );
});

test("generation fences reject stale versions and accept the exact current target", async (t) => {
  const store = await tempStore(t);
  const atB = await initialRequest(store);
  const fenceB = captureRevalidationFence(atB);
  await assertRevalidationFence(store, atB.id, fenceB);

  const atC = await new RevalidationService(store).route(atB.id, {
    source: "github",
    previousHeadSha: HEAD_B,
    requestedHeadSha: HEAD_C,
    expectedRunVersion: atB.version,
    actor: "github-app",
    at: RETARGETED_AT,
  });

  await assert.rejects(assertRevalidationFence(store, atC.id, fenceB), /stale.*fence|generation|target/i);
  const fenceC = captureRevalidationFence(atC);
  assert.deepEqual(fenceC, {
    runVersion: atC.version,
    generation: 2,
    requestedHeadSha: HEAD_C,
  });
  assert.equal((await assertRevalidationFence(store, atC.id, fenceC)).version, atC.version);
  await assert.rejects(
    assertRevalidationFence(store, atC.id, { ...fenceC, runVersion: fenceC.runVersion - 1 }),
    /stale.*fence/i,
  );
  await assert.rejects(
    assertRevalidationFence(store, atC.id, { ...fenceC, generation: fenceC.generation - 1 }),
    /stale.*fence/i,
  );
  await assert.rejects(
    assertRevalidationFence(store, atC.id, { ...fenceC, requestedHeadSha: HEAD_B }),
    /stale.*fence/i,
  );
});

test("fence capture and assertion require active revalidation", async (t) => {
  const store = await tempStore(t);
  const run = await runInState(store, "CI_RUNNING");
  assert.throws(() => captureRevalidationFence(run), /active revalidation/i);
  await assert.rejects(
    assertRevalidationFence(store, run.id, {
      runVersion: run.version,
      generation: 1,
      requestedHeadSha: HEAD_B,
    }),
    /active revalidation|stale.*fence/i,
  );
});
