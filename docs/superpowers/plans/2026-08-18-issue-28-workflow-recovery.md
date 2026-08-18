# Issue #28 Workflow Provenance, Recovery, and Revalidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair Issue #28 so MASWE publishes exact evaluated SHA provenance, recovers every partial `CREATED` bootstrap, durably handles automatic-transition overflow and retry publication, and revalidates stale evidence against the latest local or GitHub head without rolling back workflow history.

**Architecture:** Keep schema version `1`, the optimistic file store, and `src/state-machine.ts` as the sole transition map. Add two focused helpers: `src/workspace-bootstrap.ts` owns bootstrap intent capture and exact workspace reconciliation, while `src/revalidation.ts` owns request/retarget metadata and publishes transitions only through `RunStore.applyEvent()`. GitHub head handling becomes a two-phase protocol: rollback-capable event-free association publication followed by non-rollback workflow routing.

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

- `src/workspace-bootstrap.ts` — bootstrap intent capture, source identity checks, structured worktree reconciliation, clean-status enforcement, and retry-safe workspace restoration. It does not publish workflow events.
- `src/revalidation.ts` — initial revalidation, active/failed retargeting, required-target reconciliation, and generation fences. It publishes transitions through `RunStore.applyEvent()`.

### Modified production files

- `src/domain.ts` — new metadata types, event values, and failure code.
- `src/state-machine.ts` — centralized request/retarget transitions and constrained failed self-transition.
- `src/git-snapshot.ts` — source-tree fingerprint that excludes `.maswe` without changing the authoritative read-only fingerprint.
- `src/git-workspace.ts` — structured worktree inspection, strict isolated-workspace guard, and dirty-worktree rejection.
- `src/store.ts` — initial run fields, exact migration allowlists, and transition-context forwarding.
- `src/run-record-validation.ts` — exact validation for bootstrap and revalidation metadata.
- `src/orchestrator.ts` — planned run creation, real `CREATED + workspace` checkpoint, durable overflow/failure/retry, revalidation preflight, generation fences, and return-to-gate behavior.
- `src/run-rendering.ts` — stable failure code and bootstrap/revalidation diagnostics.
- `src/github/adapter.ts` — two-phase association/routing protocol and deterministic crash-recovery seams.
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
- Consumes: existing `RunRecord`, `WorkflowState`, `WorkflowEventType`, `RunFailureCode`, and `RunStore.applyEvent()`.

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

test("Issue 28 metadata rejects extra fields and invalid generation", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue28-schema-invalid-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
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

Add to `src/state-machine.ts`:

```ts
export interface TransitionContext {
  retryResumeState?: WorkflowState;
  failureResumeState?: WorkflowState;
  hasRevalidation?: boolean;
}
```

Use the context in `transition()`:

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

Add the request/retarget mappings to `TRANSITIONS`, add `CREATED` to `RESUMABLE_STATES`, and make `allowedEvents()` accept an optional `TransitionContext` so it exposes failed retarget only when the same preconditions hold.

- [ ] **Step 7: Forward transition context and validate exact metadata**

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
- Consumes: existing `createDeterministicCommit()`, `run.workspace.headSha`, and `runtimeEventIdentityDetails()`.

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

Use `MockRuntime` for comment classification and all roles not explicitly edited by the fixture.

- [ ] **Step 2: Add failing builder and resolver assertions**

For the editing builder test, add:

```ts
assert.equal(build.details?.headSha, build.details?.outputHeadSha);
assert.equal(build.details?.headSha, run.workspace?.headSha);
assert.notEqual(build.details?.inputHeadSha, build.details?.headSha);
```

Add editing and no-op resolver tests. For each `RESOLUTION_COMPLETED` event assert:

```ts
assert.equal(resolution.details?.headSha, resolution.details?.outputHeadSha);
assert.equal(resolution.details?.headSha, run.workspace?.headSha);
```

The editing case also asserts input differs; the no-op case asserts all three SHA fields are equal.

- [ ] **Step 3: Run the provenance test and verify the red state**

```bash
node --experimental-strip-types --test test/commit-provenance.test.ts
```

Expected: FAIL because public `headSha` still records the input SHA.

- [ ] **Step 4: Bind public `headSha` to the evaluated output**

In builder and resolver publication, compute:

```ts
const evaluatedHeadSha =
  outputHeadSha ?? beforeSha ?? run.workspace?.headSha;
```

Publish details with this shape:

```ts
{
  ...runtimeEventIdentityDetails(result),
  marker: markers.marker,
  ...(beforeSha ? { inputHeadSha: beforeSha } : {}),
  ...(evaluatedHeadSha
    ? {
        headSha: evaluatedHeadSha,
        outputHeadSha: evaluatedHeadSha,
      }
    : {}),
}
```

Do not rewrite historical events.

- [ ] **Step 5: Run focused provenance and evidence tests**

```bash
node --experimental-strip-types --test test/commit-provenance.test.ts test/evidence-freshness.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the provenance correction**

```bash
git add src/orchestrator.ts test/commit-provenance.test.ts
git commit -m "fix: bind editing events to evaluated head"
```

---

### Task 3: Make the automatic-transition bound and failure publication durable

**Files:**
- Modify: `src/orchestrator.ts`
- Modify: `src/run-rendering.ts`
- Create: `test/issue28-transition-bound.test.ts`

**Interfaces:**
- Produces: `OrchestratorOptions.automaticTransitionLimit` test seam.
- Produces: clone-staged `failRun()` publication and stable overflow code.
- Consumes: `isHumanGate()`, `isTerminal()`, `RunStore.applyEvent()`.

- [ ] **Step 1: Add exact-boundary tests**

Create three tests:

1. bound `1`, seeded `BRAINSTORMING`, approval required: one advance reaches `WAITING_FOR_BRAINSTORM_APPROVAL` and returns it;
2. bound `1`, seeded `BUILDING` with `buildVerifyCycles === maxBuildVerifyCycles`: one advance reaches `FAILED` and returns it;
3. bound `1`, seeded `BRAINSTORMING`, approval disabled: one advance ends in automatic `DESIGNING`, then overflow durably publishes `FAILED` with code `automatic-transition-limit-exceeded` and `resumeState: "DESIGNING"`.

Every test reloads through `FileRunStore` before asserting state, code, resume state, and final event.

- [ ] **Step 2: Add failure outcome-unknown coverage**

Use a store whose directory sync throws once after the `FAIL` rename. Reload and require either the exact new `FAIL` event and complete failure record, or the unchanged prior automatic record. Reject any partial failure metadata without the event.

- [ ] **Step 3: Run the new test and verify the red state**

```bash
node --experimental-strip-types --test test/issue28-transition-bound.test.ts
```

Expected: FAIL because the loop throws at the boundary and failure publication is multi-write.

- [ ] **Step 4: Add constructor options without parameter properties**

In `src/orchestrator.ts`:

```ts
export interface OrchestratorOptions {
  automaticTransitionLimit?: number;
}

export class Orchestrator {
  private readonly options: OrchestratorOptions;

  constructor(
    cwd: string,
    config: MasweConfig,
    runtime: AgentRuntime,
    store?: RunStore,
    options: OrchestratorOptions = {},
  ) {
    this.cwd = cwd;
    this.config = config;
    this.runtime = runtime;
    this.store = store ?? new FileRunStore(cwd);
    this.options = options;
  }
}
```

Validate the supplied limit as a positive safe integer; production default remains `20`.

- [ ] **Step 5: Check resulting state before overflow**

Implement `runUntilBlocked()` so every advance follows this order:

```ts
run = await this.advance(run.id);
iterations += 1;
if (isTerminal(run.state) || isHumanGate(run.state)) return run;
if (iterations >= automaticTransitionLimit) {
  return this.failRun(
    run,
    `Workflow exceeded ${automaticTransitionLimit} automatic transitions.`,
    "automatic-transition-limit-exceeded",
  );
}
```

The initial human-gate/terminal check remains before the loop.

- [ ] **Step 6: Publish failure from one cloned candidate**

Refactor `failRun()`:

```ts
const candidate = structuredClone(run);
const resumeState = isTerminal(candidate.state) ? undefined : candidate.state;
candidate.failure = {
  code,
  message: safeMessage,
  at: new Date().toISOString(),
  ...(resumeState ? { resumeState } : {}),
  ...(runtime ? { runtime } : {}),
};
const beforeEventIds = new Set(run.events.map((event) => event.id));
```

Publish `FAIL` once through `applyEvent(candidate, ...)`. On error, reload and accept publication only when one new `FAIL` event not present in `beforeEventIds`, state `FAILED`, and complete failure metadata are all present. If the prior record remains unchanged, rethrow the storage error. Reject every other shape as inconsistent.

- [ ] **Step 7: Render the stable failure code**

Add one line before the failure message when a code exists:

```ts
...(run.failure?.code ? [`Failure code: ${run.failure.code}`] : []),
```

- [ ] **Step 8: Run focused tests**

```bash
node --experimental-strip-types --test test/issue28-transition-bound.test.ts test/orchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit durable bound handling**

```bash
git add src/orchestrator.ts src/run-rendering.ts test/issue28-transition-bound.test.ts
git commit -m "fix: durably enforce automatic transition bound"
```

---

### Task 4: Add a bootstrap source fingerprint that excludes MASWE state

**Files:**
- Modify: `src/git-snapshot.ts`
- Create: `test/issue28-bootstrap.test.ts`

**Interfaces:**
- Produces: `captureWorkspaceSourceFingerprint(cwd, timeoutMs?)`.
- Preserves: current `gitWorkspaceFingerprint()` behavior, including authoritative `.maswe` hashing.

- [ ] **Step 1: Add fingerprint-plane regressions**

Add tests for Git and non-Git directories:

```ts
const sourceBefore = await captureWorkspaceSourceFingerprint(cwd);
const authoritativeBefore = await gitWorkspaceFingerprint(cwd);
await writeFile(runJsonPath, "{\"changed\":true}\n", "utf8");
assert.equal(await captureWorkspaceSourceFingerprint(cwd), sourceBefore);
assert.notEqual(await gitWorkspaceFingerprint(cwd), authoritativeBefore);
```

Then change a source file outside `.maswe` and assert the source fingerprint changes. Include staged, unstaged, and non-ignored untracked Git cases.

- [ ] **Step 2: Run the bootstrap fingerprint tests and verify the red state**

```bash
node --experimental-strip-types --test test/issue28-bootstrap.test.ts
```

Expected: FAIL because the source-only fingerprint does not exist.

- [ ] **Step 3: Factor the existing Git source plane without changing its update order**

Add a private helper that executes the current three Git probes and sorted untracked-file hashing with the existing `.maswe` pathspec exclusions. `gitWorkspaceFingerprint()` calls that helper, then calls `hashMasweAuthoritativeState()` exactly as before.

- [ ] **Step 4: Implement the source-only public helper**

Add:

```ts
export async function captureWorkspaceSourceFingerprint(
  cwd: string,
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<string>;
```

Use domain separator `maswe:workspace-source-fingerprint:v1\0`.

- Git repositories: hash the fact that the directory is Git, then call the factored Git source-plane helper.
- Non-Git directories: recursively enumerate outside `.maswe`, normalize separators to `/`, sort paths, and hash path plus observed type and content. Hash symlink target text without following it; hash `unreadable` when an observed item cannot be read.
- Do not alter canonical framing/race semantics beyond the current code; Issue #13 owns that redesign.

- [ ] **Step 5: Run source and authoritative fingerprint suites**

```bash
node --experimental-strip-types --test test/issue28-bootstrap.test.ts test/git-snapshot.test.ts test/readonly-authoritative-state.test.ts
```

If either existing test filename is absent, run `npm run test` and record the exact existing fingerprint tests that cover the same behavior before committing.

Expected: PASS with existing authoritative mutation detection unchanged.

- [ ] **Step 6: Commit the fingerprint separation**

```bash
git add src/git-snapshot.ts test/issue28-bootstrap.test.ts
git commit -m "feat: separate bootstrap source fingerprint"
```

---

### Task 5: Persist bootstrap intent for every production-created run

**Files:**
- Create: `src/workspace-bootstrap.ts`
- Modify: `src/store.ts`
- Modify: `src/orchestrator.ts`
- Modify: `test/issue28-bootstrap.test.ts`
- Modify: `test/orchestrator.test.ts`

**Interfaces:**
- Produces: `CreateRunOptions`, `captureWorkspaceBootstrapIntent()`, and `Orchestrator.createPlannedRun()`.
- Consumes: `captureWorkspaceSourceFingerprint()`, `captureWorkspace()`, `ensureMasweGitExclude()`.

- [ ] **Step 1: Add intent-before-side-effect tests for `start()` and `supersede()`**

Extend `OrchestratorOptions` with:

```ts
beforeBootstrapReconcile?: (run: RunRecord) => Promise<void>;
```

In each test, make the hook throw, reload all records, and assert the newly created run is `CREATED`, has complete `workspaceBootstrap`, and has no deterministic `maswe/<run-id>` branch or worktree. For the replacement case, also assert `supersedes` is already present in the initial replacement record.

- [ ] **Step 2: Run bootstrap creation tests and verify the red state**

```bash
node --experimental-strip-types --test test/issue28-bootstrap.test.ts test/orchestrator.test.ts
```

Expected: FAIL because production creation writes no intent.

- [ ] **Step 3: Extend the store creation contract**

Add:

```ts
export interface CreateRunOptions {
  workspaceBootstrap?: WorkspaceBootstrapIntent;
  supersedes?: string;
}
```

Update `RunStore.create()` and `FileRunStore.create()` to accept `options: CreateRunOptions = {}` and include supplied fields in the initial record before the first durable write.

- [ ] **Step 4: Capture bootstrap intent**

In `src/workspace-bootstrap.ts` export:

```ts
export async function captureWorkspaceBootstrapIntent(
  repositoryPath: string,
  config: MasweConfig,
  plannedAt = new Date().toISOString(),
): Promise<WorkspaceBootstrapIntent>;
```

The function calls `ensureMasweGitExclude()`, captures source base/branch/remote, computes `captureWorkspaceSourceFingerprint()`, and selects mode from `config.policy.useIsolatedWorktree`.

- [ ] **Step 5: Add one production creation helper**

In `src/orchestrator.ts`:

```ts
private async createPlannedRun(
  title: string,
  request: string,
  config: MasweConfig,
  options: { supersedes?: string } = {},
): Promise<RunRecord> {
  const workspaceBootstrap = await captureWorkspaceBootstrapIntent(this.cwd, config);
  return this.store.create(title, request, config, {
    workspaceBootstrap,
    ...(options.supersedes ? { supersedes: options.supersedes } : {}),
  });
}
```

`start()` resolves models once and calls this helper. Replacement creation in `supersede()` passes the persisted config and `supersedes: existing.id`; it does not rediscover or substitute models.

Keep existing workspace establishment temporarily after the new hook so this task can pass independently. Task 6 replaces that flow with `advance(CREATED)`.

- [ ] **Step 6: Run creation and persistence tests**

```bash
node --experimental-strip-types --test test/issue28-bootstrap.test.ts test/orchestrator.test.ts test/schema.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit planned run creation**

```bash
git add src/workspace-bootstrap.ts src/store.ts src/orchestrator.ts test/issue28-bootstrap.test.ts test/orchestrator.test.ts
git commit -m "feat: persist workspace bootstrap intent"
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
- Produces: `WorkspaceBootstrapHooks`, `listGitWorktreeRegistrations()`, `reconcileBootstrapWorkspace()`, `assertBootstrapWorkspaceReady()`.
- Consumes: persisted `workspaceBootstrap`, deterministic branch/path derivation, source fingerprint, and `RunStore.save()`.

- [ ] **Step 1: Add deterministic failure-barrier tests**

Define:

```ts
export interface WorkspaceBootstrapHooks {
  beforeBranchCreate?: (run: RunRecord) => Promise<void>;
  afterBranchCreate?: (run: RunRecord) => Promise<void>;
  afterWorktreeCreate?: (run: RunRecord) => Promise<void>;
}
```

Extend `OrchestratorOptions` with:

```ts
bootstrapHooks?: WorkspaceBootstrapHooks;
afterWorkspaceCheckpoint?: (run: RunRecord) => Promise<void>;
```

Add table-driven failures before branch creation, after branch creation, after worktree creation, and after workspace checkpoint/before `START`. Reload after each failure, then retry with hooks disabled.

For the checkpoint boundary assert the authoritative failed record retains workspace and intent, has `failure.resumeState === "CREATED"`, and has no `START` event.

- [ ] **Step 2: Add dirty-worktree and identity-conflict tests**

Cover:

- exact registration/path/branch/HEAD but staged changes;
- exact identity but unstaged changes;
- exact identity but non-ignored untracked changes;
- branch exists at another SHA;
- branch checked out at another path;
- deterministic path occupied by an ordinary directory;
- stale/prunable registration;
- wrong branch or wrong HEAD;
- operator-checkout source drift;
- isolated run without worktree passed to `workingDirectoryFor()`.

Dirty recovery must remain failed, must not call the runtime, and must not reset, clean, or commit the changes.

- [ ] **Step 3: Add checkpoint and `START` outcome-unknown tests**

For checkpoint save outcome unknown, reload and accept only exact `CREATED + workspace + intent` or the prior `CREATED + intent` record.

For `START` outcome unknown, reload and accept only:

- `BRAINSTORMING` with exactly one new `START` event and no bootstrap intent; or
- the actionable `CREATED + workspace + intent` checkpoint.

Reject any other shape.

- [ ] **Step 4: Run bootstrap tests and verify the red state**

```bash
node --experimental-strip-types --test test/issue28-bootstrap.test.ts test/failed-run-provenance.test.ts
```

Expected: FAIL because exact reconciliation and checkpointing do not exist.

- [ ] **Step 5: Add structured worktree inspection**

In `src/git-workspace.ts`:

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

Parse blank-line-separated `git worktree list --porcelain` records. Normalize paths with `path.resolve()`, convert `refs/heads/name` to `name`, and reject malformed duplicate fields, missing worktree/head values, and conflicting records.

- [ ] **Step 6: Implement exact workspace reconciliation**

Export:

```ts
export async function reconcileBootstrapWorkspace(
  repositoryPath: string,
  run: RunRecord,
  hooks: WorkspaceBootstrapHooks = {},
): Promise<RunWorkspace>;
```

Operator-checkout mode requires exact source base SHA, branch, and source-tree fingerprint, then returns `captureWorkspace(repositoryPath)`.

Isolated mode:

1. derives `maswe/${run.id}` and `externalWorktreePath(repositoryPath, run.id)`;
2. inspects exact branch ref and registrations;
3. creates an absent branch at `sourceBaseSha` only;
4. adds a worktree only when path and registration are both absent;
5. rejects prunable/stale or conflicting registrations;
6. requires exact path, branch, and HEAD;
7. requires `isGitWorkspaceClean(worktreePath) === true`;
8. returns fresh HEAD and authoritative fingerprint.

Do not invoke reset, clean, prune, remove, checkout, rebase, or force operations.

- [ ] **Step 7: Implement the three-phase `CREATED` protocol**

Add:

```ts
private async bootstrapCreatedRun(runId: string): Promise<RunRecord>
```

Protocol:

1. load authoritative `CREATED`;
2. reconcile workspace when absent;
3. save cloned `CREATED + workspace + intent` with no event;
4. reload and invoke `afterWorkspaceCheckpoint`;
5. revalidate source or exact managed identity and cleanliness;
6. clone, remove intent, and publish `START`;
7. on any error, reload and classify checkpoint/`START` publication before calling `failRun()`.

If an exact new `START` event was already published, return the authoritative started record instead of failing it. If the checkpoint remains authoritative, `failRun()` records `resumeState: CREATED` and preserves workspace plus intent.

`advance()` handles `CREATED` through this method. `start()` and replacement `supersede()` call `runUntilBlocked()` rather than creating workspaces directly.

- [ ] **Step 8: Make isolated working-directory selection fail closed**

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

- [ ] **Step 9: Run bootstrap, provenance, and orchestrator tests**

```bash
node --experimental-strip-types --test test/issue28-bootstrap.test.ts test/failed-run-provenance.test.ts test/orchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit exact bootstrap recovery**

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
- Consumes: `CreateRunOptions`, `failure.resumeState`, `previousFailure`, bootstrap reconciliation, and exact managed-worktree cleanliness.

- [ ] **Step 1: Add a pre-publication failure test with a strip-only-compatible store wrapper**

```ts
class RejectRetryEventStore implements RunStore {
  private readonly delegate: RunStore;

  constructor(delegate: RunStore) {
    this.delegate = delegate;
  }

  create(
    title: string,
    request: string,
    config: MasweConfig,
    options: CreateRunOptions = {},
  ): Promise<RunRecord> {
    return this.delegate.create(title, request, config, options);
  }

  save(run: RunRecord): Promise<void> {
    return this.delegate.save(run);
  }

  load(runId: string): Promise<RunRecord> {
    return this.delegate.load(runId);
  }

  list(): Promise<RunRecord[]> {
    return this.delegate.list();
  }

  writeArtifact(
    run: RunRecord,
    name: string,
    content: string,
  ): Promise<ArtifactReference> {
    return this.delegate.writeArtifact(run, name, content);
  }

  readArtifact(run: RunRecord, name: string): Promise<string | undefined> {
    return this.delegate.readArtifact(run, name);
  }

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

After rejection, reload through the real `FileRunStore` and assert original state, failure metadata, and `resumeState` remain.

- [ ] **Step 2: Add version-conflict and outcome-unknown tests**

Extend `OrchestratorOptions` with:

```ts
beforeRetryPublication?: (candidate: RunRecord) => Promise<void>;
```

Use it to publish a concurrent authoritative mutation after the retry candidate is prepared. Assert the canonical `FAILED` record remains actionable.

For outcome unknown, use a `FileRunStore` whose directory sync throws once after rename. Distinguish the current retry publication using the pre-publication event-ID set; do not accept an older historical retry event.

- [ ] **Step 3: Run retry tests and verify the red state**

```bash
node --experimental-strip-types --test test/issue28-retry-publication.test.ts test/orchestrator.test.ts test/failed-run-provenance.test.ts
```

Expected: FAIL because current retry deletes failure and may save while state remains durably `FAILED`.

- [ ] **Step 4: Implement retry workspace reconciliation on a clone**

Export:

```ts
export async function reconcileRetryWorkspace(
  repositoryPath: string,
  run: RunRecord,
): Promise<RunWorkspace | undefined>;
```

Behavior:

- `resumeState === "CREATED"`: require retained intent and use bootstrap reconciliation.
- later isolated state: require persisted branch/head, exact deterministic path/registration, and clean status; recreate only an absent exact worktree from preserved branch/head.
- Git operator-checkout state: require exact branch/HEAD and a clean source plane outside `.maswe`.
- non-Git later operator-checkout state without a retained provable source identity: fail closed and require supersession rather than guessing.
- every conflict leaves authoritative state untouched.

- [ ] **Step 5: Replace retry publication with one candidate event**

Implementation sequence:

```ts
const failed = await this.store.load(runId);
const resumeState = failed.failure?.resumeState;
if (failed.state !== "FAILED" || !resumeState) {
  throw new Error("retry requires a FAILED run with failure.resumeState");
}
const previousFailure = structuredClone(failed.failure);
const beforeEventIds = new Set(failed.events.map((event) => event.id));
const candidate = structuredClone(failed);
const workspace = await reconcileRetryWorkspace(this.cwd, candidate);
if (workspace) candidate.workspace = workspace;
delete candidate.failure;
await this.options.beforeRetryPublication?.(structuredClone(candidate));
```

Publish `RETRY_FROM_FAILED` once. On error, reload:

- one new retry event not in `beforeEventIds`, resumed state, restored workspace, and no active failure: adopt and continue;
- no new retry event plus original retryable `FAILED`: rethrow storage error;
- any other shape: throw an inconsistent-authoritative-record error.

No standalone save occurs while state is `FAILED`.

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
- Create: `test/issue28-revalidation.test.ts`
- Modify: `test/evidence-freshness.test.ts`

**Interfaces:**
- Produces: `RevalidationTargetInput`, `RevalidationService.route()`, `RevalidationFence`, `captureRevalidationFence()`, `assertRevalidationFence()`.
- Consumes: `RunStore`, `invalidateStaleEvidence()`, centralized request/retarget transitions.

- [ ] **Step 1: Add initial request and return-gate tests**

Seed exact `PR_READY` and `PR_REVIEW` records with evidence bound to head A. Route target B and assert state `CI_RUNNING`, correct return gate, origin A, target B, generation `1`, invalidated evidence, and final event `REVALIDATE_REQUESTED`.

- [ ] **Step 2: Add B-to-C retarget tests for every active state and failed recovery**

For `CI_RUNNING`, `BUILDING`, and `VERIFYING`, seed generation `1` targeting B, route C, and assert state `CI_RUNNING`, generation `2`, and event `REVALIDATION_RETARGETED`.

For `FAILED`, seed `failure.resumeState: "VERIFYING"` plus active context targeting B. Route C and assert state remains `FAILED`, operational resume state becomes `CI_RUNNING`, generation becomes `2`, and event details retain `previousResumeState: "VERIFYING"`.

Add same-target idempotency: version and event count do not change unless an supplied observed workspace must be saved for alignment.

- [ ] **Step 3: Add generation-fence tests**

Capture a B fence, retarget to C, and require the B fence to fail. Capture a fresh C fence and require it to pass.

- [ ] **Step 4: Run revalidation tests and verify the red state**

```bash
node --experimental-strip-types --test test/issue28-revalidation.test.ts test/evidence-freshness.test.ts
```

Expected: FAIL because the service and generation contract do not exist.

- [ ] **Step 5: Implement `RevalidationService` without parameter properties**

```ts
export interface RevalidationTargetInput {
  source: RevalidationSource;
  previousHeadSha: string;
  requestedHeadSha: string;
  actor: string;
  observedWorkspace?: RunWorkspace;
  at?: string;
}

export class RevalidationService {
  private readonly store: RunStore;
  private readonly now: () => string;

  constructor(
    store: RunStore,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.store = store;
    this.now = now;
  }

  async route(
    runId: string,
    input: RevalidationTargetInput,
  ): Promise<RunRecord>;
}
```

`route()` performs exactly one action:

- no context plus `PR_READY`/`PR_REVIEW`: clone, optionally adopt observed workspace, invalidate evidence, create generation `1`, publish `REVALIDATE_REQUESTED`;
- active context plus same target: save only a changed observed workspace, otherwise no-op;
- active context plus different target in legal active/failed state: clone, invalidate evidence, increment generation, update source/timestamps, and publish `REVALIDATION_RETARGETED`;
- illegal state/context: fail closed.

For failed retarget, update only the candidate failure’s operational `resumeState` to `CI_RUNNING` and preserve the historical `FAIL` event.

- [ ] **Step 6: Add fencing helpers**

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

Reload and require exact version, generation, and target. A later version is stale even when target text matches.

- [ ] **Step 7: Run service and schema tests**

```bash
node --experimental-strip-types --test test/issue28-revalidation.test.ts test/evidence-freshness.test.ts test/schema.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit the revalidation core**

```bash
git add src/revalidation.ts test/issue28-revalidation.test.ts test/evidence-freshness.test.ts
git commit -m "feat: add revalidation target generations"
```

---

### Task 9: Integrate latest-target revalidation into workflow execution

**Files:**
- Modify: `src/orchestrator.ts`
- Modify: `src/revalidation.ts`
- Modify: `test/issue28-revalidation.test.ts`
- Modify: `test/evidence-freshness.test.ts`
- Modify: `test/orchestrator.test.ts`

**Interfaces:**
- Produces: local gate preflight, active target reconciliation, exact alignment checks, and current-generation return behavior.
- Consumes: `RevalidationService`, `RevalidationFence`, workspace refresh, evidence binding, builder/resolver publication.

- [ ] **Step 1: Add local gate revalidation tests**

From `PR_READY` and `PR_REVIEW`, create a clean local commit B after evidence A. `runUntilBlocked()` must request revalidation, run quality and verification for B, and return to the original gate. The `PR_REVIEW` case keeps `commentResolutionCycles === 0`.

- [ ] **Step 2: Add active alignment and stale-work tests**

Cover:

- associated active target C while workspace remains B: quality and verification do not run; run fails with recoverable `CI_RUNNING` provenance;
- operator moves exact MASWE branch/worktree cleanly to C, retry resumes current generation;
- a builder/verifier B fence becomes stale after retarget C and cannot publish event or evidence;
- same-target repeated preflight publishes no duplicate event.

- [ ] **Step 3: Run workflow tests and verify the red state**

```bash
node --experimental-strip-types --test test/issue28-revalidation.test.ts test/evidence-freshness.test.ts test/orchestrator.test.ts
```

Expected: FAIL because gates stop without routing and active states do not reconcile targets.

- [ ] **Step 4: Add a shared required-target preflight**

Before stopping at `PR_READY` or `PR_REVIEW`:

1. preserve previous workspace head;
2. refresh exact branch/HEAD/fingerprint;
3. determine whether current required evidence exists for observed HEAD;
4. route revalidation with source `local-workspace` when head moved or evidence is stale/missing;
5. continue automatically when routing enters `CI_RUNNING`.

Before advancing active `BUILDING`, `CI_RUNNING`, or `VERIFYING`:

- associated target is `run.github.headSha`;
- local-only target is exact observed workspace HEAD;
- differing active target publishes retarget before work;
- matching target but workspace misalignment throws a bounded exact error rather than evaluating the wrong tree.

- [ ] **Step 5: Select success event from durable return context**

```ts
const successEvent = run.revalidation?.returnState === "PR_READY"
  ? "VERIFY_PASSED"
  : run.revalidation?.returnState === "PR_REVIEW"
    ? "VERIFY_PASSED_AFTER_REVIEW"
    : run.counters.commentResolutionCycles > 0
      ? "VERIFY_PASSED_AFTER_REVIEW"
      : "VERIFY_PASSED";
```

Clear `revalidation` on the same cloned candidate that receives fresh verification evidence and the successful event.

- [ ] **Step 6: Fence commits and evidence publication**

Integration points:

- builder/resolver: after artifact publication, capture/assert fence immediately before deterministic commit and assert again immediately after commit before event publication;
- quality: artifact publication rejects stale run versions; capture/assert fence before CI event/evidence publication;
- verifier: artifact publication rejects stale versions; capture/assert fence before verifier event/evidence publication;
- successful return: assert current fence before clearing context and applying success event.

A retarget during a deterministic Git command may leave an unaccepted commit, but optimistic publication and the post-command fence must prevent stale event/evidence. The next preflight fails closed on head/target mismatch; this issue does not reset the branch.

- [ ] **Step 7: Reconcile latest target before retry continuation**

When a failed run has active revalidation, compare `run.github.headSha` or observed local HEAD with `revalidation.requestedHeadSha` before publishing retry. If different, publish `REVALIDATION_RETARGETED` while state remains `FAILED`, reload, and only then prepare the retry candidate for `CI_RUNNING`.

- [ ] **Step 8: Run focused workflow tests**

```bash
node --experimental-strip-types --test test/issue28-revalidation.test.ts test/evidence-freshness.test.ts test/orchestrator.test.ts test/issue28-retry-publication.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit workflow integration**

```bash
git add src/orchestrator.ts src/revalidation.ts test/issue28-revalidation.test.ts test/evidence-freshness.test.ts test/orchestrator.test.ts test/issue28-retry-publication.test.ts
git commit -m "feat: execute current-head revalidation"
```

---

### Task 10: Split GitHub association publication from non-rollback routing

**Files:**
- Modify: `src/github/adapter.ts`
- Modify: `src/github/association.ts`
- Create: `test/issue28-github-reconciliation.test.ts`
- Modify: `test/github-adapter.integration.test.ts`

**Interfaces:**
- Produces: event-free `saveAssociationSnapshot()`, field-scoped rollback, and `afterAssociationCommitBeforeRouting` seam.
- Consumes: `RevalidationService.route()` only after association commit.

- [ ] **Step 1: Add the event-preservation failure matrix**

Inject:

1. run snapshot save failure;
2. known association-index write failure;
3. association-index outcome unknown after rename;
4. stop after association commit/before routing;
5. request/retarget event publication failure;
6. concurrent event before a known-failure rollback callback.

Reload and assert event IDs/order/details never decrease or change. Field rollback must refuse a record whose non-association invariant changed.

- [ ] **Step 2: Add B-to-C webhook and crash-recovery tests**

Deliver B to a `PR_REVIEW` run with zero comment cycles, then C before work completes. Assert generation `2`, target C, and only C accepted for alignment/evidence.

Inject a stop after association commit before routing. The run retains `github.headSha === C` and invalidated evidence. Repeated delivery or later orchestrator preflight publishes the missing request/retarget exactly once.

- [ ] **Step 3: Run GitHub tests and verify the red state**

```bash
node --experimental-strip-types --test test/issue28-github-reconciliation.test.ts test/github-adapter.integration.test.ts
```

Expected: FAIL because current full-snapshot rollback can remove events and routing is inside rollback scope.

- [ ] **Step 4: Implement exact history and rollback invariants**

```ts
function eventHistoryIdentity(events: RunRecord["events"]): string {
  return JSON.stringify(events.map((event) => ({
    id: event.id,
    at: event.at,
    type: event.type,
    actor: event.actor,
    from: event.from,
    to: event.to,
    details: event.details,
  })));
}

function associationRollbackInvariant(run: RunRecord): string {
  const record = structuredClone(run) as unknown as Record<string, unknown>;
  delete record.version;
  delete record.updatedAt;
  delete record.github;
  delete record.evidence;
  return JSON.stringify(record);
}
```

Before field rollback require exact attempted version, identical event history, and identical rollback invariant. Clone the current record and restore only prior `github` and `evidence`. Refuse every mismatch.

- [ ] **Step 5: Implement two-phase live-head handling**

Under the existing per-PR publication fence:

**Phase A inside `associations.withTransaction()`:**

- load and clone run;
- capture previous head;
- update only `github`, pending cancellation heads, and stale evidence;
- publish no event and do not change revalidation target;
- save event-free snapshot;
- bind association index;
- register only field-scoped rollback.

**Phase B after transaction success:**

- invoke `afterAssociationCommitBeforeRouting` when configured;
- reload run;
- route request, retarget, or no-op with source `github`, previous head, and committed live head;
- publish checks from authoritative routed state;
- never register routing events for association rollback.

Apply to webhook PR/push head changes and manual check publication live-head refresh.

- [ ] **Step 6: Keep outcome-unknown association behavior non-rollback**

In `src/github/association.ts`, retain and test:

- rollback callbacks run only for known non-publication failures;
- callbacks do not run for `DurableAtomicWriteOutcomeUnknownError`;
- callbacks execute in reverse registration order;
- callback errors aggregate with the primary error.

- [ ] **Step 7: Run focused GitHub and durable-ingress tests**

```bash
node --experimental-strip-types --test test/issue28-github-reconciliation.test.ts test/github-adapter.integration.test.ts test/github-durable-ingress.test.ts test/github-authoritative-state.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit append-only GitHub reconciliation**

```bash
git add src/github/adapter.ts src/github/association.ts test/issue28-github-reconciliation.test.ts test/github-adapter.integration.test.ts
git commit -m "fix: preserve events during github head routing"
```

---

### Task 11: Harden merge-ready/completion, rendering, schema examples, and documentation

**Files:**
- Modify: `src/orchestrator.ts`
- Modify: `src/run-rendering.ts`
- Create: `test/issue28-rendering.test.ts`
- Modify: `test/issue28-revalidation.test.ts`
- Modify: `test/evidence-freshness.test.ts`
- Modify: `test/schema.test.ts`
- Modify: `docs/PRD.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/ARTIFACT_CONTRACTS.md`
- Modify: `docs/GITHUB_APP.md`
- Modify: `docs/OPERATIONS.md`

**Interfaces:**
- Produces: one exact current-head gate assertion used by merge-ready and completion.
- Produces: operator-visible bootstrap/revalidation diagnostics and synchronized public contracts.
- Consumes: current workspace, GitHub head, revalidation target, and quality/verification/merge-ready evidence.

- [ ] **Step 1: Add merge-ready/completion rejection tests**

For both operations cover:

- active revalidation context;
- workspace differs from requested target;
- associated GitHub head differs from workspace or target;
- quality evidence missing, failed, or stale;
- verification evidence missing, failed, or stale;
- dirty or wrong-branch managed worktree;
- completion merge-ready evidence missing or stale.

Assert no new event, evidence, or state change after rejection.

- [ ] **Step 2: Add rendering tests**

For bootstrap failure require output to contain:

```text
Failure code: workflow-failure
Bootstrap: mode=isolated-worktree, source=<12-char SHA>, workspace=checkpointed
```

For active revalidation require:

```text
Revalidation: source=github, target=<12-char SHA>, generation=2, return=PR_REVIEW
```

For overflow require stable failure code. Do not render secrets or full unbounded diagnostics.

- [ ] **Step 3: Run gate/rendering tests and verify the red state**

```bash
node --experimental-strip-types --test test/issue28-rendering.test.ts test/issue28-revalidation.test.ts test/evidence-freshness.test.ts
```

Expected: FAIL because exact gate and rendering contracts are incomplete.

- [ ] **Step 4: Add one exact gate assertion**

The helper must require:

```text
no active revalidation
known workspace HEAD
exact workspace branch
clean managed worktree when isolated
if associated: workspace.headSha == github.headSha
current passing quality evidence when required
current passing verification evidence when required
for completion: current passing merge-ready evidence
```

Return the exact current head for event details. Historical events never recreate current success after invalidation.

- [ ] **Step 5: Implement bounded rendering**

Render failure code, bootstrap mode/phase, and revalidation source/target/generation/return gate. Use existing diagnostic sanitizers and truncate displayed SHAs to 12 characters while retaining full values in JSON.

- [ ] **Step 6: Synchronize documentation with exact normative text**

Add these requirements, adapted only for document grammar:

```text
Bootstrap source-drift checks exclude the orchestrator-owned .maswe namespace; read-only role fingerprints continue to include authoritative .maswe state.

Every production-created run, including a superseding replacement, persists workspace bootstrap intent before branch or worktree side effects and durably checkpoints the established workspace before START.

A newer authenticated or local head retargets an active or recoverable failed revalidation generation. Evidence from a superseded generation is unusable.

GitHub association publication is event-free and rollback-capable; workflow request and retarget events publish only after association commit and are never rolled back.
```

Update state diagrams for both revalidation events, artifact/run-record examples for the optional metadata, and operations guidance for dirty worktree, alignment, retry, and non-destructive manual recovery.

- [ ] **Step 7: Run contract and documentation tests**

```bash
node --experimental-strip-types --test test/issue28-rendering.test.ts test/schema.test.ts test/issue28-revalidation.test.ts test/evidence-freshness.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit public contract synchronization**

```bash
git add src/orchestrator.ts src/run-rendering.ts test/issue28-rendering.test.ts test/issue28-revalidation.test.ts test/evidence-freshness.test.ts test/schema.test.ts docs/PRD.md docs/ARCHITECTURE.md docs/ARTIFACT_CONTRACTS.md docs/GITHUB_APP.md docs/OPERATIONS.md
git commit -m "docs: synchronize Issue 28 recovery contracts"
```

---

### Task 12: Run exact-baseline validation and prepare review evidence

**Files:**
- Modify only files required to correct failures attributable to Tasks 1–11.
- Do not change package metadata, lock files, workflows, runtime adapters, CLI grammar, or configuration schema.

**Interfaces:**
- Produces: exact-head validation evidence for canonical Node 24 and blocking Node 22 compatibility.
- Consumes: the complete Issue #28 implementation and test matrix.

- [ ] **Step 1: Run focused Issue #28 suites on canonical Node 24.18.0**

Record:

```bash
command -v node
node --version
node -p 'process.execPath'
npm --version
node --experimental-strip-types --test test/issue28-transition-bound.test.ts test/issue28-bootstrap.test.ts test/issue28-retry-publication.test.ts test/issue28-revalidation.test.ts test/issue28-github-reconciliation.test.ts test/issue28-rendering.test.ts
```

Expected Node version: `v24.18.0`. Expected tests: PASS.

- [ ] **Step 2: Run the complete canonical validation**

```bash
npm run check
npm run pack:dry
git diff --check
```

Expected: all commands exit `0`.

- [ ] **Step 3: Audit scope and event-history requirements**

```bash
git status --short
git diff --name-only e80043cb208b5c26671a7aae34283d75ffab9dec...HEAD
git grep -nE 'TODO|TBD|implement later' -- src test schemas docs
```

Disposition every match as pre-existing documentation language or remove it. Confirm no Issue #29/#30 behavior, dependency change, workflow change, runtime-adapter change, or destructive Git operation entered scope.

- [ ] **Step 4: Run exact Node 22.22.2 compatibility validation**

Under exact Node `22.22.2`, record the same runtime evidence and run:

```bash
npm run check
npm run pack:dry
git diff --check
```

Expected: all commands exit `0`.

- [ ] **Step 5: Verify acceptance and external-review traceability**

Review every row below against a passing test or exact code/document evidence:

| Requirement | Blocking evidence |
|---|---|
| Builder/resolver evaluated SHA | editing and no-op provenance tests |
| Durable boundary behavior | exact gate, terminal, and overflow reload tests |
| Source fingerprint excludes `.maswe` | Git/non-Git bootstrap fingerprint tests |
| All production paths persist intent | start and supersede interruption tests |
| Real workspace checkpoint | after-checkpoint/before-`START` reload test |
| Dirty worktree rejected | staged/unstaged/untracked recovery tests |
| Retry metadata survives | pre-publication, conflict, and outcome-unknown tests |
| Gate return context | `PR_READY` and zero-cycle `PR_REVIEW` tests |
| B-to-C retarget | active and failed generation tests |
| Stale generation blocked | fence tests around commit/evidence publication |
| Published events append-only | association failure matrix |
| Merge-ready/completion fail closed | current-head gate tests |
| Schema/docs/rendering synchronized | schema, rendering, and literal contract tests |

- [ ] **Step 6: Commit only validation-driven corrections**

If validation required corrections:

```bash
git add <exact corrected files>
git commit -m "test: complete Issue 28 validation"
```

If no files changed, do not create an empty commit.

- [ ] **Step 7: Request independent exact-head review**

The review request must include:

```text
base SHA: e80043cb208b5c26671a7aae34283d75ffab9dec
head SHA: <full current HEAD>
canonical Node: 24.18.0
compatibility Node: 22.22.2
required commands: npm run check; npm run pack:dry; git diff --check
scope: Issue #28 only
required special review: bootstrap fingerprint planes, dirty-worktree recovery, B-to-C active/failed retarget, and append-only event history
```

Do not mark the PR ready or merge while any exact-head CI, independent review, or actionable-thread gate is incomplete.

---

## Acceptance-Criteria Coverage

| Issue #28 criterion | Plan task |
|---|---|
| Editing builder SHA contract | Task 2 |
| Editing resolver SHA contract | Task 2 |
| No-op coherent evaluated SHA | Task 2 |
| Durable automatic overflow | Task 3 |
| Exact boundary to human gate | Task 3 |
| Exact boundary to terminal state | Task 3 |
| Failure before branch recoverable | Tasks 5–6 |
| Failure after branch recoverable | Task 6 |
| Failure after worktree recoverable | Task 6 |
| Failure after workspace save recoverable | Task 6 |
| Retry reconstructs intended workspace before roles | Tasks 6–7 |
| Retry publication preserves recovery metadata | Task 7 |
| Revalidation returns to `PR_READY` | Tasks 8–9 |
| Revalidation returns to `PR_REVIEW` | Tasks 8–9 |
| External movement before comment cycle returns to review | Tasks 8–10 |
| Stale evidence cannot authorize merge-ready/completion | Task 11 |
| Types/schema/rendering/docs synchronized | Tasks 1 and 11 |
| Required commands on both Node baselines | Task 12 |

## External-Review Finding Coverage

| Finding | Plan task |
|---|---|
| Bootstrap fingerprint self-invalidates on `.maswe` writes | Task 4 |
| Active revalidation cannot coalesce B-to-C | Tasks 8–10 |
| Association rollback can remove published events | Task 10 |
| Supersede replacement lacks intent | Task 5 |
| Missing `CREATED + workspace` checkpoint | Task 6 |
| Dirty registered worktree can be reused | Tasks 6–7 |

## Plan Self-Review Result

- All 18 Issue #28 acceptance criteria map to implementation and deterministic evidence.
- All six external-review findings map to blocking tests.
- Every type and helper referenced by a later task is defined by an earlier task.
- Test-only options are constructor data, not persisted configuration.
- Code examples avoid enums, parameter properties, and transform-dependent syntax.
- No task authorizes destructive Git recovery, event-history rollback, Issue #29 work, or Issue #30 work.
- The plan contains no unresolved placeholders or open design decisions.
