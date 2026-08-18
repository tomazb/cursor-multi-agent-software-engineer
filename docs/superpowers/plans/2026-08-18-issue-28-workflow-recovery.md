# Issue #28 Workflow Provenance, Recovery, and Revalidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair Issue #28 so MASWE publishes exact evaluated SHA provenance, recovers every partial `CREATED` bootstrap, durably handles automatic-transition overflow and retry publication, and revalidates stale evidence against the latest local or GitHub head without rolling back workflow history.

**Architecture:** Keep schema version `1`, the current optimistic file store, and `src/state-machine.ts` as the sole transition map. Add two focused helpers: `src/workspace-bootstrap.ts` owns bootstrap intent capture and exact workspace reconciliation, while `src/revalidation.ts` owns request/retarget metadata and event publication through `RunStore.applyEvent()`. GitHub head handling becomes a two-phase protocol: rollback-capable event-free association publication followed by non-rollback workflow routing.

**Tech Stack:** TypeScript ESM, Node.js built-in test runner, Node `--experimental-strip-types`, Git CLI worktrees, JSON Schema Draft 2020-12, file-backed optimistic persistence.

**Spec:** `docs/superpowers/specs/2026-08-18-issue-28-workflow-recovery-design.md` at approved commit `d85451f984a80ec6681dfcd7226a31099b1479fe`.

## Global Constraints

- Begin implementation from branch `issue-28-workflow-recovery` at the commit containing this plan; the approved design baseline remains `main@e80043cb208b5c26671a7aae34283d75ffab9dec`.
- Keep `schemaVersion: 1`; all new run-record fields are optional and exact-schema validated.
- Keep state mappings in `src/state-machine.ts`; helpers and adapters may request events but may not assign workflow state directly.
- Preserve historical event IDs, order, details, SHAs, and count. Reconciliation must never replace a record with fewer or altered events.
- Do not automatically fetch, reset, rebase, merge, force-update, prune worktrees, delete paths, create PRs, or merge.
- Do not weaken read-only fingerprinting: bootstrap source drift excludes `.maswe`, while normal read-only enforcement continues to include authoritative `.maswe` state.
- Every recovery assertion must reload the authoritative run record from disk after injected failure.
- Every production run-creation path, including `supersede()`, must persist bootstrap intent before branch or worktree side effects.
- A correctly registered but dirty managed worktree is not reusable.
- Keep terminal cleanup recovery outside this issue; Issue #30 owns that behavior.
- Keep policy/input hardening outside this issue; Issue #29 owns that behavior.
- Use exact Node `24.18.0` as canonical validation and exact Node `22.22.2` as the blocking compatibility floor.
- Avoid TypeScript syntax unsupported by strip-only execution: no enums, parameter properties, or transform-dependent constructs.
- Do not modify dependencies, package metadata, lock files, workflows, runtime adapters, CLI grammar, or configuration schema.

---

## File Responsibility Map

### New production files

- `src/workspace-bootstrap.ts` — bootstrap intent capture, exact source/worktree classification, clean-status checks, and retry-safe workspace reconciliation. It does not publish workflow events.
- `src/revalidation.ts` — initial revalidation, active/failed retargeting, target reconciliation, and generation fences. Every transition is published through `RunStore.applyEvent()`.

### Modified production files

- `src/domain.ts` — new metadata types, event values, and failure code.
- `src/state-machine.ts` — centralized request/retarget transitions and constrained failed self-transition.
- `src/git-snapshot.ts` — source-tree fingerprint that excludes `.maswe` without changing the current authoritative fingerprint.
- `src/git-workspace.ts` — structured worktree inspection, strict isolated-workspace guard, and dirty-worktree rejection.
- `src/store.ts` — initial run fields, exact migration allowlists, and transition-context forwarding.
- `src/run-record-validation.ts` — exact validation for bootstrap and revalidation metadata.
- `src/orchestrator.ts` — planned run creation, real `CREATED + workspace` checkpoint, durable overflow/failure/retry, revalidation preflight, generation fences, and return-to-gate behavior.
- `src/run-rendering.ts` — stable failure code and bootstrap/revalidation diagnostics.
- `src/github/adapter.ts` — two-phase association/routing protocol and crash-recovery seams.
- `src/github/association.ts` — explicit known-failure rollback contract and outcome-unknown behavior.
- `schemas/run-record.schema.json` — exact optional metadata and enum synchronization.

### New focused tests

- `test/issue28-transition-bound.test.ts`
- `test/issue28-bootstrap.test.ts`
- `test/issue28-retry-publication.test.ts`
- `test/issue28-revalidation.test.ts`
- `test/issue28-github-reconciliation.test.ts`
- `test/issue28-rendering.test.ts`

### Existing tests to extend

- `test/state-machine.test.ts`
- `test/schema.test.ts`
- `test/commit-provenance.test.ts`
- `test/orchestrator.test.ts`
- `test/failed-run-provenance.test.ts`
- `test/evidence-freshness.test.ts`
- `test/github-adapter.integration.test.ts`
- `test/github-authoritative-state.test.ts`

### Documentation to synchronize

- `docs/PRD.md`
- `docs/ARCHITECTURE.md`
- `docs/ARTIFACT_CONTRACTS.md`
- `docs/GITHUB_APP.md`
- `docs/OPERATIONS.md`

---

### Task 1: Add exact recovery and revalidation contracts

**Files:**
- Modify: `src/domain.ts`
- Modify: `src/state-machine.ts`
- Modify: `src/store.ts`
- Modify: `src/run-record-validation.ts`
- Modify: `schemas/run-record.schema.json`
- Modify: `test/state-machine.test.ts`
- Modify: `test/schema.test.ts`

**Interfaces:**
- Produces: `WorkspaceBootstrapIntent`, `RunRevalidation`, `RevalidationSource`, `RevalidationReturnState`, `TransitionContext`.
- Produces: workflow events `REVALIDATE_REQUESTED` and `REVALIDATION_RETARGETED`.
- Produces: failure code `automatic-transition-limit-exceeded`.
- Consumes: existing `RunRecord`, `WorkflowState`, `WorkflowEventType`, `RunFailureCode`, `RunStore.applyEvent()`.

- [ ] **Step 1: Write failing state-machine tests for request, retarget, and `CREATED` retry**

Add to `test/state-machine.test.ts`:

```ts
test("revalidation request and retarget transitions are centralized", () => {
  assert.equal(
    transition("PR_READY", "REVALIDATE_REQUESTED", {}),
    "CI_RUNNING",
  );
  assert.equal(
    transition("PR_REVIEW", "REVALIDATE_REQUESTED", {}),
    "CI_RUNNING",
  );
  for (const state of ["CI_RUNNING", "BUILDING", "VERIFYING"] as const) {
    assert.equal(
      transition(state, "REVALIDATION_RETARGETED", {}),
      "CI_RUNNING",
    );
  }
});

test("failed revalidation retarget requires active context and a legal resume state", () => {
  assert.equal(
    transition("FAILED", "REVALIDATION_RETARGETED", {
      hasRevalidation: true,
      failureResumeState: "VERIFYING",
    }),
    "FAILED",
  );
  assert.throws(
    () => transition("FAILED", "REVALIDATION_RETARGETED", {}),
    /active revalidation|resume state/i,
  );
  assert.throws(
    () => transition("FAILED", "REVALIDATION_RETARGETED", {
      hasRevalidation: true,
      failureResumeState: "PR_READY",
    }),
    /active revalidation|resume state/i,
  );
});

test("retry-from-failed accepts CREATED as a resumable bootstrap state", () => {
  assert.equal(
    transition("FAILED", "RETRY_FROM_FAILED", { retryResumeState: "CREATED" }),
    "CREATED",
  );
});
```

Update existing direct `transition()` calls to pass `{ retryResumeState }` rather than the old string third argument.

- [ ] **Step 2: Run the state-machine tests and verify the red state**

Run:

```bash
node --experimental-strip-types --test test/state-machine.test.ts
```

Expected: FAIL because the new event values, context signature, and transitions do not exist.

- [ ] **Step 3: Write failing schema/migration tests for both metadata objects and the stable failure code**

Add to `test/schema.test.ts`:

```ts
test("run schema and migration accept exact Issue 28 metadata", async (t) => {
  const schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/run-record.schema.json"), "utf8"),
  ) as JsonSchema;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue28-schema-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const run = await new FileRunStore(cwd).create("issue28", "schema", DEFAULT_CONFIG);
  run.workspaceBootstrap = {
    mode: "isolated-worktree",
    sourceBaseSha: "a".repeat(40),
    sourceBranch: "main",
    sourceTreeFingerprint: "b".repeat(64),
    remote: "https://github.com/owner/repo.git",
    plannedAt: "2026-08-18T12:00:00.000Z",
  };
  run.revalidation = {
    returnState: "PR_REVIEW",
    source: "github",
    originHeadSha: "c".repeat(40),
    requestedHeadSha: "d".repeat(40),
    generation: 2,
    requestedAt: "2026-08-18T12:01:00.000Z",
    updatedAt: "2026-08-18T12:02:00.000Z",
  };
  run.failure = {
    code: "automatic-transition-limit-exceeded",
    message: "automatic transition limit exceeded",
    at: "2026-08-18T12:03:00.000Z",
    resumeState: "CI_RUNNING",
  };

  assert.doesNotThrow(() => assertMatches(schema, schema, run, "run"));
  assert.doesNotThrow(() => migrateRunRecord(run));
});

test("Issue 28 metadata rejects extra fields and invalid generation", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue28-schema-invalid-"));
  const run = await new FileRunStore(cwd).create("issue28", "schema", DEFAULT_CONFIG);
  run.revalidation = {
    returnState: "PR_READY",
    source: "local-workspace",
    originHeadSha: "a",
    requestedHeadSha: "b",
    generation: 0,
    requestedAt: "2026-08-18T12:00:00.000Z",
    updatedAt: "2026-08-18T12:00:00.000Z",
  };
  assert.throws(() => migrateRunRecord(run), /generation/i);
  run.revalidation.generation = 1;
  (run.revalidation as unknown as Record<string, unknown>).hiddenTarget = "c";
  assert.throws(() => migrateRunRecord(run), /unsupported.*revalidation/i);
});
```

- [ ] **Step 4: Run schema tests and verify the red state**

Run:

```bash
node --experimental-strip-types --test test/schema.test.ts
```

Expected: FAIL because the new fields and enum values are unsupported.

- [ ] **Step 5: Add the domain types and event/failure values**

Add to `src/domain.ts`:

```ts
export type RevalidationReturnState = "PR_READY" | "PR_REVIEW";
export type RevalidationSource = "local-workspace" | "github";

export interface WorkspaceBootstrapIntent {
  mode: "operator-checkout" | "isolated-worktree";
  sourceBaseSha: string;
  sourceBranch: string;
  sourceTreeFingerprint: string;
  remote?: string;
  plannedAt: string;
}

export interface RunRevalidation {
  returnState: RevalidationReturnState;
  source: RevalidationSource;
  originHeadSha: string;
  requestedHeadSha: string;
  generation: number;
  requestedAt: string;
  updatedAt: string;
}
```

Extend `RunRecord` with:

```ts
workspaceBootstrap?: WorkspaceBootstrapIntent;
revalidation?: RunRevalidation;
```

Extend `WORKFLOW_EVENTS` with both revalidation event values and extend `RunFailureCode` with `automatic-transition-limit-exceeded`.

- [ ] **Step 6: Implement context-aware centralized transitions**

Use this public context in `src/state-machine.ts`:

```ts
export interface TransitionContext {
  retryResumeState?: WorkflowState;
  failureResumeState?: WorkflowState;
  hasRevalidation?: boolean;
}
```

Implement the special cases before the normal transition lookup:

```ts
if (event === "RETRY_FROM_FAILED") {
  if (state !== "FAILED") {
    throw new Error(`Event RETRY_FROM_FAILED is not allowed from state ${state}`);
  }
  const resumeState = context.retryResumeState;
  if (!resumeState || !RESUMABLE_STATES.includes(resumeState)) {
    throw new Error("RETRY_FROM_FAILED requires a resumable resumeState");
  }
  return resumeState;
}

if (state === "FAILED" && event === "REVALIDATION_RETARGETED") {
  const allowedResumeStates: WorkflowState[] = ["BUILDING", "CI_RUNNING", "VERIFYING"];
  if (
    context.hasRevalidation !== true ||
    !context.failureResumeState ||
    !allowedResumeStates.includes(context.failureResumeState)
  ) {
    throw new Error(
      "REVALIDATION_RETARGETED from FAILED requires active revalidation and a resumable active state",
    );
  }
  return "FAILED";
}
```

Add the normal request/retarget mappings to `TRANSITIONS`, add `CREATED` to `RESUMABLE_STATES`, and make `allowedEvents()` accept an optional `TransitionContext` so it exposes failed retarget only when the same preconditions hold.

- [ ] **Step 7: Forward transition context from `RunStore.applyEvent()` and validate exact metadata**

In `src/store.ts`, call:

```ts
const to = transition(from, type, {
  retryResumeState: safeDetails?.resumeState as WorkflowState | undefined,
  failureResumeState: run.failure?.resumeState,
  hasRevalidation: run.revalidation !== undefined,
});
```

Add both fields to the top-level allowlist. In `src/run-record-validation.ts`, add exact-object validators that reject unknown fields, non-positive generation, invalid return states/sources, and empty identity strings. Mirror the same requirements in `schemas/run-record.schema.json` with `additionalProperties: false`.

- [ ] **Step 8: Run focused tests and type checking**

Run:

```bash
node --experimental-strip-types --test test/state-machine.test.ts test/schema.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit the contract layer**

```bash
git add src/domain.ts src/state-machine.ts src/store.ts src/run-record-validation.ts schemas/run-record.schema.json test/state-machine.test.ts test/schema.test.ts
git commit -m "feat: add Issue 28 recovery contracts"
```

---

### Task 2: Correct editing-stage evaluated SHA provenance

**Files:**
- Modify: `src/orchestrator.ts`
- Modify: `test/commit-provenance.test.ts`

**Interfaces:**
- Produces: corrected `BUILD_COMPLETED.details` and `RESOLUTION_COMPLETED.details` contracts.
- Consumes: existing `createDeterministicCommit()`, `run.workspace.headSha`, `runtimeEventIdentityDetails()`.

- [ ] **Step 1: Extend the editing runtime fixture to support resolver edits**

Add a mode that writes `src/review-fix.ts` when `request.role === "prResolver"` and returns:

```ts
return {
  status: "finished",
  output: "# resolution\n\nRESOLUTION_COMPLETE\n",
  requestedModel: request.roleConfig.model,
  actualModel: request.roleConfig.model,
};
```

Use `MockRuntime` for comment classification and other roles.

- [ ] **Step 2: Add failing builder and resolver assertions**

For the existing editing builder test, add:

```ts
assert.equal(build.details?.headSha, build.details?.outputHeadSha);
assert.equal(build.details?.headSha, run.workspace?.headSha);
```

Add an editing resolver test that starts a run, opens review, submits an in-scope comment, and asserts:

```ts
const resolution = run.events.find((event) => event.type === "RESOLUTION_COMPLETED");
assert.ok(resolution);
assert.notEqual(
  resolution.details?.inputHeadSha,
  resolution.details?.outputHeadSha,
);
assert.equal(resolution.details?.headSha, resolution.details?.outputHeadSha);
assert.equal(resolution.details?.headSha, run.workspace?.headSha);
```

Add no-op builder and resolver tests asserting all three SHA fields equal the final workspace head.

- [ ] **Step 3: Run the provenance tests and verify the red state**

```bash
node --experimental-strip-types --test test/commit-provenance.test.ts
```

Expected: FAIL because public `headSha` still records `beforeSha`.

- [ ] **Step 4: Publish the evaluated SHA in both event paths**

Replace the event details in both methods with:

```ts
const evaluatedHeadSha = outputHeadSha ?? beforeSha;

return this.store.applyEvent(run, eventType, actor, {
  ...runtimeEventIdentityDetails(result),
  marker: markers.marker,
  ...(beforeSha ? { inputHeadSha: beforeSha } : {}),
  ...(evaluatedHeadSha
    ? {
        headSha: evaluatedHeadSha,
        outputHeadSha: evaluatedHeadSha,
      }
    : {}),
});
```

Use the concrete event type and actor already present in each method; do not introduce a shared abstraction merely for these two call sites.

- [ ] **Step 5: Run focused provenance and evidence tests**

```bash
node --experimental-strip-types --test test/commit-provenance.test.ts test/evidence-freshness.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the provenance repair**

```bash
git add src/orchestrator.ts test/commit-provenance.test.ts
git commit -m "fix: bind editing events to evaluated head"
```

---

### Task 3: Make automatic-transition overflow durable and boundary-correct

**Files:**
- Modify: `src/orchestrator.ts`
- Create: `test/issue28-transition-bound.test.ts`
- Modify: `src/run-rendering.ts`

**Interfaces:**
- Produces: `OrchestratorOptions.automaticTransitionLimit` as a test-only dependency seam.
- Produces: atomic `failRun()` publication using a cloned candidate.
- Consumes: `isHumanGate()`, `isTerminal()`, `RunFailureCode`.

- [ ] **Step 1: Add deterministic boundary fixtures**

Create `test/issue28-transition-bound.test.ts` with a non-isolated mock configuration and a helper that seeds a run in `BRAINSTORMING` by creating a run, assigning a captured workspace, saving, and publishing `START`.

Add three tests:

```ts
test("final allowed advance may reach a human gate", async () => {
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
    automaticTransitionLimit: 1,
  });
  const run = await seedBrainstormingRun(cwd, store, config);
  const result = await orchestrator.runUntilBlocked(run.id);
  assert.equal(result.state, "WAITING_FOR_BRAINSTORM_APPROVAL");
});

test("final allowed advance may reach a terminal state", async () => {
  const run = await seedBuildingRunAtCycleLimit(cwd, store, config);
  const result = await orchestrator.runUntilBlocked(run.id);
  assert.equal(result.state, "FAILED");
  assert.notEqual(result.failure?.code, "automatic-transition-limit-exceeded");
});

test("one more required automatic advance durably fails", async () => {
  const result = await orchestrator.runUntilBlocked(run.id);
  const reloaded = await store.load(run.id);
  assert.equal(result.state, "FAILED");
  assert.equal(reloaded.state, "FAILED");
  assert.equal(reloaded.failure?.code, "automatic-transition-limit-exceeded");
  assert.equal(reloaded.failure?.resumeState, "DESIGNING");
  assert.equal(
    reloaded.events.at(-1)?.type,
    "FAIL",
  );
});
```

The overflow case uses disabled brainstorm approval so one `advance()` leaves the run in automatic `DESIGNING` at the configured bound.

- [ ] **Step 2: Run the new tests and verify the red state**

```bash
node --experimental-strip-types --test test/issue28-transition-bound.test.ts
```

Expected: FAIL because the constructor seam and durable overflow behavior do not exist.

- [ ] **Step 3: Add the internal option and correct loop ordering**

Add:

```ts
export interface OrchestratorOptions {
  automaticTransitionLimit?: number;
}

const DEFAULT_AUTOMATIC_TRANSITION_LIMIT = 20;
```

Store an effective positive integer in the constructor; reject zero, negative, fractional, or unsafe values.

Implement:

```ts
while (!isTerminal(run.state) && !isHumanGate(run.state)) {
  run = await this.advance(run.id);
  iterations += 1;
  if (isTerminal(run.state) || isHumanGate(run.state)) return run;
  if (iterations >= this.automaticTransitionLimit) {
    return this.failRun(
      run,
      `Workflow exceeded ${this.automaticTransitionLimit} automatic transitions.`,
      "automatic-transition-limit-exceeded",
    );
  }
}
return run;
```

- [ ] **Step 4: Make `failRun()` a single cloned publication**

Replace the pre-event `store.save()` sequence with:

```ts
const candidate = structuredClone(run);
const resumeState = isTerminal(candidate.state) ? undefined : candidate.state;
const safeMessage = safeFailureMessage(message);
candidate.failure = {
  code,
  message: safeMessage,
  at: new Date().toISOString(),
  ...(resumeState ? { resumeState } : {}),
  ...(runtime ? { runtime } : {}),
};

if (!isTerminal(candidate.state)) {
  const failed = await this.store.applyEvent(candidate, "FAIL", "orchestrator", {
    ...runFailureDetails(code, safeMessage, runtime),
    ...(resumeState ? { resumeState } : {}),
  });
  return this.finalizeTerminal(failed);
}
return this.finalizeTerminal(candidate);
```

Do not mutate the caller’s loaded record before publication.

- [ ] **Step 5: Render the stable failure code**

Add this line before the failure message in `renderRun()`:

```ts
...(run.failure?.code ? [`Failure code: ${run.failure.code}`] : []),
```

- [ ] **Step 6: Run focused and existing orchestrator tests**

```bash
node --experimental-strip-types --test test/issue28-transition-bound.test.ts test/orchestrator.test.ts test/failed-run-provenance.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the durable bound**

```bash
git add src/orchestrator.ts src/run-rendering.ts test/issue28-transition-bound.test.ts
git commit -m "fix: durably enforce automatic transition bound"
```

---

### Task 4: Add a source-tree bootstrap fingerprint without weakening read-only enforcement

**Files:**
- Modify: `src/git-snapshot.ts`
- Create: `test/issue28-bootstrap.test.ts`
- Modify: `test/github-authoritative-state.test.ts`

**Interfaces:**
- Produces: `captureWorkspaceSourceFingerprint(cwd: string, timeoutMs?: number): Promise<string>`.
- Consumes: current Git-plane status/diff/untracked commands and existing filesystem hashing conventions.

- [ ] **Step 1: Add red tests for the two fingerprint planes**

In `test/issue28-bootstrap.test.ts`, add Git and non-Git cases:

```ts
test("bootstrap source fingerprint ignores MASWE state but detects source changes", async (t) => {
  const cwd = await initGitRepository(t);
  const before = await captureWorkspaceSourceFingerprint(cwd);
  const store = new FileRunStore(cwd);
  const run = await store.create("fingerprint", "maswe write", DEFAULT_CONFIG);
  const afterRunWrite = await captureWorkspaceSourceFingerprint(cwd);
  assert.equal(afterRunWrite, before);

  await writeFile(path.join(cwd, "src", "changed.ts"), "export const changed = true;\n");
  const afterSourceWrite = await captureWorkspaceSourceFingerprint(cwd);
  assert.notEqual(afterSourceWrite, before);

  const authoritativeBefore = await gitWorkspaceFingerprint(cwd);
  run.request = "changed authoritative state";
  await store.save(run);
  const authoritativeAfter = await gitWorkspaceFingerprint(cwd);
  assert.notEqual(authoritativeAfter, authoritativeBefore);
});
```

Add a non-Git case proving a file outside `.maswe` changes the source fingerprint while `.maswe/runs/x/run.json` does not.

- [ ] **Step 2: Run the fingerprint tests and verify the red state**

```bash
node --experimental-strip-types --test test/issue28-bootstrap.test.ts test/github-authoritative-state.test.ts
```

Expected: FAIL because `captureWorkspaceSourceFingerprint()` does not exist.

- [ ] **Step 3: Refactor the Git source-plane hashing into a private helper**

In `src/git-snapshot.ts`, extract the existing Git status/diff/untracked hashing into:

```ts
async function hashGitSourcePlane(
  cwd: string,
  hash: Hash,
  timeoutMs: number,
): Promise<void>
```

It must continue using `MASWE_GIT_PATHSPEC_EXCLUDES`, so `.maswe` is excluded from all Git-plane commands.

- [ ] **Step 4: Add deterministic non-Git source-tree hashing**

Add a private recursive hasher that:

- skips the first path segment `.maswe`;
- sorts normalized relative paths;
- hashes path identity plus `file`, `directory`, `symlink`, or `other` type markers;
- hashes file bytes or link-target bytes without following symlinks;
- records `unreadable` on read failure using the current fingerprint convention;
- uses the domain separator `maswe:workspace-source-fingerprint:v1\0`.

This task must not redesign canonical framing or race semantics owned by Issue #13.

- [ ] **Step 5: Implement the public helper and preserve current behavior**

```ts
export async function captureWorkspaceSourceFingerprint(
  cwd: string,
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<string> {
  const hash = createHash("sha256");
  hash.update("maswe:workspace-source-fingerprint:v1\0");
  if (await isGitRepository(cwd, timeoutMs)) {
    await hashGitSourcePlane(cwd, hash, timeoutMs);
  } else {
    await hashNonGitSourcePlane(cwd, hash);
  }
  return hash.digest("hex");
}
```

Refactor `gitWorkspaceFingerprint()` to call the same Git source helper and then `hashMasweAuthoritativeState()`. Its output semantics remain unchanged except for code organization.

- [ ] **Step 6: Run focused tests and the existing fingerprint suite**

```bash
node --experimental-strip-types --test test/issue28-bootstrap.test.ts test/github-authoritative-state.test.ts test/workspace-fingerprint.test.ts
```

If `test/workspace-fingerprint.test.ts` does not exist on the execution branch, run every test file returned by:

```bash
grep -l "gitWorkspaceFingerprint" test/*.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the two-plane fingerprint contract**

```bash
git add src/git-snapshot.ts test/issue28-bootstrap.test.ts test/github-authoritative-state.test.ts
git commit -m "feat: separate bootstrap source fingerprint"
```

---

### Task 5: Persist bootstrap intent for every production-created run

**Files:**
- Create: `src/workspace-bootstrap.ts`
- Modify: `src/store.ts`
- Modify: `src/orchestrator.ts`
- Modify: `test/issue28-bootstrap.test.ts`

**Interfaces:**
- Produces: `CreateRunOptions` on `RunStore.create()`.
- Produces: `captureWorkspaceBootstrapIntent(repositoryPath, config, now?)`.
- Produces: private orchestrator `createPlannedRun()` used by `start()` and `supersede()`.
- Consumes: `captureWorkspaceSourceFingerprint()`, `captureWorkspace()`, persisted configuration snapshots.

- [ ] **Step 1: Add red tests for start and supersede planning before Git side effects**

Add a test-only hook to the planned constructor options in the test code expectation:

```ts
beforeBootstrapReconcile?: (run: RunRecord) => Promise<void>;
```

Add tests that make the hook throw and then reload the run list:

```ts
assert.equal(planned.state, "CREATED");
assert.ok(planned.workspaceBootstrap);
assert.equal(planned.workspace, undefined);
assert.equal(planned.events.length, 0);
await assert.rejects(
  execFileAsync("git", ["rev-parse", "--verify", `maswe/${planned.id}`], { cwd }),
);
```

For `supersede()`, identify the replacement by `supersedes === original.id` and assert the same properties.

- [ ] **Step 2: Run the planning tests and verify the red state**

```bash
node --experimental-strip-types --test test/issue28-bootstrap.test.ts
```

Expected: FAIL because initial run creation cannot persist bootstrap intent or `supersedes` atomically.

- [ ] **Step 3: Extend `RunStore.create()` with exact initial fields**

Add:

```ts
export interface CreateRunOptions {
  workspaceBootstrap?: WorkspaceBootstrapIntent;
  supersedes?: string;
}
```

Change the interface and implementation to:

```ts
create(
  title: string,
  request: string,
  config: MasweConfig,
  options?: CreateRunOptions,
): Promise<RunRecord>;
```

Construct the initial record with `workspaceBootstrap` and `supersedes` before the first durable write. Existing tests and historical fixtures may omit options.

- [ ] **Step 4: Implement bootstrap intent capture**

In `src/workspace-bootstrap.ts`:

```ts
export async function captureWorkspaceBootstrapIntent(
  repositoryPath: string,
  config: MasweConfig,
  now: () => string = () => new Date().toISOString(),
): Promise<WorkspaceBootstrapIntent> {
  const source = await captureWorkspace(repositoryPath);
  return {
    mode: config.policy.useIsolatedWorktree
      ? "isolated-worktree"
      : "operator-checkout",
    sourceBaseSha: source.baseSha,
    sourceBranch: source.branch,
    sourceTreeFingerprint: await captureWorkspaceSourceFingerprint(repositoryPath),
    ...(source.remote ? { remote: source.remote } : {}),
    plannedAt: now(),
  };
}
```

- [ ] **Step 5: Route both production creation paths through `createPlannedRun()`**

Add a private orchestrator method:

```ts
private async createPlannedRun(
  title: string,
  request: string,
  config: MasweConfig,
  options: { supersedes?: string } = {},
): Promise<RunRecord> {
  const workspaceBootstrap = await captureWorkspaceBootstrapIntent(
    this.cwd,
    config,
  );
  return this.store.create(title, request, config, {
    workspaceBootstrap,
    ...(options.supersedes ? { supersedes: options.supersedes } : {}),
  });
}
```

`start()` resolves models first, calls this method, runs the test hook, and only then enters bootstrap. `supersede()` uses the existing persisted configuration snapshot and passes `supersedes: existing.id`.

- [ ] **Step 6: Run focused creation and compatibility tests**

```bash
node --experimental-strip-types --test test/issue28-bootstrap.test.ts test/orchestrator.test.ts test/schema.test.ts
```

Expected: PASS for planned intent tests; later bootstrap tests may remain skipped until Task 6 only when explicitly marked with the Node test runner’s skip option.

- [ ] **Step 7: Commit production run planning**

```bash
git add src/workspace-bootstrap.ts src/store.ts src/orchestrator.ts test/issue28-bootstrap.test.ts
git commit -m "feat: persist bootstrap intent before git effects"
```

---

### Task 6: Implement exact bootstrap reconciliation and the real workspace checkpoint

**Files:**
- Modify: `src/workspace-bootstrap.ts`
- Modify: `src/git-workspace.ts`
- Modify: `src/orchestrator.ts`
- Modify: `test/issue28-bootstrap.test.ts`
- Modify: `test/failed-run-provenance.test.ts`

**Interfaces:**
- Produces: `WorkspaceBootstrapHooks` and `reconcileBootstrapWorkspace()`.
- Produces: strict `workingDirectoryFor()` guard.
- Produces: a durable `CREATED + workspace + workspaceBootstrap` checkpoint before `START`.
- Consumes: structured `git worktree list --porcelain`, exact refs, source-tree fingerprint, clean-status helper.

- [ ] **Step 1: Add deterministic failure-barrier tests**

Define hooks:

```ts
export interface WorkspaceBootstrapHooks {
  beforeBranchCreate?: (run: RunRecord) => Promise<void>;
  afterBranchCreate?: (run: RunRecord) => Promise<void>;
  afterWorktreeCreate?: (run: RunRecord) => Promise<void>;
}
```

Add a table-driven test for each hook. The hook throws once, the test reloads the authoritative record, retries with hooks disabled, and asserts the intended branch/worktree exists before the first runtime call.

For the post-checkpoint boundary, use an orchestrator hook:

```ts
afterWorkspaceCheckpoint?: (run: RunRecord) => Promise<void>;
```

After the hook throws, assert:

```ts
const checkpoint = await store.load(run.id);
assert.equal(checkpoint.state, "FAILED");
assert.equal(checkpoint.failure?.resumeState, "CREATED");
assert.ok(checkpoint.workspaceBootstrap);
assert.ok(checkpoint.workspace?.worktreePath);
assert.equal(
  checkpoint.events.some((event) => event.type === "START"),
  false,
);
```

The failed record retains the checkpointed workspace because `failRun()` publishes from the authoritative reload.

- [ ] **Step 2: Add dirty-worktree and conflict tests**

After the worktree is created, write an untracked source file and throw. Retry must remain `FAILED`, must not call the runtime, and must report a dirty managed worktree.

Add separate cases for:

- branch exists at another SHA;
- branch checked out at another worktree path;
- deterministic path occupied by an ordinary directory;
- stale/prunable registration;
- matching registration but wrong branch;
- matching branch/path but wrong HEAD;
- operator-checkout source drift;
- isolated run with no worktree passed to `workingDirectoryFor()`.

- [ ] **Step 3: Run bootstrap tests and verify the red state**

```bash
node --experimental-strip-types --test test/issue28-bootstrap.test.ts test/failed-run-provenance.test.ts
```

Expected: FAIL because reconciliation, checkpointing, and strict reuse do not exist.

- [ ] **Step 4: Add structured worktree inspection**

In `src/git-workspace.ts`, add:

```ts
export interface GitWorktreeRegistration {
  worktreePath: string;
  headSha: string;
  branch?: string;
  prunable: boolean;
}

export async function listGitWorktreeRegistrations(
  repositoryPath: string,
): Promise<GitWorktreeRegistration[]>;
```

Parse blank-line-separated porcelain records. Normalize paths with `path.resolve()`. Represent `branch refs/heads/maswe/x` as `maswe/x`. Reject malformed duplicate fields, missing worktree/head values, and conflicting records rather than guessing.

- [ ] **Step 5: Implement exact reconciliation**

In `src/workspace-bootstrap.ts`, export:

```ts
export async function reconcileBootstrapWorkspace(
  repositoryPath: string,
  run: RunRecord,
  hooks: WorkspaceBootstrapHooks = {},
): Promise<RunWorkspace>;
```

Operator-checkout mode must require exact base SHA, branch, and source-tree fingerprint, then return `captureWorkspace(repositoryPath)`.

Isolated mode must:

1. derive `maswe/${run.id}` and `externalWorktreePath(repositoryPath, run.id)`;
2. inspect branch ref and all worktree registrations;
3. create the branch only when absent, at `sourceBaseSha`;
4. add the worktree only when both path and registration are absent;
5. require exact path, branch, and HEAD;
6. reject prunable/stale registrations;
7. require `isGitWorkspaceClean(worktreePath) === true`;
8. return a fresh `RunWorkspace` with exact HEAD and authoritative fingerprint.

Do not call reset, clean, prune, remove, checkout, rebase, or force operations.

- [ ] **Step 6: Implement the three-phase `CREATED` protocol**

Add a dedicated orchestrator method:

```ts
private async bootstrapCreatedRun(runId: string): Promise<RunRecord>
```

Its protocol is:

```ts
let run = await this.store.load(runId);
if (run.state !== "CREATED") return run;

if (!run.workspace) {
  const workspace = await reconcileBootstrapWorkspace(
    this.cwd,
    run,
    this.options.bootstrapHooks,
  );
  const checkpoint = structuredClone(run);
  checkpoint.workspace = workspace;
  await this.store.save(checkpoint);
  await this.options.afterWorkspaceCheckpoint?.(structuredClone(checkpoint));
  run = await this.store.load(runId);
}

await assertBootstrapWorkspaceReady(this.cwd, run);
const started = structuredClone(run);
delete started.workspaceBootstrap;
return this.store.applyEvent(started, "START", "user");
```

On any error, reload the authoritative run and call `failRun(authoritative, ...)`, preserving whichever checkpoint was actually published.

`advance()` handles `CREATED` by calling this method. `start()` and replacement `supersede()` call `runUntilBlocked()` rather than performing workspace setup themselves.

- [ ] **Step 7: Make isolated working-directory selection fail closed**

Replace the fallback in `workingDirectoryFor()`:

```ts
export function workingDirectoryFor(run: RunRecord): string {
  if (run.config.policy.useIsolatedWorktree) {
    if (!run.workspace?.worktreePath) {
      throw new Error(
        `Run ${run.id} requires an established MASWE-managed worktree`,
      );
    }
    return run.workspace.worktreePath;
  }
  return run.repositoryPath;
}
```

- [ ] **Step 8: Run bootstrap, retry-provenance, and orchestrator tests**

```bash
node --experimental-strip-types --test test/issue28-bootstrap.test.ts test/failed-run-provenance.test.ts test/orchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit exact bootstrap recovery**

```bash
git add src/workspace-bootstrap.ts src/git-workspace.ts src/orchestrator.ts test/issue28-bootstrap.test.ts test/failed-run-provenance.test.ts
git commit -m "feat: recover CREATED workspace bootstrap"
```

---

### Task 7: Publish retry coherently without deleting recovery metadata

**Files:**
- Modify: `src/orchestrator.ts`
- Modify: `src/workspace-bootstrap.ts`
- Create: `test/issue28-retry-publication.test.ts`
- Modify: `test/orchestrator.test.ts`
- Modify: `test/failed-run-provenance.test.ts`

**Interfaces:**
- Produces: `reconcileRetryWorkspace(repositoryPath, run)`.
- Consumes: `failure.resumeState`, `previousFailure`, bootstrap reconciliation, exact managed-worktree cleanliness.

- [ ] **Step 1: Add a pre-publication failure test**

Create a `RunStore` wrapper that throws before delegating `RETRY_FROM_FAILED`:

```ts
class RejectRetryEventStore implements RunStore {
  constructor(private readonly delegate: RunStore) {}

  create = this.delegate.create.bind(this.delegate);
  save = this.delegate.save.bind(this.delegate);
  load = this.delegate.load.bind(this.delegate);
  list = this.delegate.list.bind(this.delegate);
  writeArtifact = this.delegate.writeArtifact.bind(this.delegate);
  readArtifact = this.delegate.readArtifact.bind(this.delegate);

  async applyEvent(
    run: RunRecord,
    type: WorkflowEventType,
    actor: string,
    details?: Record<string, unknown>,
  ): Promise<RunRecord> {
    if (type === "RETRY_FROM_FAILED") {
      throw new Error("injected retry publication failure");
    }
    return this.delegate.applyEvent(run, type, actor, details);
  }
}
```

After rejection, reload through the real `FileRunStore` and assert the original state, complete failure metadata, and `resumeState` remain.

- [ ] **Step 2: Add version-conflict and outcome-unknown tests**

For a version conflict, mutate the authoritative run after the retry candidate is loaded through a deterministic hook and assert the canonical `FAILED` record remains actionable.

For outcome unknown, construct a `FileRunStore` whose `syncDirectory` throws once after rename. Assert one of exactly two outcomes:

```ts
const authoritative = await durableStore.load(run.id);
const retryEvents = authoritative.events.filter(
  (event) => event.type === "RETRY_FROM_FAILED",
);
if (retryEvents.length === 0) {
  assert.equal(authoritative.state, "FAILED");
  assert.ok(authoritative.failure?.resumeState);
} else {
  assert.equal(retryEvents.length, 1);
  assert.notEqual(authoritative.state, "FAILED");
  assert.equal(authoritative.failure, undefined);
}
```

- [ ] **Step 3: Run the retry tests and verify the red state**

```bash
node --experimental-strip-types --test test/issue28-retry-publication.test.ts test/orchestrator.test.ts test/failed-run-provenance.test.ts
```

Expected: FAIL because current retry deletes failure and may save while still durably `FAILED`.

- [ ] **Step 4: Implement retry workspace reconciliation on a clone**

Export:

```ts
export async function reconcileRetryWorkspace(
  repositoryPath: string,
  run: RunRecord,
): Promise<RunWorkspace | undefined>
```

Behavior:

- `failure.resumeState === "CREATED"`: require retained bootstrap intent and call `reconcileBootstrapWorkspace()`.
- later isolated state: require persisted workspace identity, exact branch/path/registration/HEAD, and clean status; recreate only an absent exact worktree from the preserved branch/head.
- operator-checkout state: verify current branch, HEAD, and source identity appropriate to the persisted workspace.
- any conflict or dirty state fails without mutating the authoritative record.

- [ ] **Step 5: Replace retry publication with one candidate event**

Implement:

```ts
const failed = await this.store.load(runId);
const resumeState = failed.failure?.resumeState;
if (failed.state !== "FAILED" || !resumeState) {
  throw new Error("retry requires a FAILED run with failure.resumeState");
}
const previousFailure = structuredClone(failed.failure);
const candidate = structuredClone(failed);
const workspace = await reconcileRetryWorkspace(this.cwd, candidate);
if (workspace) candidate.workspace = workspace;
delete candidate.failure;

try {
  await this.store.applyEvent(candidate, "RETRY_FROM_FAILED", "user", {
    resumeState,
    previousFailure,
  });
} catch (error) {
  const authoritative = await this.store.load(runId);
  const retryEvent = authoritative.events.find(
    (event) => event.type === "RETRY_FROM_FAILED" && event.from === "FAILED",
  );
  if (!retryEvent && authoritative.state === "FAILED" && authoritative.failure?.resumeState) {
    throw error;
  }
  if (!retryEvent || authoritative.failure !== undefined) {
    throw new Error("Retry publication produced an inconsistent authoritative record", {
      cause: error,
    });
  }
}
return this.runUntilBlocked(runId);
```

Compare the exact new event ID/version against the pre-publication snapshot so an old historical retry event cannot be mistaken for the current publication.

- [ ] **Step 6: Run focused retry and persistence tests**

```bash
node --experimental-strip-types --test test/issue28-retry-publication.test.ts test/orchestrator.test.ts test/failed-run-provenance.test.ts test/github-authoritative-state.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit coherent retry publication**

```bash
git add src/orchestrator.ts src/workspace-bootstrap.ts test/issue28-retry-publication.test.ts test/orchestrator.test.ts test/failed-run-provenance.test.ts
git commit -m "fix: preserve retry metadata until publication"
```

---

### Task 8: Add initial revalidation, active retargeting, and generation fences

**Files:**
- Create: `src/revalidation.ts`
- Modify: `src/orchestrator.ts`
- Create: `test/issue28-revalidation.test.ts`
- Modify: `test/evidence-freshness.test.ts`

**Interfaces:**
- Produces: `RevalidationService.route()` and `reconcileRequiredTarget()`.
- Produces: `RevalidationFence`, `captureRevalidationFence()`, `assertRevalidationFence()`.
- Consumes: `RunStore`, `invalidateStaleEvidence()`, centralized request/retarget transitions.

- [ ] **Step 1: Add initial request and return-gate tests**

Seed exact `PR_READY` and `PR_REVIEW` records with evidence bound to head A. Route target B and assert:

```ts
assert.equal(result.state, "CI_RUNNING");
assert.equal(result.revalidation?.returnState, sourceState);
assert.equal(result.revalidation?.originHeadSha, headA);
assert.equal(result.revalidation?.requestedHeadSha, headB);
assert.equal(result.revalidation?.generation, 1);
assert.equal(result.evidence, undefined);
assert.equal(result.events.at(-1)?.type, "REVALIDATE_REQUESTED");
```

Run quality and verification with a mock runtime and assert the successful state returns to the recorded gate even when `commentResolutionCycles === 0` for `PR_REVIEW`.

- [ ] **Step 2: Add B-to-C retarget tests for every active state and failed recovery**

For `CI_RUNNING`, `BUILDING`, and `VERIFYING`, seed active generation 1 targeting B, route C, and assert state `CI_RUNNING`, generation 2, and event `REVALIDATION_RETARGETED`.

For `FAILED`, seed `failure.resumeState: "VERIFYING"` plus active context targeting B. Route C and assert:

```ts
assert.equal(result.state, "FAILED");
assert.equal(result.failure?.resumeState, "CI_RUNNING");
assert.equal(result.revalidation?.requestedHeadSha, headC);
assert.equal(result.revalidation?.generation, 2);
assert.equal(result.events.at(-1)?.type, "REVALIDATION_RETARGETED");
assert.equal(
  result.events.at(-1)?.details?.previousResumeState,
  "VERIFYING",
);
```

Add same-target idempotency: version and event count do not change.

- [ ] **Step 3: Add generation-fence tests**

Capture a fence for B, retarget to C, and assert:

```ts
await assert.rejects(
  assertRevalidationFence(store, run.id, fenceB),
  /generation|target|version/i,
);
```

Capture a fresh C fence and assert it passes.

- [ ] **Step 4: Run revalidation tests and verify the red state**

```bash
node --experimental-strip-types --test test/issue28-revalidation.test.ts test/evidence-freshness.test.ts
```

Expected: FAIL because the service and generation contract do not exist.

- [ ] **Step 5: Implement `RevalidationService`**

Use:

```ts
export interface RevalidationTargetInput {
  source: RevalidationSource;
  requestedHeadSha: string;
  actor: string;
  observedWorkspace?: RunWorkspace;
  at?: string;
}

export class RevalidationService {
  constructor(
    private readonly store: RunStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async route(runId: string, input: RevalidationTargetInput): Promise<RunRecord>;
}
```

`route()` loads the authoritative record and performs exactly one of:

- no context + gate state: create generation 1 and publish `REVALIDATE_REQUESTED`;
- active context + same target: optionally save only a supplied observed workspace and publish no event;
- active context + different target: increment generation and publish `REVALIDATION_RETARGETED`;
- no legal source state: fail closed.

For failed retarget, clone the prior failure, update `candidate.failure.resumeState = "CI_RUNNING"`, and include the previous resume state in event details. Preserve the historical `FAIL` event.

- [ ] **Step 6: Add target reconciliation and fencing helpers**

```ts
export interface RevalidationFence {
  runVersion: number;
  generation: number;
  requestedHeadSha: string;
}

export function captureRevalidationFence(
  run: RunRecord,
): RevalidationFence | undefined;

export async function assertRevalidationFence(
  store: RunStore,
  runId: string,
  fence: RevalidationFence,
): Promise<void>;
```

`assertRevalidationFence()` reloads and requires exact version, generation, and target. Do not accept a later version merely because target text matches.

`reconcileRequiredTarget()` chooses `run.github.headSha` for associated runs and exact observed workspace HEAD for local-only runs, then delegates to `route()`.

- [ ] **Step 7: Integrate revalidation preflight and return behavior into the orchestrator**

Before stopping at `PR_READY` or `PR_REVIEW`, refresh the exact workspace. If required evidence is absent/stale or the head changed, route revalidation and continue.

Before advancing active `BUILDING`, `CI_RUNNING`, or `VERIFYING`, reconcile the required target. If routing publishes a retarget, return that result so the next loop iteration starts at `CI_RUNNING`.

During verification success selection:

```ts
const successEvent = run.revalidation?.returnState === "PR_READY"
  ? "VERIFY_PASSED"
  : run.revalidation?.returnState === "PR_REVIEW"
    ? "VERIFY_PASSED_AFTER_REVIEW"
    : run.counters.commentResolutionCycles > 0
      ? "VERIFY_PASSED_AFTER_REVIEW"
      : "VERIFY_PASSED";
```

Delete `candidate.revalidation` on the same candidate passed to the successful event publication.

- [ ] **Step 8: Fence commits and evidence publication**

After each orchestrator-owned artifact write and immediately before deterministic commit, CI-event publication, verifier-event publication, or return-to-gate success:

1. capture the current fence from the updated run object;
2. reload and assert it;
3. perform the side effect/publication;
4. rely on optimistic version checks for a later race;
5. on conflict, reload and follow the current target without publishing stale success.

Do not label B-bound evidence as C-bound evidence.

- [ ] **Step 9: Run focused and existing workflow tests**

```bash
node --experimental-strip-types --test test/issue28-revalidation.test.ts test/evidence-freshness.test.ts test/orchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit revalidation core behavior**

```bash
git add src/revalidation.ts src/orchestrator.ts test/issue28-revalidation.test.ts test/evidence-freshness.test.ts
git commit -m "feat: revalidate against latest workflow head"
```

---

### Task 9: Split GitHub association publication from non-rollback routing

**Files:**
- Modify: `src/github/adapter.ts`
- Modify: `src/github/association.ts`
- Create: `test/issue28-github-reconciliation.test.ts`
- Modify: `test/github-adapter.integration.test.ts`

**Interfaces:**
- Produces: event-free `saveAssociationSnapshot()` and field-scoped rollback.
- Produces: `afterAssociationCommitBeforeRouting` deterministic test seam.
- Consumes: `RevalidationService.route()` after association commit.

- [ ] **Step 1: Add failure-matrix tests for event preservation**

Cover these injection points:

1. run snapshot save fails;
2. association index write fails before publication;
3. association index rename publishes but directory sync fails;
4. process seam throws after association commit and before routing;
5. request/retarget event publication fails;
6. a concurrent event is published before a known-failure rollback callback runs.

For every case reload the run and assert:

```ts
assert.deepEqual(
  authoritative.events.map((event) => event.id),
  expectedEventIds,
);
assert.ok(authoritative.events.length >= before.events.length);
```

No callback may restore fewer events, a previous state, a prior failure object, or a prior revalidation generation.

- [ ] **Step 2: Add B-to-C webhook and crash-recovery tests**

Deliver head B to a `PR_REVIEW` run with zero comment cycles, assert generation 1. Before work completes, deliver C and assert generation 2 targeting C.

Inject a stop after association commit but before routing. The durable run must retain `github.headSha === C` and invalidated evidence. A repeated delivery or later orchestrator preflight must publish the missing request/retarget exactly once.

- [ ] **Step 3: Run GitHub reconciliation tests and verify the red state**

```bash
node --experimental-strip-types --test test/issue28-github-reconciliation.test.ts test/github-adapter.integration.test.ts
```

Expected: FAIL because current full-snapshot rollback can remove events and routing occurs inside the rollback scope.

- [ ] **Step 4: Implement event-history equality guards**

Add private adapter helpers:

```ts
function eventIdentity(events: RunRecord["events"]): string[] {
  return events.map((event) =>
    JSON.stringify({
      id: event.id,
      at: event.at,
      type: event.type,
      actor: event.actor,
      from: event.from,
      to: event.to,
      details: event.details,
    })
  );
}

function assertEventHistoryUnchanged(
  expected: RunRecord,
  actual: RunRecord,
): void {
  assert.deepEqual(eventIdentity(actual.events), eventIdentity(expected.events));
}
```

Use production error checks rather than importing the test assertion library: compare serialized arrays and throw an exact rollback-fence error when they differ.

- [ ] **Step 5: Replace full-snapshot rollback with field-scoped rollback**

Capture only:

```ts
interface AssociationRunFields {
  github?: RunRecord["github"];
  evidence?: RunRecord["evidence"];
}
```

On known index non-publication, reload and require exact attempted version plus unchanged state, events, failure, revalidation, artifacts, approvals, and counters. Clone the current record and restore only `github` and `evidence`. Refuse rollback on any mismatch.

Do not roll back on `DurableAtomicWriteOutcomeUnknownError`; retain the association class’s existing outcome-unknown rule and reconcile by reload.

- [ ] **Step 6: Implement two-phase live-head handling**

Under the per-PR publication fence:

**Phase A inside `associations.withTransaction()`:**

- load run;
- update `github.headSha`, pending cancellation heads, and stale evidence only;
- publish no workflow event and do not alter revalidation target;
- save the event-free snapshot;
- bind the index;
- register only field-scoped rollback.

**Phase B after transaction success:**

- invoke `afterAssociationCommitBeforeRouting` when configured;
- reload run;
- call `RevalidationService.route()` with source `github` and the committed live head;
- publish checks from the resulting authoritative state;
- never register the request/retarget event with association rollback.

Apply the same protocol to webhook head changes and manual check publication live-head refresh.

- [ ] **Step 7: Clarify association transaction callback semantics**

In `src/github/association.ts`, document and test:

- rollback callbacks run only for known non-publication failures;
- callbacks do not run for `DurableAtomicWriteOutcomeUnknownError`;
- callbacks execute in reverse registration order;
- callback failure is aggregated without masking the original failure.

No new distributed transaction abstraction is introduced.

- [ ] **Step 8: Run focused GitHub and durable-ingress tests**

```bash
node --experimental-strip-types --test test/issue28-github-reconciliation.test.ts test/github-adapter.integration.test.ts test/github-durable-ingress.test.ts test/github-authoritative-state.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit append-only GitHub reconciliation**

```bash
git add src/github/adapter.ts src/github/association.ts test/issue28-github-reconciliation.test.ts test/github-adapter.integration.test.ts
git commit -m "fix: preserve events during github head routing"
```

---

### Task 10: Harden merge-ready, completion, and retry against active revalidation

**Files:**
- Modify: `src/orchestrator.ts`
- Modify: `test/issue28-revalidation.test.ts`
- Modify: `test/evidence-freshness.test.ts`
- Modify: `test/issue28-retry-publication.test.ts`

**Interfaces:**
- Produces: one exact current-head gate predicate used by merge-ready and completion.
- Consumes: current workspace, GitHub head, revalidation target, quality/verification/merge-ready evidence.

- [ ] **Step 1: Add gate-rejection tests**

For both `markMergeReady()` and `complete()`, cover:

- active revalidation context;
- workspace head differs from `revalidation.requestedHeadSha`;
- associated GitHub head differs from workspace or requested target;
- quality evidence missing, failed, or stale;
- verification evidence missing, failed, or stale;
- managed worktree dirty or wrong branch;
- completion merge-ready evidence missing or stale.

Assert no event, evidence, or state change after rejection.

- [ ] **Step 2: Add retry-to-latest-target tests**

Seed failed active revalidation targeting B, update `github.headSha` to C without the retarget event, call retry, and assert retry first publishes `REVALIDATION_RETARGETED` or otherwise leaves the run `FAILED` with operational resume state `CI_RUNNING` and generation targeting C. It must not resume B-bound verification.

- [ ] **Step 3: Run focused tests and verify the red state**

```bash
node --experimental-strip-types --test test/issue28-revalidation.test.ts test/evidence-freshness.test.ts test/issue28-retry-publication.test.ts
```

Expected: FAIL where current gate checks do not account for active context or all three head identities.

- [ ] **Step 4: Add one exact gate assertion helper**

In `src/orchestrator.ts`, add a private method that reloads or synchronizes the current workspace and requires:

```text
no run.revalidation
workspace HEAD known
workspace branch exact
managed worktree clean when isolated
if associated: workspace.headSha == github.headSha
quality evidence current and passing when required
verification evidence current and passing when required
for completion: mergeReady evidence current and passing
```

Return the current head SHA for event details. Do not recover success from historical events after evidence invalidation.

- [ ] **Step 5: Reconcile latest target before retry continuation**

At the start of `retryFromFailed()`, after loading the failure but before workspace reconciliation, compare active `revalidation.requestedHeadSha` with the required current target. Publish or reconcile `REVALIDATION_RETARGETED` while retaining the failed state, then reload and continue only from the latest generation.

- [ ] **Step 6: Run all focused gate and retry tests**

```bash
node --experimental-strip-types --test test/issue28-revalidation.test.ts test/evidence-freshness.test.ts test/issue28-retry-publication.test.ts test/orchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit current-head gate enforcement**

```bash
git add src/orchestrator.ts test/issue28-revalidation.test.ts test/evidence-freshness.test.ts test/issue28-retry-publication.test.ts
git commit -m "fix: require current-head evidence at final gates"
```

---

### Task 11: Synchronize rendering, schema literals, and public documentation

**Files:**
- Modify: `src/run-rendering.ts`
- Create: `test/issue28-rendering.test.ts`
- Modify: `test/schema.test.ts`
- Modify: `docs/PRD.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/ARTIFACT_CONTRACTS.md`
- Modify: `docs/GITHUB_APP.md`
- Modify: `docs/OPERATIONS.md`

**Interfaces:**
- Produces: operator-visible bootstrap phase, revalidation source/target/generation/return gate, and stable failure code.
- Consumes: final domain names and exact state/event behavior from Tasks 1–10.

- [ ] **Step 1: Add rendering tests**

Create exact run fixtures for:

- `CREATED` with planned intent and no workspace;
- `CREATED` with workspace checkpoint;
- `FAILED` with `resumeState: CREATED` and bootstrap intent;
- active GitHub revalidation generation 3 returning to `PR_REVIEW`;
- automatic-transition overflow.

Assert human output contains bounded lines such as:

```text
Failure code: automatic-transition-limit-exceeded
Bootstrap: mode=isolated-worktree, phase=workspace-checkpointed
Revalidation: source=github, target=<12-char-sha>, generation=3, return=PR_REVIEW
```

Do not print the full repository path twice or expose credentials embedded in remotes.

- [ ] **Step 2: Run rendering tests and verify the red state**

```bash
node --experimental-strip-types --test test/issue28-rendering.test.ts
```

Expected: FAIL because the new status lines are absent.

- [ ] **Step 3: Implement bounded rendering**

Use existing diagnostic sanitizers for any conflict/error text. Render SHA displays with the existing 12-character convention. Derive bootstrap phase from record shape rather than persisting another field.

- [ ] **Step 4: Add schema/domain synchronization assertions**

In `test/schema.test.ts`, assert the JSON Schema enums contain every `WORKFLOW_EVENT`, `WORKFLOW_STATE`, and `RunFailureCode` literal used by the TypeScript contract. Add negative cases for:

- generation zero;
- unsupported source/return state;
- extra metadata property;
- failed retarget without active revalidation during store event publication;
- contradictory `CREATED` checkpoint without bootstrap intent where the new invariant applies.

Historical schema-v1 records that predate new metadata remain accepted under the documented conservative migration rules.

- [ ] **Step 5: Update the PRD**

Document:

- automatic advance checks the resulting state before durable overflow;
- all production creation paths persist bootstrap intent first;
- bootstrap source drift excludes MASWE state writes;
- retry preserves its prior durable recovery key until complete publication;
- stale evidence routes through explicit request/retarget semantics to the latest head;
- final gates require exact current-head evidence.

- [ ] **Step 6: Update architecture and artifact contracts**

Add the new state-machine edges, two fingerprint planes, real workspace checkpoint, cloned failure/retry publication, generation fencing, append-only event rule, and corrected editing-event SHA meaning.

The artifact contract must state that corrected `headSha` semantics apply to newly published events and historical events are not rewritten.

- [ ] **Step 7: Update GitHub App and operations documentation**

Document the two-phase association/routing protocol, crash point after index commit, B-to-C coalescing, outcome-unknown reconciliation, dirty-worktree refusal, and operator procedures for blocked bootstrap/alignment.

Do not imply that Phase A fetches or moves a local branch.

- [ ] **Step 8: Run contract, rendering, and documentation-sensitive tests**

```bash
node --experimental-strip-types --test test/issue28-rendering.test.ts test/schema.test.ts test/state-machine.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit public-contract synchronization**

```bash
git add src/run-rendering.ts test/issue28-rendering.test.ts test/schema.test.ts docs/PRD.md docs/ARCHITECTURE.md docs/ARTIFACT_CONTRACTS.md docs/GITHUB_APP.md docs/OPERATIONS.md
git commit -m "docs: synchronize Issue 28 recovery contracts"
```

---

### Task 12: Run complete validation and prepare exact-head review

**Files:**
- Review: all files changed since `d85451f984a80ec6681dfcd7226a31099b1479fe`
- Modify only when a verification failure proves a defect in the Issue #28 scope.

**Interfaces:**
- Consumes: every prior task deliverable.
- Produces: exact canonical and compatibility evidence for review.

- [ ] **Step 1: Verify scope before running the suite**

```bash
git status --short
git diff --name-only d85451f984a80ec6681dfcd7226a31099b1479fe...HEAD
git diff --check d85451f984a80ec6681dfcd7226a31099b1479fe...HEAD
```

Expected: only Issue #28 production, test, schema, plan/spec, rendering, and listed documentation files; no dependencies, runtime adapters, configuration schema, package files, or workflows.

- [ ] **Step 2: Run every Issue #28 focused suite on canonical Node 24.18.0**

Record:

```bash
command -v node
node --version
node -p 'process.execPath'
npm --version
```

Require `node --version` to equal `v24.18.0`, then run:

```bash
node --experimental-strip-types --test \
  test/issue28-transition-bound.test.ts \
  test/issue28-bootstrap.test.ts \
  test/issue28-retry-publication.test.ts \
  test/issue28-revalidation.test.ts \
  test/issue28-github-reconciliation.test.ts \
  test/issue28-rendering.test.ts \
  test/commit-provenance.test.ts \
  test/evidence-freshness.test.ts \
  test/failed-run-provenance.test.ts \
  test/state-machine.test.ts \
  test/schema.test.ts
```

Expected: all tests pass, zero failures.

- [ ] **Step 3: Run full canonical validation**

```bash
npm run check
npm run pack:dry
git diff --check
```

Expected: all commands exit zero.

- [ ] **Step 4: Run exact Node 22.22.2 compatibility validation**

Switch through the project-supported runtime manager, record the same executable evidence, require `v22.22.2`, then run:

```bash
npm run check
npm run pack:dry
git diff --check
```

Expected: all commands exit zero.

- [ ] **Step 5: Inspect authoritative recovery claims manually**

Review the focused tests and implementation line by line against the approved spec. Confirm:

- all four bootstrap failure barriers reload disk state;
- dirty registered worktrees are rejected;
- `supersede()` persists intent before side effects;
- retry failure never leaves `FAILED` without `resumeState`;
- B-to-C retarget works in active and failed states;
- generation fencing blocks B evidence after C;
- GitHub rollback cannot reduce event history;
- merge-ready/completion reject active or stale evidence;
- historical event SHAs remain unchanged.

- [ ] **Step 6: Commit only verification-driven corrections**

When verification reveals an Issue #28 defect, add or strengthen the failing regression first, implement the smallest correction, rerun the focused test, then rerun the full canonical suite. Commit corrections by concern; do not use a generic cleanup commit.

- [ ] **Step 7: Prepare exact-head review evidence**

Capture:

```bash
git rev-parse HEAD
git status --short
git diff --stat d85451f984a80ec6681dfcd7226a31099b1479fe...HEAD
git diff --check d85451f984a80ec6681dfcd7226a31099b1479fe...HEAD
```

Record canonical Node 24 and compatibility Node 22 command output separately. Request independent review against the exact final SHA and require zero unresolved actionable threads before merge.

---

## Requirement Coverage Check

| Requirement | Implemented by |
|---|---|
| Correct builder/resolver `headSha` | Task 2 |
| Durable and boundary-correct automatic limit | Task 3 |
| Source fingerprint excludes `.maswe` | Task 4 |
| Every production creation path persists intent | Task 5 |
| Recoverable branch/worktree partial creation | Task 6 |
| Real `CREATED + workspace` checkpoint | Task 6 |
| Dirty registered worktree rejection | Tasks 6–7 |
| Retry preserves recovery metadata | Task 7 |
| Revalidation from both PR gates | Task 8 |
| Active/failed B-to-C retarget | Tasks 8–10 |
| Generation fence blocks stale evidence | Task 8 |
| Append-only event history across association failure | Task 9 |
| Final gates reject stale/active evidence | Task 10 |
| Schema, rendering, artifact, architecture, PRD, GitHub, operations synchronization | Task 11 |
| Exact Node 24.18.0 and 22.22.2 validation | Task 12 |

## Plan Self-Review Result

- Every original Issue #28 acceptance criterion maps to at least one task and focused test.
- All six external-review findings map to blocking implementation tasks and regressions.
- No task introduces an unowned Issue #29, #30, #34, Phase B, dependency, runtime-adapter, or CLI-parser change.
- Function and type names are consistent across producers and consumers.
- The plan contains no unresolved design marker or deferred implementation placeholder.
- The execution sequence keeps each commit independently testable and reviewable.
