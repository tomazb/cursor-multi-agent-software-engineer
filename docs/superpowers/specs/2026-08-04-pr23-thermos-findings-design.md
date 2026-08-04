# PR 23 Thermos Findings Resolution Design

## Status

Approved for planning on 2026-08-04.

## Context

Thermos review of PR #23 identified three reproducible defects in the governed Node runtime change:

1. `scripts/verify-node-version.mjs` can skip its assertion when its executable entry path contains a symlink because program detection compares a resolved module URL with an unresolved argument path.
2. Focused Node-policy tests can lose buffered child-process output under `node:test`, even though the full suite and current GitHub Actions run pass.
3. `docs/PRD.md` still promises unbounded Node.js `22.15+` portability, contradicting the approved bounded runtime contract, and `docs/DEVELOPMENT.md` omits the PRD from its policy-update checklist.

The approved Node policy remains unchanged: canonical Node `24.18.0`, compatibility floor `22.22.2`, and supported range `>=22.22.2 <23 || >=24.18.0 <25`.

## Goals

- Make standalone guard execution invariant to symlinked entry paths.
- Make focused child-process assertions deterministic on supported Node runtimes.
- Synchronize the authoritative PRD and maintenance checklist with the approved runtime contract.
- Preserve dependency-free preinstall enforcement and the existing TypeScript/standalone synchronization model.

## Non-goals

- Deduplicating `src/node-version.ts` and `scripts/verify-node-version.mjs`; the approved design explicitly permits synchronized duplicate policy surfaces with deterministic drift tests.
- Changing the supported Node versions or adding another runtime line.
- Refactoring the CLI bootstrap or changing orchestration behavior.
- Weakening install, script, CLI, CI, or verification gates.

## Design

### Canonical executable-entry detection

Keep `scripts/verify-node-version.mjs` as the dependency-free, dual-use module. Convert the module URL to a filesystem path, resolve the real path of both that module file and `process.argv[1]`, and compare the canonical paths. A direct path, a file symlink, or a symlinked directory component therefore selects program mode consistently.

If canonicalization of a present entry argument fails, do not silently treat the module as imported. Emit a bounded diagnostic and exit non-zero so the guard remains fail closed. Ordinary imports used by policy tests still have no executable entry argument match and do not auto-run the assertion.

### Deterministic child-probe output

The affected tests spawn short-lived Node processes and immediately publish machine-readable results. Replace buffered `process.stdout.write` and `process.stderr.write` calls in those inline probes with `writeSync(1, ...)` and `writeSync(2, ...)`, following the existing pattern in `test/node22-child-output.test.ts`. Production behavior does not change.

### Contract documentation

Replace PRD NFR-4's `Node.js 22.15+` requirement with the exact bounded support expression and the canonical/compatibility roles. Add `docs/PRD.md` to the governed runtime-policy update checklist in `docs/DEVELOPMENT.md` so future support changes cannot omit the product requirement source of truth.

## Testing

Use test-driven development for the guard defect:

1. Add a regression that executes a symlink to the standalone guard with an injected unsupported version and expects `MASWE_UNSUPPORTED_NODE_VERSION` plus exit code 1.
2. Confirm the regression fails against the current lexical comparison.
3. Implement canonical entry detection and confirm the regression passes.

For the focused-suite defect, use the already failing exact command as the red state. Apply synchronous descriptor writes, then verify the focused Node-policy command passes repeatedly. Documentation changes require review against the approved literal contract; existing metadata synchronization tests continue to protect executable policy surfaces.

Final verification runs `npm run check`, `npm run pack:dry`, the focused Node-policy suite, `git diff --check`, and a clean scope/status audit. Node 24 evidence is canonical; existing exact-head GitHub Actions remains the Node 22 compatibility evidence unless Node 22 is rerun locally.

## Expected files

- `scripts/verify-node-version.mjs`
- `test/node-version-policy.test.ts`
- `test/node-version-scripts.test.ts`
- `docs/PRD.md`
- `docs/DEVELOPMENT.md`
- `docs/superpowers/specs/2026-08-04-pr23-thermos-findings-design.md`
