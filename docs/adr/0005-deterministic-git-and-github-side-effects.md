# ADR-0005: Keep git publishing and GitHub side effects deterministic

- Status: Accepted (local subset implemented in v0.2)
- Date: 2026-07-22

## Context

Models are useful for code and semantic review but branch creation, commits, pushes, checks, approvals, comment replies, thread resolution, and merge gates require exact, idempotent behavior and least privilege.

## Decision

Models may edit an isolated workspace and propose messages. Deterministic integration code owns branch/worktree setup, commit creation, pushing, PR creation, check runs, replies, thread resolution, and merge readiness. GitHub events enter through an authenticated adapter and become orchestrator events only after validation and authorization.

## Consequences

### Positive

- Side effects are reproducible, auditable, and retryable.
- Webhook replay can be handled with idempotency keys.
- A model cannot directly mark its own work merge-ready.
- GitHub permissions can be narrowly assigned to the app.

### Negative

- Requires a GitHub App and control-plane work beyond the local MVP for remote GitHub side effects.
- Some convenient agent-native PR features are intentionally not used as authoritative operations.
- Deterministic publishing code must handle conflicts and rate limits.

## Local progress (v0.2)

`src/git-workspace.ts` owns local branch/worktree creation, deterministic commits, and change-scope
checks.

## GitHub progress (v0.3 Phase A)

`src/github/` owns authenticated webhook intake and SHA-bound Checks API publication without
Contents, pull-request, or comment writes. File-backed GitHub mutations are serialized through
immutable, hash-addressed ticket journals. Exact request bytes are authenticated and normalized;
only the normalized event envelope and raw-body digest are file/directory-synced before an HTTP 202
acknowledgement. One lease worker recovers pending work before listener readiness, while a
simultaneous manual publisher uses a separate per-PR publication journal and never reclaims inbox
leases. Check identity covers the complete repository/PR/head/name/attempt key, and reconciliation
is bounded and paginated. Tokens request only Checks write, Pull requests read, and Metadata read.
Push, PR creation, comment replies, and thread resolution remain Phase B.
