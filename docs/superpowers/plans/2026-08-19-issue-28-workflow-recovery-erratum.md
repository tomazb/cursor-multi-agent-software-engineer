# Issue #28 Workflow Recovery Implementation Plan Erratum

> **For agentic workers:** This erratum corrects two ordering/fencing statements in the preserved 2026-08-18 final plan. Read it together with that historical plan and the owner-approved design; do not rewrite the earlier artifact.

**Date:** 2026-08-19

**Applies to:** `docs/superpowers/plans/2026-08-18-issue-28-workflow-recovery-final.md`

**Goal:** Make the implemented bootstrap and revalidation boundaries match the approved recovery invariants without altering the historical plan.

**Architecture:** Production run creation first captures and durably publishes immutable bootstrap intent, then reconciliation may update Git exclude metadata or create branches/worktrees. Revalidation routing treats both the expected predecessor head and expected run version as required compare-and-swap inputs under the per-run target-mutation fence.

**Tech Stack:** TypeScript ESM, file-backed optimistic run records, Git CLI worktrees, immutable per-run mutation journals.

## Correction 1: bootstrap intent precedes Git-exclude mutation

Task 5, Step 4 of the historical plan incorrectly grouped `ensureMasweGitExclude()` with intent
capture. The corrected production order is:

1. enforce `allowDirtyWorkspace` in the shared `createPlannedRun()` boundary;
2. capture source base, branch, remote, and source-tree fingerprint without Git metadata mutation;
3. create the durable `CREATED + workspaceBootstrap` record (including `supersedes` when present);
4. enter bootstrap reconciliation;
5. only then call `ensureMasweGitExclude()` and create or reuse the deterministic branch/worktree;
6. publish the workspace checkpoint and, after exact revalidation, `START`.

This ordering makes a process stop before durable intent side-effect free, including
`.git/info/exclude`. It is covered by the start/supersede intent tests and the pre-reconciliation
Git-side-effect assertions in `test/issue28-bootstrap.test.ts`.

## Correction 2: revalidation target input carries predecessor and version fences

The historical plan's sample `RevalidationTargetInput` omitted the optimistic version input even
though the approved generation-fencing contract requires it. The authoritative interface is:

```ts
export interface RevalidationTargetInput {
  source: RevalidationSource;
  previousHeadSha: string;
  requestedHeadSha: string;
  expectedRunVersion: number;
  actor: string;
  observedWorkspace?: RunWorkspace;
  at?: string;
}
```

`previousHeadSha` is the expected predecessor/target fence; `expectedRunVersion` is the exact
authoritative record-version fence. `RevalidationService.route()` validates both only after it
owns the durable target-mutation fence and reloads the run. A mismatch publishes no request or
retarget event and must be retried from freshly loaded authority.

This correction is covered by the initial/retarget optimistic-conflict tests, B-to-C generation
tests, and queued target-versus-publication tests in `test/issue28-revalidation.test.ts`,
`test/evidence-freshness.test.ts`, and `test/run-mutation.test.ts`.

## Traceability

| Corrected statement | Production boundary | Regression evidence |
|---|---|---|
| Bootstrap intent precedes `ensureMasweGitExclude` | `createPlannedRun()` then `reconcileBootstrapWorkspace()` | start/supersede pre-reconcile interruption and no-side-effect tests |
| Revalidation input requires expected predecessor and version | `RevalidationService.route()` under `withRunMutationFence(..., "target", ...)` | optimistic conflict, B-to-C retarget, and queued-target publication tests |

The original 2026-08-18 plan remains byte-for-byte historical evidence. This erratum changes no
schema version, runtime adapter, CLI grammar, policy default, or destructive Git authority.
