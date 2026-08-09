# Design: GitHub App Recovery and Review Hardening

**Pull request:** [#25](https://github.com/tomazb/cursor-multi-agent-software-engineer/pull/25)
**Date:** 2026-08-09
**Status:** Approved

## Problem

PR #25 implements the Phase A read-only GitHub App pilot, but repeated repairs to reusable
delivery and lock pathnames have not established safe ownership. A delayed operation can still
act on a successor, recovery can choose an artifact from the wrong delivery lease, a crash can
leave an unrecoverable empty lock directory, and old file locks cannot migrate to the directory
format. These are variants of the reusable-path ownership defect already rejected by ADR-0006.

The PR also has unresolved review threads. Some describe behavior fixed by later commits and need
evidence-based replies and resolution. Others remain valid: retry semantics for live deliveries,
unsupported webhook events, bounded GitHub HTTP calls, schema/runtime parity, multi-association
push invalidation, complete check identity and reconciliation, error redaction, documentation,
and regression-test precision.

## Goals

- Preserve same-host, multi-process access to `.maswe/github`, including a webhook server and a
  simultaneous manual `github-publish-checks` command.
- Replace reusable lock pathname ownership with immutable, identity-bound claims and releases.
- Serialize every delivery mutation and run delivery recovery inside the same ownership boundary.
- Recover legacy delivery artifacts without installing an older or unrelated lease.
- Preserve Phase A idempotency across crashes, retries, concurrent handlers, and ambiguous Check
  API outcomes.
- Address every current PR review thread: implement valid in-scope requests, resolve requests
  already satisfied with evidence, and reply with a technical explanation when no change is made.
- Re-fetch review state after publishing because new comments may arrive while work is in flight.

## Non-goals

- SQLite/PostgreSQL or the v0.4 transactional control plane.
- Distributed or cross-host locks, network filesystems, or mixed old/new active binaries.
- Phase B push, PR, comment-reply, approval, or review-thread automation in product code.
- Weakening the Checks-only permission boundary or treating age alone as proof of owner death.
- General refactoring outside the GitHub App paths and narrowly required shared journal changes.

## Support boundary

The GitHub state store supports concurrent processes on one coherent local filesystem with atomic
no-clobber hard links. The canonical contributor/runtime baselines remain exact Node `24.18.0`
and compatibility floor `22.22.2`. NFS, SMB, distributed FUSE, object-store mounts, and mixed
old/new MASWE binaries are unsupported. Upgrading from the reusable lock formats requires all old
GitHub webhook/manual publisher processes to stop before migration.

## Approaches considered

### 1. Reuse immutable ticket journals — chosen

Adapt the immutable ticket-journal protocol accepted in ADR-0006 behind a small GitHub-specific
lock wrapper. Every logical lock has permanent claims/releases and a deterministic queue. Claims
and releases are complete, immutable, digest-bound records installed through atomic hard links.
The protocol never deletes or reuses a published ownership pathname.

This preserves multi-process behavior, uses only Node core APIs, matches the repository's existing
filesystem support boundary, and addresses the root ownership defect rather than another race
window.

### 2. Move GitHub state to SQLite — rejected for Phase A

SQLite transactions and uniqueness would simplify delivery and side-effect consistency, but this
pulls the v0.4 persistence migration and a new runtime dependency into the Phase A pilot.

### 3. Continue repairing CAS and `mkdir` locks — rejected

More pathname reads, renames, byte comparisons, or recursive removals cannot bind a late remover
to the object it previously observed. ADR-0006 documents the same failure and rejects reusable
`mkdir` ownership. The sequence of PR repairs confirms that this is an architectural problem.

## Architecture

### GitHub journal wrapper

Add a focused wrapper that maps a logical GitHub lock to a permanent journal root and drives the
existing immutable claim protocol:

- Association mutations use one journal.
- Each check-run idempotency key uses a hash-addressed journal.
- Each delivery ID uses a hash-addressed journal.

The wrapper publishes a claim, waits for the smallest unreleased ticket, validates its exact claim
and absence of its exact release immediately before protected entry, executes the callback, and
publishes the exact release in `finally`. If a lower owner is provably dead, recovery publishes an
immutable release for that exact claim. A live owner, `EPERM`, malformed record, or unavailable
process identity fails closed. Waiting and recovery are bounded and produce actionable errors.

Initialization performs the journal hard-link probe before the webhook listener accepts traffic
or manual publication begins. Probe failure is fatal.

### Legacy lock migration

The old association regular-file/directory lock and per-key check-create locks are treated as
read-only ticket-zero evidence. Under the required quiescent upgrade:

- The migration records the exact raw bytes or stable empty-directory identity.
- The migration publishes an immutable marker binding that evidence.
- The old pathname is retained, not renamed, deleted, or reused, preventing an old binary from
  acquiring it after migration.
- A valid live old owner blocks migration. Unstable identity or filesystem errors fail closed.

This handles dead regular-file locks, dead directory locks, and crash remnants without opening a
successor-deletion window. Mixed old/new binaries remain explicitly unsupported.

### Delivery ledger

Every `claim`, `complete`, and `fail` operation acquires the delivery's journal. The delivery file
is then ordinary state protected by immutable ownership rather than acting as the lock itself.

- `claim` reads and recovers under the journal. Completed records are terminal. Non-stale
  processing records are live duplicates. Stale processing records receive a new lease only while
  the journal is held.
- `complete` verifies the exact lease, writes and syncs a complete staging record, then atomically
  replaces the canonical processing record while still holding the journal.
- `fail` verifies the exact lease and removes the processing record while holding the journal so
  a retry can claim it.
- Mutation results remain fenced by lease ID and are never discarded by the adapter.

New completion writes do not remove the canonical pathname before replacement, so they create no
ledger absence. A crash before replacement leaves the processing canonical and complete staging;
the next journal owner can finish it without redispatching.

### Legacy delivery recovery

Legacy `.staging.<attempt>` and `.reclaim.<attempt>` artifacts are recovered only while holding
the delivery journal. Recovery parses full delivery records and groups artifacts by attempt.

An artifact is eligible only when:

- `deliveryId` matches the canonical delivery ID;
- staging is `completed` and reclaim/canonical is `processing`;
- lease IDs match and required timestamps are structurally valid; and
- exactly one compatible lease outcome exists.

With a valid processing canonical, matching completed staging may replace it. With a missing or
invalid canonical, recovery requires a matching staging/reclaim pair. A lone staging record is
never installed when canonical state is absent. Conflicting leases or multiple incompatible
candidates fail closed without deleting evidence. Once a valid canonical wins, only artifacts
proven obsolete under the journal are removed.

## Webhook behavior

- Validate single-valued delivery and event headers before claiming. Arrays, missing values, and
  delivery IDs outside the safe filename grammar return HTTP 400.
- Verify the signature before any durable state write.
- Completed duplicates return HTTP 200. Live processing duplicates return a retryable HTTP 503.
- Introduce a distinct unsupported-event/action classification. Those deliveries are completed as
  intentionally ignored and return HTTP 200; malformed/transient supported-event failures remain
  retryable failures.
- Invalid JSON returns HTTP 400 only after exact-lease failure handling succeeds; lost ownership
  is surfaced rather than acknowledged as success.
- Completion rejection produces a retryable server error. Failure rejection is recorded through
  production diagnostics.
- The server logs internal failures locally and returns a generic HTTP 500 body. It never returns
  environment-variable names or internal exception messages to unauthenticated callers.
- The existing body limit remains enforced with HTTP 413.

## Association behavior

Association read-modify-write operations use the immutable association journal. Push lookup
returns every non-suspended association matching `(repository, branch)`, and the adapter invalidates
each affected PR/run. Installation and repository removal continue to reconcile both the index and
`RunRecord.github.suspended`, including already-suspended index rows.

## Check publication and HTTP behavior

- Derive `external_id` from a deterministic SHA-256 digest of the complete idempotency key so PR,
  head SHA, check name, and attempt cannot collide through prefix truncation.
- Reconciliation requests `filter=all`, `per_page=100`, and boundedly visits every available page
  before concluding no matching `external_id` exists.
- A recovered ambiguous create is patched with the current outcome before returning.
- Invalidation tests assert exact POST/PATCH counts and the `cancelled` conclusion for the old SHA.
- The default fetch client applies a finite per-request `AbortSignal` deadline to token, live-head,
  Checks API, webhook-triggered, and manual publication calls.
- Installation-token POST requests explicitly send `content-type: application/json`.
- Rate-limit retries remain bounded and operate within repeated bounded HTTP attempts.

## Configuration and documentation

The JSON Schema mirrors runtime validation: when `githubApp.enabled` is true,
`readOnlyChecks` must be true and `allowedRepositories` must contain at least one entry. Disabled
configuration retains its current permissive repository-list behavior. Schema-level tests cover
both invalid enabled configurations and valid enabled/disabled configurations.

ADR-0005 receives separate v0.2 and v0.3 progress scopes. The Phase A design's architecture
reference is corrected. GitHub App operations documentation describes the immutable journal,
filesystem probe, legacy quiescent migration, HTTP deadline, diagnostics, and unsupported-event
behavior.

## Review-thread workflow

After implementation and verification:

1. Re-fetch all conversation comments, reviews, and inline threads with thread-aware GraphQL.
2. For each unresolved thread, verify the current head rather than trusting outdated anchors.
3. Reply in the inline thread with the implementing commit and test evidence when addressed.
4. Resolve addressed or demonstrably already-fixed threads.
5. Reply with a technical explanation and leave unresolved only when a request is invalid,
   conflicting, ambiguous, or out of Phase A scope.
6. Push the branch, wait for remote comment/check updates, and fetch all threads again.
7. Repeat until no unresolved in-scope actionable thread remains or a concrete external blocker is
   reported.

## Testing strategy

All behavioral changes follow red-green-refactor TDD. Each test names the production break it
catches and exercises real filesystem or adapter behavior.

### Ownership and recovery

- Old completed staging lease A cannot beat the current staging/reclaim lease B.
- Multiple artifact attempts are paired by attempt and lease; ambiguous candidates fail closed.
- Staging-before-replace and legacy mid-move crashes recover as completed without redispatch.
- Truncated legacy canonical data is recovered only from a matching pair.
- A crash before or after immutable claim publication is recoverable.
- Two recoverers cannot release or remove successor C.
- Live owners and `EPERM` remain blocking; only ESRCH-proven dead claims are released.
- Legacy dead file/directory locks and empty crash remnants migrate under quiescence; live and
  unstable legacy states fail closed.
- Child-process contention proves association and check-create mutual exclusion across processes.

### Webhook, association, and checks

- Completed duplicate success and processing duplicate retry responses.
- Unsupported event/action success without redispatch; transient supported-event failure retries.
- Array/malformed headers return 400 and generic internal failures do not leak details.
- Multiple PRs on one branch are all invalidated by push.
- Timeout signals reach every production fetch path.
- Full external identity distinguishes attempts and missing local side-effect recovery.
- Reconciliation patches the recovered run and paginates `filter=all` results.
- Token requests include JSON content type.
- Schema conditional constraints match runtime behavior.
- Old-SHA invalidation assertions prove exact cancelled updates.

## Verification and rollout gates

Before any completion claim or GitHub thread resolution:

- Run focused red-green tests for each behavior.
- Run the complete `npm run check` under exact Node `24.18.0` and record node/npm paths and
  versions.
- Run the complete `npm run check` under exact Node `22.22.2` with separate evidence.
- Run CodeRabbit against the implementation range; fix all valid critical/warning findings and
  rerun until no such findings remain.
- Confirm `git diff --check`, intended-file scope, and a clean worktree after commit.
- Push only verified commits, then perform the final thread-aware PR audit.

The rollout gate is a one-time quiescent migration from the reusable lock formats. If the
hard-link probe or migration fails, the webhook server and manual publisher do not start.
