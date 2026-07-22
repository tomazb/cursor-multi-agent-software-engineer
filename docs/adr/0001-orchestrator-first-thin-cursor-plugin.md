# ADR-0001: Use an orchestrator-first architecture with a thin Cursor plugin

- Status: Accepted
- Date: 2026-07-22

## Context

The product must coordinate multiple models across brainstorming, design, implementation, verification, and PR review over periods longer than one chat session. Cursor plugins are excellent packaging and interaction surfaces, but a model conversation is not a reliable durable state machine.

## Decision

Build the authoritative workflow as a standalone TypeScript orchestration core and CLI. Package a thin Cursor plugin that exposes skills and guides users into the orchestrator. Keep editor experience separate from durable state and policy.

## Consequences

### Positive

- Runs survive editor and process restarts.
- State transitions and approvals are testable.
- The system can later run in CI or a hosted service.
- Cursor can be replaced or supplemented through runtime adapters.
- Plugin updates do not migrate run storage.

### Negative

- More components than a prompt-only plugin.
- Local installation currently requires building/linking the CLI.
- The plugin cannot provide a complete custom visual UI without a future extension or web app.

## Rejected alternatives

- **Plugin-only parent agent:** too dependent on conversational context and implicit transitions.
- **GitHub Actions only:** poor local interaction and awkward human design approvals.
- **Immediate hosted service:** unnecessary operational complexity before workflow contracts are validated.
