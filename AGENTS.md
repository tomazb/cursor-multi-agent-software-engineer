# Agent instructions

This repository implements a deterministic multi-agent software delivery orchestrator. Preserve the boundary between orchestration and model behavior.

## Required engineering behavior

- Read `docs/PRD.md`, `docs/ARCHITECTURE.md`, and relevant ADRs before changing architecture.
- Use Superpowers skills when available: brainstorming for product decisions, writing-plans for design, test-driven-development for implementation, and verification-before-completion before claiming success.
- Write or update tests for every behavioral change.
- Run `npm run check` before completion.
- Never weaken approval, read-only, model, scope, or verification policies merely to make a test pass.
- Keep runtime-specific code in `src/runtimes/`; core workflow code must not import a provider SDK directly.
- Keep state transitions centralized in `src/state-machine.ts`.
- Persist handoffs through artifacts; do not add hidden cross-agent conversation state.
- Do not store credentials, model responses containing secrets, or repository tokens in committed files.

## Definition of done

A change is complete only when requirements are mapped to tests, tests pass, type checking passes, the build succeeds, documentation is updated, and no unrelated files are changed.
