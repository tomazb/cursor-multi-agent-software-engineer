# ADR-0004: Isolate runtimes and configure models by role

- Status: Accepted
- Date: 2026-07-22

## Context

Cursor CLI is immediately accessible, Cursor SDK enables programmatic local/cloud agents, and provider/model availability changes over time. Hardcoding one execution path or model would make the workflow brittle.

## Decision

Define a small `AgentRuntime` interface and implement Cursor CLI, Cursor SDK, and mock adapters. Store model selection, fallbacks, reasoning metadata, and permissions in project configuration and snapshot them into each run.

Default role preferences are:

- Brainstormer: Grok 4.5.
- Designer: Claude Fable 5 with Opus 4.8 fallback.
- Builder: Grok 4.5.
- Verifier and resolver: GPT-5.6 Sol High.

Exact slugs remain user configuration and must be checked against the current account catalogue.

## Consequences

### Positive

- Models can change without state-machine rewrites.
- Runtime-specific failures remain isolated.
- Tests do not need live model access.
- The SDK can evolve behind its adapter.

### Negative

- Capabilities differ across runtimes.
- Actual model identity is not always exposed.
- Reasoning effort lacks one universal provider parameter.
- Adapter contract may need expansion for durable cloud agents and artifacts.
