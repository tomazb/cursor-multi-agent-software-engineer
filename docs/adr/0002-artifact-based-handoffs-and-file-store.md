# ADR-0002: Use artifact-based handoffs and a file store for v0.1

- Status: Accepted (amended by v0.2 hardening)
- Date: 2026-07-22

## Context

Specialized agents need clear inputs and inspectable outputs. Conversation history creates hidden coupling and cannot be reliably resumed. A database would improve concurrency but raises deployment cost before the workflow is proven.

## Decision

Every stage produces a named Markdown artifact. Persist run state, configuration snapshot, events, artifact references, and hashes below `.maswe/runs/<run-id>/`. Assume one writer per run in v0.1.

## Consequences

### Positive

- Simple local setup and debugging.
- Human-readable handoffs.
- Easy backup and inspection.
- Contracts can later map to database/object storage records.

### Negative

- Local paths and data retention need care.
- Digests are validated but not cryptographically signed.

## Follow-up

v0.2 extracted the `RunStore` interface, added optimistic `version` checks, atomic writes, digest revalidation on read, and attempt-scoped immutable artifact history. Implement SQLite and PostgreSQL stores before distributed workers.
