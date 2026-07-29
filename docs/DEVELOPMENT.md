# Development guide

## Toolchain

- Canonical Node.js baseline: exact `24.18.0` from `.nvmrc`
- Supported Node.js range: `>=22.22.2 <23 || >=24.18.0 <25`
- Blocking compatibility floor: exact `22.22.2`
- TypeScript 7.0+
- Node built-in test runner
- No required runtime dependencies
- Optional `@cursor/sdk` peer dependency

NVM is an optional contributor selection mechanism, not a MASWE product dependency. Other version managers, containers, and system packages are supported when they provide a Node binary inside the bounded range. Node 23, Node 25, Node 26+, Node 22 below `22.22.2`, and Node 24 below `24.18.0` are unsupported exploratory runtimes.

## Setup

With NVM:

```bash
nvm install
nvm use
npm install
npm run check
```

Without NVM, select a supported Node binary using your environment manager, then run the same npm commands. `.npmrc`, package engines, repository scripts, and the CLI entry boundary reject unsupported versions with `MASWE_UNSUPPORTED_NODE_VERSION`. The guard does not install or switch Node automatically.

Useful commands:

```bash
npm run verify:node
npm run typecheck
npm test
npm run build
npm run dev -- help
npm run dev -- status --cwd /path/to/target
```

Public npm scripts validate the active Node runtime before substantive work. `npm run check` performs one explicit guard and then the raw typecheck, test, and build phases without recursively repeating the guard.

For exact-head evidence, record and label each runtime separately:

```bash
command -v node
node --version
node -p 'process.execPath'
npm --version
```

When NVM is used, also record:

```bash
nvm current
nvm which current
```

Do not combine Node 24 canonical-baseline commands and Node 22 compatibility-floor commands into one unlabeled result. A successful command on an unsupported runtime is not support evidence.

Issue #11 lock-journal checks use real child processes and parent-controlled IPC barriers:

```bash
node --experimental-strip-types test/issue11-lock-journal.test.ts
node --experimental-strip-types test/issue11-lock-contention.test.ts
MASWE_ISSUE11_ALLOCATION_ITERATIONS=25 \
  node --experimental-strip-types --test-name-pattern='allocation contention repetition' \
  test/issue11-lock-contention.test.ts
MASWE_ISSUE11_RELEASE_ITERATIONS=100 \
  node --experimental-strip-types --test-name-pattern='owner recovery successor repetition' \
  test/issue11-lock-contention.test.ts
```

The environment variables select iteration counts; watchdog timeouts only fail hangs and never
advance a race. These commands are native Linux coverage on CI. Do not label them Windows-native
without running the exact head on local NTFS.

## Source boundaries

```text
src/domain.ts             stable contracts and data types
src/state-machine.ts      all legal state transitions
src/store.ts              RunStore interface and atomic file persistence
src/lock-journal.ts       immutable local ticket claims, releases, and recovery
src/orchestrator.ts       workflow policy and stage execution
src/prompt-builder.ts     prompt-template assembly
src/quality.ts            deterministic project command runner
src/git-snapshot.ts       fingerprint and git identity helpers
src/git-workspace.ts      worktree/branch/commit/scope management
src/markers.ts            terminal marker validation
src/redaction.ts          secret masking for artifacts and logs
src/process.ts            process capture with timeouts
src/node-version.ts       pure bounded Node policy and CLI assertion
src/runtime.ts            adapter factory
src/runtimes/*            provider/runtime-specific implementation
src/cli.ts                guarded user interface entry point
scripts/verify-node-version.mjs dependency-free install/script guard
schemas/*                 JSON schemas for config and run records
```

Do not import Cursor SDK from the core. Do not move transition decisions into prompts or runtime adapters.

## Node runtime policy changes

Changes to `.nvmrc`, the supported range, compatibility floor, or guard behavior are governed support-contract changes. Update together:

1. `.nvmrc` canonical exact version.
2. `package.json` and lockfile root `engines.node`.
3. Standalone and TypeScript policy constants and boundary tests.
4. Canonical, compatibility, and unsupported-negative CI jobs.
5. README, development, operations, architecture, agent guidance, and changelog.
6. Exact-head validation under every supported blocking target.

Adding a later Node major requires explicit qualification; it must not become supported merely because a shell, runner image, or floating CI alias changes.

## Testing strategy

### Unit tests

- Every legal and illegal transition.
- Configuration merge, validation, and environment overrides.
- Output marker parsing.
- Artifact hashing and replacement.
- Workspace fingerprint behavior.
- Node runtime boundary parsing, metadata synchronization, script order, and zero-side-effect CLI rejection.

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

### Child Node processes

A child that must use the same runtime as its parent must be launched through `process.execPath`, not a literal PATH-selected `node`. The installed CLI shebang remains `#!/usr/bin/env node` because PATH selection is the intended launch contract; the entry guard then validates the selected runtime. Intentional PATH/shebang fixtures and user-configured external commands must remain explicitly classified.

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
3. Run `npm run check` separately on exact Node `24.18.0` and `22.22.2`.
4. Run the exact unsupported Node `25.9.0` rejection check without classifying it as product validation.
5. Review generated `dist/` locally but do not commit it unless distribution strategy changes.
6. Tag `vX.Y.Z` after merge.
7. Publish a GitHub release with migration and known-limitations notes.
8. Add npm or plugin marketplace publishing only after package naming and signing policy are decided.

## Definition of done

- Acceptance criteria are explicit.
- Code and tests are implemented.
- Type check, tests, and build pass on both blocking supported Node targets.
- Unsupported-runtime fail-fast behavior is proven before side effects.
- Security and failure behavior are reviewed.
- User and operations documentation is current.
- No model claims are accepted without deterministic or verifier evidence.
