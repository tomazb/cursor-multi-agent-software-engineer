# Issue #28 Workflow Provenance, Recovery, and Revalidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair Issue #28 so MASWE publishes exact evaluated SHA provenance, recovers every partial `CREATED` bootstrap, durably handles automatic-transition overflow and retry publication, and revalidates stale evidence against the latest local or GitHub head without rolling back workflow history.

**Architecture:** Keep schema version `1`, the optimistic file store, and `src/state-machine.ts` as the sole transition map. Add `src/workspace-bootstrap.ts` for bootstrap intent and exact workspace reconciliation, and `src/revalidation.ts` for request/retarget metadata and generation fencing. GitHub head handling becomes a two-phase protocol: event-free association publication with narrowly fenced rollback, followed by non-rollback workflow routing.

**Tech Stack:** TypeScript ESM, Node.js built-in test runner, Node `--experimental-strip-types`, Git CLI worktrees, JSON Schema Draft 2020-12, file-backed optimistic persistence.

**Spec:** `docs/superpowers/specs/2026-08-18-issue-28-workflow-recovery-design.md` at approved commit `d85451f984a80ec6681dfcd7226a31099b1479fe`.

## Global Constraints

- Begin implementation from branch `issue-28-workflow-recovery` at the commit containing this final plan; the approved design baseline remains `main@e80043cb208b5c26671a7aae34283d75ffab9dec`.
- Keep `schemaVersion: 1`; new run-record fields remain optional and exact-schema validated.
- Keep every state mapping in `src/state-machine.ts`; helpers and adapters request events but never assign workflow state directly.
- Preserve historical event IDs, order, details, SHAs, and count. Reconciliation never writes fewer or altered events.
- Do not automatically fetch, reset, rebase, merge, force-update, prune worktrees, delete paths, create PRs, or merge.
- Bootstrap source drift excludes `.maswe`; normal read-only enforcement continues to include authoritative `.maswe` state.
- Reload the authoritative run record after every injected recovery failure before asserting behavior.
- Persist bootstrap intent before branch/worktree side effects for `start()` and `supersede()` replacement creation.
- Reject correctly registered but dirty managed worktrees.
- Keep Issue #29 policy/input hardening and Issue #30 terminal cleanup recovery outside this branch.
- Validate exact Node `24.18.0` canonically and exact Node `22.22.2` as the blocking compatibility floor.
- Use strip-only-compatible TypeScript: no enums, parameter properties, decorators, or transform-dependent constructs.
- Do not modify dependencies, package metadata, lock files, workflows, runtime adapters, CLI grammar, or configuration schema.

---

## File Responsibility Map

### Create

- `src/workspace-bootstrap.ts` — capture bootstrap intent, classify exact Git/worktree state, enforce cleanliness, and restore retry workspaces without publishing events.
- `src/revalidation.ts` — publish initial request/active retarget events, reconcile current targets, and enforce generation fences through `RunStore`.
- `test/issue28-transition-bound.test.ts`
- `test/issue28-bootstrap.test.ts`
- `test/issue28-retry-publication.test.ts`
- `test/issue28-revalidation.test.ts`
- `test/issue28-github-reconciliation.test.ts`
- `test/issue28-rendering.test.ts`

### Modify

- `src/domain.ts`
- `src/state-machine.ts`
- `src/git-snapshot.ts`
- `src/git-workspace.ts`
- `src/store.ts`
- `src/run-record-validation.ts`
- `src/orchestrator.ts`
- `src/run-rendering.ts`
- `src/github/adapter.ts`
- `src/github/association.ts`
- `schemas/run-record.schema.json`
- `test/state-machine.test.ts`
- `test/schema.test.ts`
- `test/commit-provenance.test.ts`
- `test/orchestrator.test.ts`
- `test/failed-run-provenance.test.ts`
- `test/evidence-freshness.test.ts`
- `test/github-adapter.integration.test.ts`
- `test/github-authoritative-state.test.ts`
- `docs/PRD.md`
- `docs/ARCHITECTURE.md`
- `docs/ARTIFACT_CONTRACTS.md`
- `docs/GITHUB_APP.md`
- `docs/OPERATIONS.md`

---

### Task 1: Add exact domain, state-machine, migration, and schema contracts

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
- Produces events: `REVALIDATE_REQUESTED`, `REVALIDATION_RETARGETED`.
- Produces failure code: `automatic-transition-limit-exceeded`.

- [ ] **Step 1: Write failing state-machine tests**

Add:

```ts
test("revalidation transitions are centralized", () => {
  assert.equal(transition("PR_READY", "REVALIDATE_REQUESTED", {}), "CI_RUNNING");
  assert.equal(transition("PR_REVIEW", "REVALIDATE_REQUESTED", {}), "CI_RUNNING");
  for (const state of ["CI_RUNNING", "BUILDING", "VERIFYING"] as const) {
    assert.equal(transition(state, "REVALIDATION_RETARGETED", {}), "CI_RUNNING");
  }
});

test("failed retarget requires active revalidation and a legal resume state", () => {
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
});

test("CREATED is retry-resumable", () => {
  assert.equal(
    transition("FAILED", "RETRY_FROM_FAILED", { retryResumeState: "CREATED" }),
    "CREATED",
  );
});
```

Update existing retry tests to use `{ retryResumeState: "BUILDING" }`.

- [ ] **Step 2: Run the state-machine red test**

```bash
node --experimental-strip-types --test test/state-machine.test.ts
```

Expected: FAIL on unknown events/context.

- [ ] **Step 3: Write failing schema/migration tests**

Create an otherwise valid run with:

```ts
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
```

Assert JSON Schema and `migrateRunRecord()` accept it. Add rejection cases for generation `0`, missing required metadata fields, and unknown metadata keys.

- [ ] **Step 4: Run the schema red test**

```bash
node --experimental-strip-types --test test/schema.test.ts
```

Expected: FAIL on unsupported fields/enums.

- [ ] **Step 5: Add exact domain types**

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

Add optional `workspaceBootstrap` and `revalidation` to `RunRecord`; extend event/failure unions.

- [ ] **Step 6: Implement context-aware transition validation**

```ts
export interface TransitionContext {
  retryResumeState?: WorkflowState;
  failureResumeState?: WorkflowState;
  hasRevalidation?: boolean;
}
```

Rules:

- `RETRY_FROM_FAILED` accepts every existing resumable state plus `CREATED`.
- `REVALIDATION_RETARGETED` maps active `BUILDING`, `CI_RUNNING`, and `VERIFYING` to `CI_RUNNING`.
- `FAILED -> FAILED` retarget requires active revalidation and failure resume state in `BUILDING | CI_RUNNING | VERIFYING`.
- `allowedEvents()` exposes failed retarget only with those same context facts.

- [ ] **Step 7: Forward context from `RunStore.applyEvent()`**

```ts
const to = transition(from, type, {
  retryResumeState: safeDetails?.resumeState as WorkflowState | undefined,
  failureResumeState: run.failure?.resumeState,
  hasRevalidation: run.revalidation !== undefined,
});
```

Add exact TypeScript validators, store allowlists, and JSON Schema objects with `additionalProperties: false`.

- [ ] **Step 8: Verify and commit**

```bash
node --experimental-strip-types --test test/state-machine.test.ts test/schema.test.ts
npm run typecheck
git add src/domain.ts src/state-machine.ts src/store.ts src/run-record-validation.ts schemas/run-record.schema.json test/state-machine.test.ts test/schema.test.ts
git commit -m "feat: add Issue 28 recovery contracts"
```

---

### Task 2: Correct builder and resolver evaluated-SHA provenance

**Files:**
- Modify: `src/orchestrator.ts`
- Modify: `test/commit-provenance.test.ts`

**Interfaces:**
- Produces corrected `BUILD_COMPLETED.details` and `RESOLUTION_COMPLETED.details`.

- [ ] **Step 1: Add editing/no-op builder and resolver regressions**

Extend the runtime fixture so resolver mode writes `src/review-fix.ts` and returns:

```ts
return {
  status: "finished",
  output: "# resolution\n\nRESOLUTION_COMPLETE\n",
  requestedModel: request.roleConfig.model,
  actualModel: request.roleConfig.model,
};
```

For editing cases assert:

```ts
assert.equal(event.details?.headSha, event.details?.outputHeadSha);
assert.equal(event.details?.headSha, run.workspace?.headSha);
assert.notEqual(event.details?.inputHeadSha, event.details?.headSha);
```

For no-op cases assert all three SHA fields equal the workspace head.

- [ ] **Step 2: Run the red test**

```bash
node --experimental-strip-types --test test/commit-provenance.test.ts
```

Expected: FAIL because public `headSha` still records input.

- [ ] **Step 3: Publish evaluated SHA**

```ts
const evaluatedHeadSha = outputHeadSha ?? beforeSha ?? run.workspace?.headSha;
```

Use:

```ts
{
  ...runtimeEventIdentityDetails(result),
  marker: markers.marker,
  ...(beforeSha ? { inputHeadSha: beforeSha } : {}),
  ...(evaluatedHeadSha
    ? { headSha: evaluatedHeadSha, outputHeadSha: evaluatedHeadSha }
    : {}),
}
```

Apply identically to builder and resolver; do not rewrite historical events.

- [ ] **Step 4: Verify and commit**

```bash
node --experimental-strip-types --test test/commit-provenance.test.ts test/evidence-freshness.test.ts
git add src/orchestrator.ts test/commit-provenance.test.ts
git commit -m "fix: bind editing events to evaluated head"
```

---

### Task 3: Make automatic-transition overflow and failure publication durable

**Files:**
- Modify: `src/orchestrator.ts`
- Modify: `src/run-rendering.ts`
- Create: `test/issue28-transition-bound.test.ts`

**Interfaces:**
- Produces `OrchestratorOptions.automaticTransitionLimit` as a test-only seam.
- Produces clone-staged `failRun()` publication.

- [ ] **Step 1: Add exact-boundary tests**

Cover bound `1`:

1. `BRAINSTORMING` with approval required reaches `WAITING_FOR_BRAINSTORM_APPROVAL` without overflow.
2. `BUILDING` already at cycle ceiling reaches terminal `FAILED` without a second overflow.
3. `BRAINSTORMING` with approval disabled ends one advance in automatic `DESIGNING`; overflow publishes `FAILED`, code `automatic-transition-limit-exceeded`, resume state `DESIGNING`.

Reload every result from `FileRunStore`.

- [ ] **Step 2: Add failure outcome-unknown coverage**

Make directory sync fail once after the `FAIL` rename. Accept only complete `FAILED + failure + one new FAIL event` or the unchanged prior automatic record. Reject partial metadata/event shapes.

- [ ] **Step 3: Run the red test**

```bash
node --experimental-strip-types --test test/issue28-transition-bound.test.ts
```

- [ ] **Step 4: Add constructor options without parameter properties**

```ts
export interface OrchestratorOptions {
  automaticTransitionLimit?: number;
}
```

Store options in an explicit class field assigned in the constructor body. Require a positive safe integer; default `20`.

- [ ] **Step 5: Check resulting state before overflow**

```ts
run = await this.advance(run.id);
iterations += 1;
if (isTerminal(run.state) || isHumanGate(run.state)) return run;
if (iterations >= limit) {
  return this.failRun(
    run,
    `Workflow exceeded ${limit} automatic transitions.`,
    "automatic-transition-limit-exceeded",
  );
}
```

- [ ] **Step 6: Publish failure from one clone**

Clone the run, assign bounded failure metadata, and call `applyEvent(candidate, "FAIL", ...)` once. On error, reload and identify the current publication using the pre-publication event-ID set. Adopt only a complete new failure event/state/metadata; rethrow on unchanged prior state; reject every other shape.

- [ ] **Step 7: Render failure code, verify, and commit**

```ts
...(run.failure?.code ? [`Failure code: ${run.failure.code}`] : []),
```

```bash
node --experimental-strip-types --test test/issue28-transition-bound.test.ts test/orchestrator.test.ts
git add src/orchestrator.ts src/run-rendering.ts test/issue28-transition-bound.test.ts
git commit -m "fix: durably enforce automatic transition bound"
```

---

### Task 4: Separate bootstrap source fingerprint from authoritative read-only fingerprint

**Files:**
- Modify: `src/git-snapshot.ts`
- Create: `test/issue28-bootstrap.test.ts`

**Interfaces:**
- Produces `captureWorkspaceSourceFingerprint(cwd, timeoutMs?)`.
- Preserves current `gitWorkspaceFingerprint()` semantics.

- [ ] **Step 1: Add Git/non-Git fingerprint-plane tests**

For both modes:

- compute source and authoritative fingerprints;
- change `.maswe/runs/run-1/run.json`;
- assert source fingerprint unchanged and authoritative fingerprint changed;
- change a source file outside `.maswe` and assert source fingerprint changed.

For Git also cover staged, unstaged, and non-ignored untracked source changes.

- [ ] **Step 2: Run the red test**

```bash
node --experimental-strip-types --test test/issue28-bootstrap.test.ts
```

- [ ] **Step 3: Implement source fingerprint**

Export:

```ts
export async function captureWorkspaceSourceFingerprint(
  cwd: string,
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<string>;
```

Use domain separator `maswe:workspace-source-fingerprint:v1\0`.

- Git: factor the existing status/diff/cached-diff/sorted-untracked plane without changing update order; retain `.maswe` pathspec exclusions.
- Non-Git: sorted recursive paths outside `.maswe`; hash normalized path, observed type, file bytes, or symlink target text; hash `unreadable` on read failure.
- Keep `gitWorkspaceFingerprint()` calling the source-plane helper plus `hashMasweAuthoritativeState()` exactly as before.

- [ ] **Step 4: Verify exact existing fingerprint suites and commit**

```bash
node --experimental-strip-types --test test/issue28-bootstrap.test.ts test/nongit-fingerprint.test.ts test/readonly-fingerprint.test.ts test/git-plane-maswe-exclude.test.ts
git add src/git-snapshot.ts test/issue28-bootstrap.test.ts
git commit -m "feat: separate bootstrap source fingerprint"
```

---

### Task 5: Persist bootstrap intent before every production workspace side effect

**Files:**
- Create: `src/workspace-bootstrap.ts`
- Modify: `src/store.ts`
- Modify: `src/orchestrator.ts`
- Modify: `test/issue28-bootstrap.test.ts`
- Modify: `test/orchestrator.test.ts`

**Interfaces:**
- Produces `CreateRunOptions`, `captureWorkspaceBootstrapIntent()`, and `createPlannedRun()`.

- [ ] **Step 1: Add `start()` and `supersede()` interruption tests**

Extend `OrchestratorOptions`:

```ts
beforeBootstrapReconcile?: (run: RunRecord) => Promise<void>;
```

Make the hook throw. Reload and require a `CREATED` run with complete intent, no workspace, no deterministic branch/worktree, and `supersedes` already set for replacement creation.

- [ ] **Step 2: Run the red tests**

```bash
node --experimental-strip-types --test test/issue28-bootstrap.test.ts test/orchestrator.test.ts
```

- [ ] **Step 3: Extend store creation**

```ts
export interface CreateRunOptions {
  workspaceBootstrap?: WorkspaceBootstrapIntent;
  supersedes?: string;
}
```

Update `RunStore.create()` and `FileRunStore.create()` to accept `options: CreateRunOptions = {}` and place those fields in the initial record before its first write.

- [ ] **Step 4: Capture intent**

```ts
export async function captureWorkspaceBootstrapIntent(
  repositoryPath: string,
  config: MasweConfig,
  plannedAt = new Date().toISOString(),
): Promise<WorkspaceBootstrapIntent>;
```

Call `ensureMasweGitExclude()`, capture source base/branch/remote, compute source fingerprint, and set mode from `useIsolatedWorktree`.

- [ ] **Step 5: Add one production creation path**

```ts
private async createPlannedRun(
  title: string,
  request: string,
  config: MasweConfig,
  options: { supersedes?: string } = {},
): Promise<RunRecord>
```

`start()` resolves model IDs once and uses this helper. `supersede()` uses the persisted run config and includes `supersedes` in the initial replacement record. Keep current workspace establishment temporarily after the new hook; Task 6 replaces it.

- [ ] **Step 6: Verify and commit**

```bash
node --experimental-strip-types --test test/issue28-bootstrap.test.ts test/orchestrator.test.ts test/schema.test.ts
git add src/workspace-bootstrap.ts src/store.ts src/orchestrator.ts test/issue28-bootstrap.test.ts test/orchestrator.test.ts
git commit -m "feat: persist workspace bootstrap intent"
```

---

### Task 6: Implement exact bootstrap reconciliation and a real workspace checkpoint

**Files:**
- Modify: `src/workspace-bootstrap.ts`
- Modify: `src/git-workspace.ts`
- Modify: `src/orchestrator.ts`
- Modify: `test/issue28-bootstrap.test.ts`
- Modify: `test/failed-run-provenance.test.ts`

**Interfaces:**
- Produces `WorkspaceBootstrapHooks`, `GitWorktreeRegistration`, `listGitWorktreeRegistrations()`, `reconcileBootstrapWorkspace()`, `assertBootstrapWorkspaceReady()`.

- [ ] **Step 1: Add four failure barriers and publication ambiguity tests**

```ts
export interface WorkspaceBootstrapHooks {
  beforeBranchCreate?: (run: RunRecord) => Promise<void>;
  afterBranchCreate?: (run: RunRecord) => Promise<void>;
  afterWorktreeCreate?: (run: RunRecord) => Promise<void>;
}
```

Extend orchestrator options with `bootstrapHooks` and `afterWorkspaceCheckpoint`.

Test failures before branch, after branch, after worktree, and after checkpoint/before `START`. Add checkpoint-save and `START` outcome-unknown cases. Reload and accept only the exact prior actionable shape or exact complete next shape.

- [ ] **Step 2: Add dirty/conflicting worktree tests**

Cover staged, unstaged, and non-ignored untracked dirty states plus wrong branch, wrong HEAD, alternate registration path, occupied deterministic path, stale/prunable registration, source drift, and isolated missing-worktree fallback.

- [ ] **Step 3: Run the red tests**

```bash
node --experimental-strip-types --test test/issue28-bootstrap.test.ts test/failed-run-provenance.test.ts
```

- [ ] **Step 4: Add structured worktree inspection**

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

Parse `git worktree list --porcelain`, normalize paths/branch refs, and reject malformed or conflicting records.

- [ ] **Step 5: Implement exact reconciliation**

```ts
export async function reconcileBootstrapWorkspace(
  repositoryPath: string,
  run: RunRecord,
  hooks: WorkspaceBootstrapHooks = {},
): Promise<RunWorkspace>;
```

Operator-checkout mode requires exact source base, branch, and source fingerprint.

Isolated mode derives `maswe/${run.id}` and deterministic path, creates only absent exact resources, rejects conflicts/prunable records, requires exact branch/HEAD/path, and requires clean status. Never reset, clean, prune, remove, checkout, rebase, or force.

- [ ] **Step 6: Implement three-phase `CREATED` processing**

`bootstrapCreatedRun(runId)`:

1. load `CREATED`;
2. reconcile workspace if absent;
3. save cloned `CREATED + workspace + intent` with no event;
4. reload and run checkpoint hook;
5. revalidate identity/cleanliness;
6. clone, delete intent, publish `START`;
7. on error, reload and classify whether checkpoint or `START` published before calling `failRun()`.

If `START` already published, adopt the started record. If checkpoint remains, failure records `resumeState: CREATED` and preserves workspace plus intent.

- [ ] **Step 7: Make isolated working directory fail closed**

```ts
export function workingDirectoryFor(run: RunRecord): string {
  if (run.config.policy.useIsolatedWorktree) {
    if (!run.workspace?.worktreePath) {
      throw new Error(`Run ${run.id} requires an established MASWE-managed worktree`);
    }
    return run.workspace.worktreePath;
  }
  return run.repositoryPath;
}
```

- [ ] **Step 8: Verify and commit**

```bash
node --experimental-strip-types --test test/issue28-bootstrap.test.ts test/failed-run-provenance.test.ts test/orchestrator.test.ts
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
- Produces `reconcileRetryWorkspace(repositoryPath, run)`.

- [ ] **Step 1: Add pre-publication, conflict, and outcome-unknown tests**

Implement a `RunStore` wrapper with an explicit `delegate` field assigned in its constructor body and ordinary forwarding methods for `create`, `save`, `load`, `list`, `writeArtifact`, and `readArtifact`. Its `applyEvent()` throws only for `RETRY_FROM_FAILED`.

Extend `OrchestratorOptions`:

```ts
beforeRetryPublication?: (candidate: RunRecord) => Promise<void>;
```

Use it to produce an optimistic version conflict. Add directory-sync outcome-unknown coverage and distinguish the current retry by a pre-publication event-ID set.

- [ ] **Step 2: Run the red tests**

```bash
node --experimental-strip-types --test test/issue28-retry-publication.test.ts test/orchestrator.test.ts test/failed-run-provenance.test.ts
```

- [ ] **Step 3: Implement retry workspace reconciliation**

```ts
export async function reconcileRetryWorkspace(
  repositoryPath: string,
  run: RunRecord,
): Promise<RunWorkspace | undefined>;
```

- `CREATED`: require intent and bootstrap reconciliation.
- Later isolated state: exact preserved branch/head/path/registration and clean status; recreate only an absent exact worktree.
- Git operator checkout: exact branch/HEAD and clean source plane outside `.maswe`.
- Non-Git later operator checkout without provable source identity: fail closed and require supersession.

- [ ] **Step 4: Publish retry once from a clone**

Load failed run, copy `previousFailure`, capture event IDs, clone, reconcile workspace, delete active failure only on candidate, invoke hook, then apply `RETRY_FROM_FAILED` once.

On error:

- complete new retry event/resumed state/workspace/no failure: adopt;
- no new retry event plus original retryable failure: rethrow;
- any other shape: inconsistent authoritative record.

No standalone save occurs while state is `FAILED`.

- [ ] **Step 5: Verify and commit**

```bash
node --experimental-strip-types --test test/issue28-retry-publication.test.ts test/orchestrator.test.ts test/failed-run-provenance.test.ts test/github-authoritative-state.test.ts
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
- Produces `RevalidationTargetInput`, `RevalidationService.route()`, `RevalidationFence`, `captureRevalidationFence()`, `assertRevalidationFence()`.

- [ ] **Step 1: Add request, retarget, failed-retarget, idempotency, and fence tests**

Initial A-to-B from both gates must create generation `1`, invalidate evidence, and retain the actual source gate.

B-to-C from `BUILDING`, `CI_RUNNING`, and `VERIFYING` must enter `CI_RUNNING` generation `2`.

B-to-C from `FAILED` with active revalidation must remain `FAILED`, change operational resume state to `CI_RUNNING`, and retain previous resume state in event details.

Same target is a no-op unless an observed workspace snapshot needs saving. A B fence must fail after C retarget; a fresh C fence passes.

- [ ] **Step 2: Run the red tests**

```bash
node --experimental-strip-types --test test/issue28-revalidation.test.ts test/evidence-freshness.test.ts
```

- [ ] **Step 3: Implement service without parameter properties**

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

  constructor(store: RunStore, now: () => string = () => new Date().toISOString()) {
    this.store = store;
    this.now = now;
  }

  async route(runId: string, input: RevalidationTargetInput): Promise<RunRecord>;
}
```

`route()` publishes initial request, same-target event-free workspace alignment, or active/failed retarget. Illegal state/context fails closed. Failed retarget changes only the candidate failure resume state; historical `FAIL` stays unchanged.

- [ ] **Step 4: Implement exact fence helpers**

```ts
export interface RevalidationFence {
  runVersion: number;
  generation: number;
  requestedHeadSha: string;
}
```

`assertRevalidationFence()` reloads and requires exact version, generation, and target.

- [ ] **Step 5: Verify and commit**

```bash
node --experimental-strip-types --test test/issue28-revalidation.test.ts test/evidence-freshness.test.ts test/schema.test.ts
git add src/revalidation.ts test/issue28-revalidation.test.ts test/evidence-freshness.test.ts
git commit -m "feat: add revalidation target generations"
```

---

### Task 9: Integrate latest-target revalidation into orchestrator execution

**Files:**
- Modify: `src/orchestrator.ts`
- Modify: `src/revalidation.ts`
- Modify: `test/issue28-revalidation.test.ts`
- Modify: `test/evidence-freshness.test.ts`
- Modify: `test/orchestrator.test.ts`
- Modify: `test/issue28-retry-publication.test.ts`

**Interfaces:**
- Produces gate preflight, active target reconciliation, exact alignment, current-generation evidence publication, and durable return-gate selection.

- [ ] **Step 1: Add local gate and active-alignment tests**

- Local head B after evidence A from `PR_READY` returns to `PR_READY` after fresh quality/verification.
- Same from `PR_REVIEW` returns to `PR_REVIEW` with zero comment cycles.
- Associated target C while workspace B performs no quality/verifier work and fails with recoverable `CI_RUNNING` provenance.
- Exact clean operator move of the MASWE branch/worktree to C allows retry.
- B fence cannot publish commit/evidence after C retarget.

- [ ] **Step 2: Run the red tests**

```bash
node --experimental-strip-types --test test/issue28-revalidation.test.ts test/evidence-freshness.test.ts test/orchestrator.test.ts test/issue28-retry-publication.test.ts
```

- [ ] **Step 3: Add gate and active preflight**

Before stopping at `PR_READY`/`PR_REVIEW`, preserve old head, refresh exact workspace, assess evidence, and route local revalidation when moved/stale.

Before active `BUILDING`/`CI_RUNNING`/`VERIFYING`:

- associated required target is `github.headSha`;
- local required target is exact observed workspace head;
- different active target publishes retarget before work;
- same target with workspace misalignment fails closed.

- [ ] **Step 4: Return by durable context**

```ts
const successEvent = run.revalidation?.returnState === "PR_READY"
  ? "VERIFY_PASSED"
  : run.revalidation?.returnState === "PR_REVIEW"
    ? "VERIFY_PASSED_AFTER_REVIEW"
    : run.counters.commentResolutionCycles > 0
      ? "VERIFY_PASSED_AFTER_REVIEW"
      : "VERIFY_PASSED";
```

Clear context on the same candidate that gets fresh verification evidence and the success event.

- [ ] **Step 5: Fence side effects/publication**

- Builder/resolver: after artifact write, assert fence immediately before deterministic commit and again before event publication.
- Quality/verifier: artifact write catches stale versions; assert fence before event/evidence publication.
- Return gate: assert fence before clearing context.

A retarget racing inside a Git command may leave an unaccepted commit, but no stale event/evidence may publish. Next preflight fails closed on head/target mismatch; no reset is authorized.

- [ ] **Step 6: Retarget failed runs before retry**

Compare current required head with active target before retry. If different, publish failed self-retarget, reload, then prepare retry for `CI_RUNNING`.

- [ ] **Step 7: Verify and commit**

```bash
node --experimental-strip-types --test test/issue28-revalidation.test.ts test/evidence-freshness.test.ts test/orchestrator.test.ts test/issue28-retry-publication.test.ts
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
- Produces event-free association snapshot save, field-scoped rollback, and `afterAssociationCommitBeforeRouting` seam.

- [ ] **Step 1: Add failure matrix and B-to-C tests**

Inject run-save failure, known index failure, index outcome unknown, stop after association commit, routing-event failure, and concurrent event before rollback. Assert event IDs/order/details never decrease/change.

Deliver B then C to zero-cycle `PR_REVIEW`; require generation `2`, target C, and no B-bound success.

- [ ] **Step 2: Run the red tests**

```bash
node --experimental-strip-types --test test/issue28-github-reconciliation.test.ts test/github-adapter.integration.test.ts
```

- [ ] **Step 3: Implement exact rollback invariants**

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

Known-failure rollback requires exact attempted version plus equal histories/invariants, then restores only prior `github` and `evidence`. Refuse mismatch.

- [ ] **Step 4: Implement two phases**

Inside association transaction:

- capture previous head;
- update only GitHub association, pending cancellation heads, stale evidence;
- publish no workflow event or target change;
- save snapshot, bind index, register field rollback.

After transaction:

- invoke crash seam;
- reload;
- route request/retarget/no-op through `RevalidationService`;
- publish checks;
- never register routing events for rollback.

Apply to webhook PR/push and manual check live-head refresh.

- [ ] **Step 5: Preserve outcome-unknown semantics**

Test rollback callbacks run only for known non-publication failures, never for `DurableAtomicWriteOutcomeUnknownError`, in reverse order, with aggregated callback failures.

- [ ] **Step 6: Verify and commit**

```bash
node --experimental-strip-types --test test/issue28-github-reconciliation.test.ts test/github-adapter.integration.test.ts test/github-durable-ingress.test.ts test/github-authoritative-state.test.ts
git add src/github/adapter.ts src/github/association.ts test/issue28-github-reconciliation.test.ts test/github-adapter.integration.test.ts
git commit -m "fix: preserve events during github head routing"
```

---

### Task 11: Harden merge-ready/completion, rendering, and public contracts

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
- Produces one exact current-head gate assertion and bounded operator diagnostics.

- [ ] **Step 1: Add gate rejection tests**

For merge-ready and completion cover active revalidation, head/target/GitHub mismatch, missing/failed/stale quality or verification, dirty/wrong-branch worktree, and missing/stale merge-ready evidence. Assert no state/event/evidence change.

- [ ] **Step 2: Add rendering tests using generated values**

```ts
assert.match(
  output,
  new RegExp(
    `Bootstrap: mode=isolated-worktree, source=${sourceSha.slice(0, 12)}, workspace=checkpointed`,
  ),
);
assert.match(
  output,
  new RegExp(
    `Revalidation: source=github, target=${targetSha.slice(0, 12)}, generation=2, return=PR_REVIEW`,
  ),
);
```

Also require stable overflow failure code and bounded/redacted diagnostics.

- [ ] **Step 3: Run the red tests**

```bash
node --experimental-strip-types --test test/issue28-rendering.test.ts test/issue28-revalidation.test.ts test/evidence-freshness.test.ts
```

- [ ] **Step 4: Implement exact gate assertion**

Require no context, known head, exact branch, clean isolated worktree, associated workspace/GitHub equality, current passing quality/verification when required, and current passing merge-ready for completion. Return exact head for event details; historical events never recreate current success.

- [ ] **Step 5: Implement bounded rendering**

Render failure code, bootstrap mode/phase/source short SHA, and revalidation source/target/generation/return gate. Preserve full values in JSON.

- [ ] **Step 6: Synchronize exact public requirements**

Add these normative statements with document-appropriate grammar:

```text
Bootstrap source-drift checks exclude the orchestrator-owned .maswe namespace; read-only role fingerprints continue to include authoritative .maswe state.

Every production-created run, including a superseding replacement, persists workspace bootstrap intent before branch or worktree side effects and durably checkpoints the established workspace before START.

A newer authenticated or local head retargets an active or recoverable failed revalidation generation. Evidence from a superseded generation is unusable.

GitHub association publication is event-free and rollback-capable; workflow request and retarget events publish only after association commit and are never rolled back.
```

Update state diagrams, run-record examples, event SHA semantics, and operator recovery procedures.

- [ ] **Step 7: Verify and commit**

```bash
node --experimental-strip-types --test test/issue28-rendering.test.ts test/schema.test.ts test/issue28-revalidation.test.ts test/evidence-freshness.test.ts
npm run typecheck
git add src/orchestrator.ts src/run-rendering.ts test/issue28-rendering.test.ts test/issue28-revalidation.test.ts test/evidence-freshness.test.ts test/schema.test.ts docs/PRD.md docs/ARCHITECTURE.md docs/ARTIFACT_CONTRACTS.md docs/GITHUB_APP.md docs/OPERATIONS.md
git commit -m "docs: synchronize Issue 28 recovery contracts"
```

---

### Task 12: Run exact-baseline validation and prepare independent review

**Files:**
- Modify only files from Tasks 1–11 when a failing validation proves a correction is required.

**Interfaces:**
- Produces exact-head Node 24/22, packaging, whitespace, scope, and independent-review evidence.

- [ ] **Step 1: Run focused Issue #28 tests on Node 24.18.0**

```bash
command -v node
node --version
node -p 'process.execPath'
npm --version
node --experimental-strip-types --test test/issue28-transition-bound.test.ts test/issue28-bootstrap.test.ts test/issue28-retry-publication.test.ts test/issue28-revalidation.test.ts test/issue28-github-reconciliation.test.ts test/issue28-rendering.test.ts
```

Require `node --version` to print `v24.18.0` and all tests to pass.

- [ ] **Step 2: Run complete canonical validation**

```bash
npm run check
npm run pack:dry
git diff --check
```

Require exit `0` for every command.

- [ ] **Step 3: Audit exact scope**

```bash
git status --short
git diff --name-only e80043cb208b5c26671a7aae34283d75ffab9dec...HEAD
```

Reject dependency, package, workflow, runtime-adapter, CLI-grammar, Issue #29, Issue #30, or destructive Git changes.

- [ ] **Step 4: Run exact Node 22.22.2 compatibility validation**

Record the same runtime evidence and run:

```bash
npm run check
npm run pack:dry
git diff --check
```

Require exit `0` for every command.

- [ ] **Step 5: Verify requirement traceability**

Confirm passing evidence for:

- editing/no-op builder and resolver provenance;
- exact boundary and durable overflow;
- Git/non-Git source-only fingerprint plus unchanged authoritative fingerprint;
- start/supersede intent;
- four bootstrap failure barriers and real checkpoint;
- dirty worktree rejection;
- retry publication ambiguity matrix;
- both return gates and zero-cycle review;
- active/failed B-to-C retarget;
- stale-generation fence;
- append-only event history;
- merge-ready/completion current-head gates;
- schema/rendering/docs synchronization.

- [ ] **Step 6: Commit validation corrections without unresolved file placeholders**

When files changed because of validation:

```bash
git diff --name-only -z --diff-filter=ACMRT | xargs -0 git add --
git diff --cached --name-only
git commit -m "test: complete Issue 28 validation"
```

Inspect the staged list before committing. If no files changed, create no commit.

- [ ] **Step 7: Generate exact independent-review request**

```bash
HEAD_SHA="$(git rev-parse HEAD)"
cat <<EOF
base SHA: e80043cb208b5c26671a7aae34283d75ffab9dec
head SHA: ${HEAD_SHA}
canonical Node: 24.18.0
compatibility Node: 22.22.2
required commands: npm run check; npm run pack:dry; git diff --check
scope: Issue #28 only
required special review: bootstrap fingerprint planes, dirty-worktree recovery, B-to-C active/failed retarget, and append-only event history
EOF
```

Do not mark ready or merge while exact-head CI, independent review, or actionable-thread gates remain incomplete.

---

## Traceability Summary

| Requirement | Task |
|---|---|
| Builder/resolver input-output-evaluated SHA | 2 |
| Durable exact automatic boundary | 3 |
| Bootstrap source fingerprint excludes `.maswe` | 4 |
| Start and supersede persist intent first | 5 |
| Recover branch/worktree partial creation | 6 |
| Real `CREATED + workspace + intent` checkpoint | 6 |
| Dirty registered worktree rejected | 6–7 |
| Retry publication retains recovery metadata | 7 |
| Initial revalidation and return gate | 8–9 |
| Active/failed B-to-C retarget | 8–10 |
| Stale generation cannot publish success | 9 |
| GitHub rollback cannot remove events | 10 |
| Merge-ready/completion require current evidence | 11 |
| Types/schema/rendering/docs synchronized | 1, 11 |
| Both exact Node baselines and packaging pass | 12 |

## Plan Self-Review Result

- All 18 Issue #28 acceptance criteria map to implementation and deterministic evidence.
- All six external-review findings map to blocking tests.
- Every later helper/type is defined in an earlier task.
- Every referenced existing test path was verified in the repository.
- Test-only seams are constructor options, not persisted configuration.
- Code examples avoid enums, parameter properties, decorators, and transform-dependent syntax.
- No task authorizes destructive Git recovery, event-history rollback, Issue #29 work, or Issue #30 work.
- The plan contains no unresolved implementation choices or shell/file placeholders.
