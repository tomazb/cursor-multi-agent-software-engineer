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

`src/git-workspace.ts` owns local branch/worktree creation, deterministic commits, and change-scope checks. Push, PR creation, check runs, and webhook ingestion remain v0.3+.
