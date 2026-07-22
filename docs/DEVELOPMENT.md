# Development guide

## Toolchain

- Node.js 22.15+
- TypeScript 5.8+
- Node built-in test runner
- No required runtime dependencies
- Optional `@cursor/sdk` peer dependency

## Setup

```bash
npm install
npm run check
```

Useful commands:

```bash
npm run typecheck
npm test
npm run build
npm run dev -- help
npm run dev -- status --cwd /path/to/target
```

## Source boundaries

```text
src/domain.ts             stable contracts and data types
src/state-machine.ts      all legal state transitions
src/store.ts              local persistence and artifact hashing
src/orchestrator.ts       workflow policy and stage execution
src/prompt-builder.ts     prompt-template assembly
src/quality.ts            deterministic project command runner
src/git-snapshot.ts       read-only enforcement support
src/runtime.ts            adapter factory
src/runtimes/*            provider/runtime-specific implementation
src/cli.ts                user interface only
```

Do not import Cursor SDK from the core. Do not move transition decisions into prompts or runtime adapters.

## Testing strategy

### Unit tests

- Every legal and illegal transition.
- Configuration merge, validation, and environment overrides.
- Output marker parsing.
- Artifact hashing and replacement.
- Workspace fingerprint behavior.

### Workflow tests

Use `MockRuntime` and temporary directories to cover:

- Brainstorm and design gates.
- Successful build/CI/verify path.
- CI failure retry and exhaustion.
- Verifier failure retry and exhaustion.
- In-scope comment resolution loop.
- Out-of-scope human escalation.
- Cancellation and invalid commands.

### Adapter tests

Provider adapters should use contract tests and fake executables/SDK modules. Live provider tests belong in an opt-in integration suite and must not run on untrusted forks with credentials.

## Adding a runtime

1. Extend `RuntimeKind` in `src/domain.ts`.
2. Implement `AgentRuntime` in `src/runtimes/`.
3. Add it to `createRuntime`.
4. Implement diagnostics.
5. Preserve read-only enforcement or document a stronger preventive mechanism.
6. Return requested and actual model identity when available.
7. Add contract tests and operations documentation.

## Adding a workflow state or event

This is a schema change. Update together:

1. `WORKFLOW_STATES` or `WORKFLOW_EVENTS`.
2. Transition table.
3. Orchestrator public operation or automatic handler.
4. CLI/integration entry point.
5. Artifact contracts and prompt template if needed.
6. Unit and end-to-end tests.
7. Architecture diagram and PRD requirement.
8. Migration note for active runs.

## Prompt changes

Prompts are versioned behavior. A prompt PR should explain:

- Failure mode being addressed.
- Expected output contract changes.
- Compatibility with Superpowers.
- Evaluation cases.
- Whether old active runs can safely use the new prompt.

Do not rely on prose alone for critical policy. Add deterministic validation where possible.

## Coding conventions

- Strict TypeScript.
- ESM and explicit `.ts` relative imports in source; TypeScript rewrites them for build output.
- Avoid TypeScript constructs unsupported by Node's strip-only mode, such as parameter properties and enums, because tests execute source directly.
- Prefer small pure functions for policy decisions.
- Include actionable error messages.
- Keep user-provided text out of shell commands.
- Do not add a dependency when a small, well-tested standard-library implementation is sufficient.

## Release process

Until automated releases exist:

1. Update PRD/architecture/ADRs for behavioral changes.
2. Update `CHANGELOG.md`.
3. Run `npm run check` on supported platforms.
4. Review generated `dist/` locally but do not commit it unless distribution strategy changes.
5. Tag `vX.Y.Z` after merge.
6. Publish a GitHub release with migration and known-limitations notes.
7. Add npm or plugin marketplace publishing only after package naming and signing policy are decided.

## Definition of done

- Acceptance criteria are explicit.
- Code and tests are implemented.
- Type check, tests, and build pass.
- Security and failure behavior are reviewed.
- User and operations documentation is current.
- No model claims are accepted without deterministic or verifier evidence.
