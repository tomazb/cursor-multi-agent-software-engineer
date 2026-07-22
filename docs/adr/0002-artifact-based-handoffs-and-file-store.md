# ADR-0002: Use artifact-based handoffs and a file store for v0.1

- Status: Accepted
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

- No atomic multi-process concurrency.
- Artifact replacement loses prior file contents unless backed up.
- Local paths and data retention need care.
- Hashes are recorded but not yet validated or signed.

## Follow-up

Extract a store interface, add version checks and atomic writes, then implement SQLite and PostgreSQL stores before distributed workers.
