# Changelog

All notable changes will be documented in this file.

The project follows semantic versioning once a public release process is established.

## [Unreleased]

### Added

- Version-3 per-run immutable ticket journals for data, administrative, and administrative-recovery
  locking. Claims and exact-target releases use canonical digest-bound records and atomic
  no-clobber hard-link publication.
- Deterministic real-process barrier tests for ticket contention, crash boundaries, exact release
  convergence, recovery ordering, and late-owner/successor safety.
- Focused model-catalogue grammar and smoke-model allowlist regression tests.

### Changed

- `maswe unlock` and `maswe unlock-admin` now publish an exact immutable release rather than
  deleting a reusable owner pathname. Force remains an explicit operator-quiescence assertion,
  not process fencing.
- PR #10 regular-file locks are read as virtual ticket zero during a quiescent upgrade. New code
  never writes or deletes the legacy path; mixed old/new execution and rollback after v3
  publication are unsupported.
- Preferred exact smoke-model IDs must now be present in the live catalogue and satisfy the same
  approved-family and effort policy as automatic selection; invalid exact preferences fail closed
  without falling back. A literal allowlist token remains available only as a bounded family hint.
- Cursor catalogue parsing now accepts only documented row structures, rejects single-space
  leading-ID prose, and reports malformed row candidates distinctly when no valid IDs remain.

### Planned

- GitHub App webhooks, check runs, and review-thread automation.
- SQLite and PostgreSQL stores.
- Remote control-plane API and MCP server.

## [0.2.0] - 2026-07-22

### Added

- `RunStore` interface with atomic file writes, exclusive data locks (temp+`link` complete `{pid,owner,at}` records), a dedicated `.admin.lock` serializing acquire/unlock, **no automatic stale reclaim** for data or admin locks (use `maswe unlock` / `maswe unlock-admin`), and optimistic `version` checks.
- Artifact digest revalidation on every read and attempt-scoped immutable artifact history.
- Persisted workspace provenance: remote, base SHA, head SHA, branch, fingerprint, optional external worktree path.
- Git worktree/branch manager with deterministic commits (input/output SHA provenance), change-scope checks (NUL-delimited path parsing), unexpected branch-movement rejection, and worktree cleanup on terminal runs.
- Strict final-line terminal marker parsing with typed results; conflicting/duplicate/embedded markers fail closed.
- SHA-bound quality/verification evidence; new commits invalidate prior verification before merge-ready.
- Explicit verifier defect artifacts passed back into builder prompts.
- Secret redaction for artifacts and quality command output.
- Cursor CLI stdin prompt transport with doctor probe (argv fallback retained).
- Command/role/run timeout budgets.
- `maswe retry` and `maswe supersede` recovery commands.
- v0.1 run-record migration (synthesize `version` / attempt metadata) with full config assertion after migration, or fail-closed on invalid records.
- JSON schemas for configuration and run records under `schemas/`.
- Packaged CLI dry-run verification in CI via `npm ci` and `npm pack --dry-run`.
- Strict separation of project model resolution (`resolveProjectModels`) vs existing-run exact validation (`validatePersistedExactModel`); structured fail-closed Cursor catalogue row parsing; approved-family smoke model selection.

### Changed

- Default policy enables isolated worktrees and stdin prompt transport.
- Builder prompt includes `{{VERIFIER_DEFECTS}}` on verification retries.
- Cursor `stream-json` extraction accepts only terminal `type: "result"` events; stderr is never successful assistant content.
- Doctor probe cleanup is identity-based (branch + worktree) and runs in `finally` after partial creation failures.
- Logical model resolution requires matching effort suffixes (`-high`/`-medium`/`-low`); missing effort fails closed.
- Read-only workspace fingerprints include authoritative `.maswe` run/artifact state (locks/`*.tmp` excluded) for both Git and non-Git working directories; non-Git no longer returns the invariant `not-a-git-repository` fingerprint sentinel.
- Project-level model resolution errors identify the failing role.
- `runtime.outputFormat` contracts accept `stream-json` in TypeScript types and `schemas/config.schema.json`.
- Shell command timeouts terminate the process tree (POSIX process group / Windows `taskkill /T`) and bound Promise settlement when descendants hold pipes.
- Workspace remote provenance strips URL userinfo before persistence; SCP-style `git@host:path` remotes remain intact.
- Git-plane fingerprint probes pathspec-exclude `.maswe/` explicitly and no longer rely on `.git/info/exclude` for that isolation.

## [0.1.0] - 2026-07-22

### Added

- Product requirements, architecture, security, operations, roadmap, and ADRs.
- TypeScript workflow state machine and file-based event/artifact store.
- Configurable brainstorming, design, build, verify, and PR resolver roles.
- Cursor CLI, optional Cursor SDK, and mock runtime adapters.
- Human approval gates and fail-closed transition policy.
- Deterministic quality command runner.
- Read-only workspace fingerprint enforcement.
- PR comment classification, scoped resolution, CI rerun, and fresh verification loop.
- Cursor plugin manifest and `maswe` skill.
- Unit and end-to-end workflow tests plus GitHub Actions CI.
