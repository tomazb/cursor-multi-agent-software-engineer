# Issue #28 Workflow Provenance, Recovery, and Revalidation Design

## Status

- **Issue:** [#28](https://github.com/tomazb/multi-agent-software-engineer/issues/28)
- **Parent:** [#27](https://github.com/tomazb/multi-agent-software-engineer/issues/27)
- **Revision:** 2
- **Status:** Owner-approved direction amended after external review; reissued for exact-artifact review
- **Implementation:** Not authorized until this revision and its later implementation plan are approved
- **Date:** 2026-08-18
- **Baseline:** `e80043cb208b5c26671a7aae34283d75ffab9dec`
- **Branch:** `issue-28-workflow-recovery`
- **Supersedes design commit:** `f76001860191e2358e5b5938910a286daa012fdc`

Revision 2 incorporates all six validated external-review findings. It keeps schema version `1`, the existing file store, and `src/state-machine.ts` as the sole workflow transition map.

## 1. Decisions

MASWE will implement one coherent recovery slice:

1. Editing events expose the evaluated post-publication SHA as public `headSha`.
2. Automatic-transition overflow publishes a durable failure after checking the resulting state.
3. Every production-created run persists bootstrap intent before Git side effects, then publishes a real `CREATED + workspace` checkpoint before `START`.
4. Failure and retry transitions publish from cloned candidates so the prior recovery key remains durable until the complete next record is published.
5. Stale evidence starts explicit revalidation, and a newer head retargets an active or failed cycle to the latest generation.
6. GitHub association rollback is event-free and field-scoped; published workflow events are not rolled back.

## 2. External-review corrections

| Finding | Required correction |
|---|---|
| Operator-checkout bootstrap fingerprints MASWE's own new run record | Add a source-tree fingerprint that excludes `.maswe`; keep the existing authoritative fingerprint for read-only role checks. |
| Active revalidation remains targeted at B after GitHub advances to C | Add `REVALIDATION_RETARGETED`, generation fencing, and active/failed-cycle preflight. |
| Association rollback can restore a pre-event snapshot | Split association snapshot commit from workflow-event publication; only event-free fields may be rolled back. |
| `supersede()` can create an intent-less replacement | Route `start()` and every replacement creation through one production planning helper that persists intent first. |
| The design names but never writes `CREATED + workspace` | Add a standalone workspace checkpoint save, reload, and later `START` publication. |
| Correctly registered worktree may be dirty | Require clean staged/unstaged/non-ignored-untracked status before reuse, checkpoint, `START`, and retry. |

## 3. Scope boundaries

### Goals

- Exact SHA provenance and exact-head evidence.
- Durable automatic-bound failure with a stable code.
- Recoverable bootstrap before branch creation, after branch creation, after worktree creation, and after workspace save.
- No implicit isolated-run fallback to the operator checkout.
- No false bootstrap drift caused by `.maswe` writes.
- No adoption of dirty managed worktrees.
- Retry publication that leaves either the prior retryable `FAILED` record or the complete resumed record.
- Revalidation from `PR_READY` and `PR_REVIEW`, including B→C target changes while active or failed.
- Append-only workflow event history across GitHub association failures.
- Schema-version-1 compatibility without rewriting historical events.

### Non-goals

- PostgreSQL, distributed workers, leases, or transactional outbox.
- Automatic fetch, reset, rebase, merge, force-update, worktree prune, path deletion, PR creation, or merge.
- Issue #29 policy/input work, Issue #30 terminal cleanup recovery, Issue #34 repository-rename migration, or GitHub Phase B writes.
- Canonical fingerprint framing/race redesign owned by Issue #13.
- CLI parser, runtime adapter, dependency, package, or workflow refactors.

## 4. Invariants

1. **Transition authority:** only `src/state-machine.ts` maps events to states.
2. **Evaluated identity:** quality, verification, merge-ready, completion, and checks bind to the exact evaluated SHA.
3. **Fingerprint planes:** bootstrap source drift excludes `.maswe`; read-only enforcement includes authoritative `.maswe` state.
4. **Isolated workspace:** an isolated run without its exact managed worktree fails closed.
5. **Actionable checkpoints:** every persisted `CREATED` shape retains `workspaceBootstrap` and a legal run/retry operation.
6. **Publication:** each write leaves the prior actionable record or the complete next record.
7. **Event history:** published event IDs, order, details, and count do not decrease or change during reconciliation.
8. **External versus local identity:** GitHub observation does not establish local branch/worktree content.
9. **Latest target:** one active revalidation generation names one current target; later authenticated heads supersede earlier targets.
10. **Historical compatibility:** migration does not rewrite historical SHAs or events.

## 5. Domain contract

### 5.1 Source-tree fingerprint

Add a helper equivalent to:

```ts
captureWorkspaceSourceFingerprint(cwd): Promise<string>
```

It is domain-separated from `gitWorkspaceFingerprint()` and excludes the complete `.maswe` namespace.

- **Git:** hash the current source plane outside `.maswe`, including staged, unstaged, and non-ignored untracked content using the current encoding. Base SHA and branch stay separate.
- **Non-Git:** deterministically hash source-tree entries outside `.maswe` using current bounds/encoding. Issue #13 still owns later framing and race changes.

This helper is used only for bootstrap drift. `RunWorkspace.fingerprint` remains a last-observed diagnostic; normal read-only checks still call `gitWorkspaceFingerprint()` and include authoritative `.maswe` state.

### 5.2 Bootstrap intent

```ts
interface WorkspaceBootstrapIntent {
  mode: 'operator-checkout' | 'isolated-worktree';
  sourceBaseSha: string;
  sourceBranch: string;
  sourceTreeFingerprint: string;
  remote?: string;
  plannedAt: string;
}
```

`RunRecord` gains `workspaceBootstrap?`.

Deterministic targets remain:

```text
branch       = maswe/{run-id}
worktreePath = externalWorktreePath(repositoryPath, runId)
```

Valid shapes:

| Shape | Meaning |
|---|---|
| `CREATED` + intent + no workspace | Planned, workspace not checkpointed. |
| `CREATED` + intent + workspace | Workspace checkpointed, `START` absent. |
| `FAILED` + `resumeState: CREATED` + intent | Bootstrap failed and remains retryable. |

Intent is removed only in the same publication as `START`.

### 5.3 Revalidation context

```ts
interface RunRevalidation {
  returnState: 'PR_READY' | 'PR_REVIEW';
  source: 'local-workspace' | 'github';
  originHeadSha: string;
  requestedHeadSha: string;
  generation: number;
  requestedAt: string;
  updatedAt: string;
}
```

`RunRecord` gains `revalidation?`.

- `returnState` is derived once from the source gate.
- `requestedHeadSha` is the only current target.
- `generation` starts at `1` and increments per accepted target change.
- Event details retain old/new targets; no unbounded target-history array is added.

### 5.4 Failure code and events

Add failure code:

```text
automatic-transition-limit-exceeded
```

Add events:

```text
REVALIDATE_REQUESTED
REVALIDATION_RETARGETED
```

## 6. State-machine contract

Add transitions:

```text
PR_READY  + REVALIDATE_REQUESTED -> CI_RUNNING
PR_REVIEW + REVALIDATE_REQUESTED -> CI_RUNNING

CI_RUNNING + REVALIDATION_RETARGETED -> CI_RUNNING
BUILDING   + REVALIDATION_RETARGETED -> CI_RUNNING
VERIFYING  + REVALIDATION_RETARGETED -> CI_RUNNING
FAILED     + REVALIDATION_RETARGETED -> FAILED
```

Add `CREATED` to retry resumable states.

The `FAILED` self-transition is valid only with active revalidation and `failure.resumeState` in `BUILDING`, `CI_RUNNING`, or `VERIFYING`. Its candidate changes the operational resume state to `CI_RUNNING` and records the prior resume state in event details. The historical `FAIL` event remains unchanged.

## 7. Editing-stage provenance

For `BUILD_COMPLETED` and `RESOLUTION_COMPLETED`:

```ts
{
  inputHeadSha: beforeSha,
  outputHeadSha: evaluatedSha,
  headSha: evaluatedSha
}
```

Editing execution:

```text
inputHeadSha != outputHeadSha
headSha == outputHeadSha == run.workspace.headSha
```

No-op execution:

```text
inputHeadSha == outputHeadSha == headSha == run.workspace.headSha
```

Historical event details are not rewritten.

## 8. Production run planning

Introduce one orchestrator production path equivalent to:

```ts
createPlannedRun({ title, request, config, supersedes? })
```

It:

1. validates dirty-workspace policy;
2. resolves the immutable config snapshot where applicable;
3. captures source base, branch, remote, and source-tree fingerprint;
4. creates the initial `CREATED` record with `workspaceBootstrap`;
5. includes `supersedes` in that initial record for a replacement;
6. performs no branch/worktree side effect before that write is durable.

`start()` and `supersede()` replacement creation must use this path. Production orchestrator code may not call `store.create()` without bootstrap intent. Explicit historical/test fixtures may create bare records.

## 9. `CREATED` bootstrap protocol

### Phase 1 — Reconcile

For operator-checkout mode require:

```text
current base SHA == sourceBaseSha
current branch == sourceBranch
current source-tree fingerprint == sourceTreeFingerprint
```

MASWE `.maswe` writes do not alter this comparison; user/source changes do.

For isolated mode derive the expected branch/path and classify exact Git state.

Branch rules:

| Observation | Result |
|---|---|
| Branch absent | Create at `sourceBaseSha`. |
| Branch exists at source base | Reuse. |
| Branch exists at another SHA | Fail closed; do not move it. |

Worktree rules:

| Observation | Result |
|---|---|
| Path/registration absent | Add expected branch at deterministic path. |
| Registration, path, branch, HEAD, and clean status match | Reuse. |
| Identity matches but staged, unstaged, or non-ignored untracked changes exist | Fail closed; do not reset, clean, or commit them. |
| Branch checked out elsewhere, path occupied, registration stale, or identity differs | Fail closed. |

Use structured inspection (`git worktree list --porcelain`, exact refs, existing clean-status helper), not localized stderr matching.

### Phase 2 — Workspace checkpoint

When workspace is absent:

1. clone the authoritative `CREATED` record;
2. set `candidate.workspace`;
3. retain `candidate.workspaceBootstrap` and state `CREATED`;
4. publish no event;
5. save;
6. reload the authoritative record.

Outcome-unknown classification:

- exact `CREATED + workspace + intent`: adopt;
- prior `CREATED + intent`: remain retryable and report failure;
- another shape: fail closed.

A deterministic seam runs after this save and before `START`.

### Phase 3 — `START`

After reload:

1. revalidate source identity or exact managed registration/branch/HEAD/clean status;
2. clone the checkpoint;
3. remove bootstrap intent;
4. publish `START` through `applyEvent()`.

Outcomes are the actionable checkpoint or `BRAINSTORMING` with workspace and exact `START` event. No role runs before the latter is authoritative.

Clean status is checked before checkpoint, after reload/before `START`, and during retry reconciliation.

Historical `CREATED` records use conservative classification: persist a provable intent before side effects; if partial resources exist but their source cannot be proven, require supersede/manual recovery.

`workingDirectoryFor()` throws for isolated policy without an exact worktree; it does not return the operator checkout.

## 10. Automatic-transition bound

Keep production bound `20`.

After each successful advance:

1. increment count;
2. return if result is a human gate or terminal state;
3. if count reached 20 and result remains automatic, publish `FAIL` with:

```text
code: automatic-transition-limit-exceeded
resumeState: CURRENT_AUTOMATIC_STATE
```

A test-only dependency seam may use a lower bound; it is neither config nor persisted policy.

## 11. Failure and retry publication

### Failure

`failRun()` clones the run, stages bounded failure metadata, and publishes `FAIL` once. The durable result is the prior nonterminal record or the complete `FAILED` record with metadata and event.

### Retry

`retryFromFailed()`:

1. loads authoritative `FAILED`;
2. copies bounded/redacted `previousFailure`;
3. reconciles workspace on a clone, including bootstrap and dirty-worktree rules;
4. reconciles a newer active revalidation target before continuation;
5. removes active failure only in memory;
6. publishes `RETRY_FROM_FAILED` with restored workspace, resume state, and `previousFailure`;
7. continues only after authoritative success.

No standalone save occurs while state is durably `FAILED`.

On publication error reload and classify:

- exact retry event/resumed state: adopt;
- original retryable `FAILED`: report error and retain retry path;
- another shape: fail closed.

## 12. Revalidation and active retargeting

### Initial request

`requestRevalidation()` accepts `PR_READY` or `PR_REVIEW` with no active context. It derives return gate, invalidates stale evidence, creates generation `1`, and publishes `REVALIDATE_REQUESTED -> CI_RUNNING`.

### Retarget

`retargetRevalidation()` accepts active context with a different current target. One event publication stages:

- new requested head;
- generation + 1;
- latest source/timestamp;
- stale-evidence invalidation;
- event details: `previousRequestedHeadSha`, `requestedHeadSha`, `generation`, `returnState`, `source`, and prior resume state where applicable;
- routing to `CI_RUNNING`, or `FAILED -> FAILED` with operational resume state set to `CI_RUNNING`.

B→C leaves C as the only acceptable target. Alignment only to superseded B is rejected.

### Preflight and crash recovery

`reconcileRevalidationTarget()` runs from:

- webhook/manual live-head handling after association commit;
- `runUntilBlocked()` in active `BUILDING`, `CI_RUNNING`, or `VERIFYING`;
- `retryFromFailed()` with retained revalidation.

Required target:

```text
GitHub-associated: run.github.headSha
local-only: exact observed workspace HEAD
```

A mismatch with `revalidation.requestedHeadSha` publishes `REVALIDATION_RETARGETED` before builder publication, quality, verification, or retry continuation. This also repairs a process stop after association commit but before routing event.

### Generation fencing

Each active attempt captures run version, generation, and requested target. Before publishing commits, evidence, or return-to-gate success, those values must still match authoritative state. A retarget changes version/generation; stale B-bound work reloads and follows current-head routing instead of publishing success for C.

### Alignment and return

For GitHub-associated revalidation:

```text
workspace.headSha == revalidation.requestedHeadSha == github.headSha
```

Issue #28 does not move refs automatically. An external/operator move is accepted only for the exact MASWE branch/path/registration, clean worktree, and current target.

Successful current-generation verification publishes:

```text
returnState PR_READY  -> VERIFY_PASSED
returnState PR_REVIEW -> VERIFY_PASSED_AFTER_REVIEW
```

The event, evidence, target gate, and removal of context publish coherently. Context survives correction loops and retry until current-generation success.

Repeated same-target observations are no-ops.

## 13. GitHub association and event preservation

Live-head handling uses two phases under the existing per-PR publication fence.

### Phase A — rollback-capable event-free snapshot

Inside the association transaction:

1. load and clone run;
2. update only `github`, pending cancellation heads, and stale evidence;
3. keep state, events, failure, revalidation target, artifacts, approvals, and counters unchanged;
4. save the event-free snapshot;
5. bind and commit association index.

Known index non-publication may invoke a field-scoped rollback that restores only `github` and `evidence`, and only when exact version, state, event IDs/order/count, failure, revalidation, artifacts, approvals, and counters still match the attempted event-free record.

Full-snapshot rollback is prohibited for this path. A callback must not write fewer events than the authoritative record.

### Phase B — non-rollback routing

After association commit:

1. reload run;
2. request, retarget, or no-op according to current target/context;
3. publish checks after routing classification;
4. do not register routing events for association rollback.

Failure behavior:

| Point | Behavior |
|---|---|
| Run snapshot save fails | Prior state remains, subject to existing outcome-unknown reload. |
| Known index failure | Field-scoped event-free rollback may run. |
| Index outcome unknown | Do not roll back; reload run/index and reconcile. |
| Stop after index commit, before event | Association/stale evidence remain; delivery retry or `maswe run` publishes missing routing event. |
| Routing event failure | Do not roll back association or events; retry/self-heal. |
| Check failure | Existing cancellation/idempotency recovery applies; events remain. |

Apply this protocol to webhook PR/push head changes and manual check publication live-head refresh.

## 14. Merge-ready and completion

Reject when:

- revalidation context exists;
- workspace HEAD is unknown;
- associated workspace, requested target, and GitHub head disagree;
- quality or verification evidence is absent, failed, or stale;
- completion lacks current merge-ready evidence;
- managed worktree is dirty or on another branch.

Historical events do not recreate current success after evidence invalidation.

## 15. Schema, migration, rendering, and docs

Schema stays version `1`.

Add optional fields:

```text
workspaceBootstrap
revalidation
```

Add failure code and event enum values from Sections 5–6. Synchronize:

```text
src/domain.ts
src/run-record-validation.ts
src/store.ts
src/state-machine.ts
schemas/run-record.schema.json
```

Historical valid records remain loadable; historical events and SHAs are unchanged. Malformed or contradictory new metadata fails closed.

Human rendering adds failure code, bootstrap phase/conflicts, revalidation return gate/target/generation/source, and workspace/GitHub alignment. Diagnostics remain bounded/redacted.

Update:

```text
docs/PRD.md
docs/ARCHITECTURE.md
docs/ARTIFACT_CONTRACTS.md
docs/GITHUB_APP.md
docs/OPERATIONS.md
```

No document may imply that evidence invalidation alone resumes a gate, that superseded targets remain valid, or that published events can be rolled back.

## 16. Mandatory tests

All recovery claims reload the authoritative run record.

### Provenance and bound

- Editing/no-op builder and resolver SHA contracts.
- Exact boundary to gate and terminal state.
- Overflow to durable `FAILED`, stable code, resume state.

### Bootstrap

- MASWE run/checkpoint/event writes do not change source-tree fingerprint.
- User source changes do change it.
- Existing read-only fingerprint still detects authoritative `.maswe` mutation.
- Fail before branch, after branch, after worktree, after checkpoint/before `START`, and during `START`.
- Production `start` and `supersede` both persist intent first.
- Branch/path/registration conflicts and stale registration.
- Correct identity but dirty worktree is rejected.
- Operator-checkout drift, legacy `CREATED`, and no isolated fallback.

### Retry

- Ordinary failure, version conflict, and outcome unknown.
- Prior `failure.resumeState` remains when publication does not occur.
- Exact retry event/workspace/cleared failure all appear when it does.

### Revalidation

- Local/GitHub request from both gates.
- `PR_REVIEW` with zero comment cycles.
- B→C while `CI_RUNNING`, `BUILDING`, `VERIFYING`, and active `FAILED`.
- Stop after association commit/before event.
- Same-head idempotency.
- Generation fence blocks stale B evidence.
- Only C accepted after retarget.
- Return to original gate; merge-ready/completion blocked while active.

### Association/event history

Inject run-save failure, known index failure, index outcome unknown, routing-event failure, and concurrent event before rollback. Assert:

- event IDs/order/count never decrease;
- published request/retarget events remain;
- field-scoped rollback refuses history mismatch;
- repeated delivery converges without duplicate routing events.

### Contract

- Exact schema/type enum synchronization.
- Historical schema-v1 records.
- Rendering and documentation literals.
- Package contents remain stable.

## 17. Acceptance traceability

| ID | Criterion | Evidence |
|---|---|---|
| I28-AC-01 | Editing builder SHA contract | Builder regression |
| I28-AC-02 | Editing resolver SHA contract | Resolver regression |
| I28-AC-03 | No-op coherent SHA | Builder/resolver no-op tests |
| I28-AC-04 | Durable overflow failure | Reload regression |
| I28-AC-05 | Boundary reaches human gate | Boundary test |
| I28-AC-06 | Boundary reaches terminal state | Boundary test |
| I28-AC-07 | Failure before branch recoverable | Bootstrap barrier 1 |
| I28-AC-08 | Failure after branch recoverable | Bootstrap barrier 2 |
| I28-AC-09 | Failure after worktree recoverable | Bootstrap barrier 3 |
| I28-AC-10 | Failure after workspace save recoverable | Real checkpoint barrier 4 |
| I28-AC-11 | Retry reconstructs intended workspace before roles | Runtime-cwd plus dirty-worktree tests |
| I28-AC-12 | Retry publication keeps recovery metadata | Publication matrix |
| I28-AC-13 | Revalidation returns to `PR_READY` | Local/GitHub tests |
| I28-AC-14 | Revalidation returns to `PR_REVIEW` | Local/GitHub tests |
| I28-AC-15 | External movement before comment cycle returns to review | Zero-cycle and B→C tests |
| I28-AC-16 | Stale evidence cannot authorize merge-ready/completion | Gate tests |
| I28-AC-17 | Types/schema/rendering/docs synchronized | Contract tests/review |
| I28-AC-18 | Required commands pass on both Node baselines | Exact-head evidence |

Review-derived mandatory regressions are part of the blocking suite: source-only bootstrap fingerprint, supersede intent, real workspace checkpoint, dirty-worktree rejection, active/failed B→C retarget, and append-only event history.

## 18. Expected implementation scope

Expected production files:

```text
src/domain.ts
src/state-machine.ts
src/orchestrator.ts
src/git-snapshot.ts
src/git-workspace.ts
src/store.ts
src/run-record-validation.ts
src/run-rendering.ts
src/github/adapter.ts
src/github/association.ts
schemas/run-record.schema.json
```

Focused `workspace-bootstrap.ts` or `revalidation.ts` helpers are permitted without transition authority.

Excluded unless a direct dependency is proven and separately approved:

```text
src/config.ts
schemas/config.schema.json
src/prompt-builder.ts
src/cli-runner.ts parser redesign
src/runtimes/**
package.json
package-lock.json
.github/workflows/**
```

## 19. Implementation order after approval

1. Provenance red tests and SHA correction.
2. Boundary red tests and durable overflow failure.
3. Source-tree fingerprint helper/tests without changing read-only semantics.
4. Bootstrap intent/schema for all production creation paths.
5. Exact Git/cleanliness tests and real workspace checkpoint.
6. `CREATED` recovery and working-directory guard.
7. Clone-staged failure/retry.
8. Initial revalidation and active-retarget domain/events/tests.
9. Two-phase association/routing reconciliation and field-scoped rollback.
10. B→C and event-history regressions.
11. Rendering/schema/docs/migration synchronization.
12. Exact-baseline validation and independent exact-head review.

Every behavioral task is test-first. Fail-closed behavior is not weakened to satisfy tests.

## 20. Validation gates

Required commands on exact Node `24.18.0` and `22.22.2`:

```bash
npm run check
npm run pack:dry
git diff --check
```

Before merge require exact-head CI, every Issue #28 and review-derived regression, independent exact-head review, zero unresolved actionable threads, clean scope, and post-merge `main` revalidation.

## 21. Resolved decisions and self-review

Revision 2 sets these decisions:

- source-tree fingerprint excludes `.maswe`; read-only fingerprint retains it;
- every production run, including supersede replacement, starts with durable intent;
- `CREATED + workspace + intent` is a real checkpoint;
- dirty managed worktrees are not reused;
- initial and retarget revalidation use distinct events;
- return gate survives target generations;
- active and failed cycles follow the latest authenticated/observed head;
- association snapshot publication precedes non-rollback event routing;
- published events are not rolled back;
- schema version remains `1`;
- no new CLI command or automatic destructive Git operation is added;
- terminal cleanup remains Issue #30.

Self-review requirements:

- no unresolved placeholders or open design choices;
- no fingerprint self-reference;
- lifecycle shapes match failure barriers;
- B→C has an active and failed recovery path;
- no reconciliation can reduce event history;
- all production creation paths and dirty-worktree cases are covered;
- all 18 criteria and six review findings map to deterministic evidence;
- historical event compatibility and scope boundaries are explicit.
