# Changelog

All notable changes will be documented in this file.

The project follows semantic versioning once a public release process is established.

## [Unreleased]

### Planned

- GitHub App webhooks, check runs, and review-thread automation.
- SQLite and PostgreSQL stores.
- Remote control-plane API and MCP server.

## [0.2.0] - 2026-07-22

### Added

- `RunStore` interface with atomic file writes, lock files, and optimistic `version` checks.
- Artifact digest revalidation on every read and attempt-scoped immutable artifact history.
- Persisted workspace provenance: remote, base SHA, head SHA, branch, fingerprint, optional worktree path.
- Git worktree/branch manager with deterministic commits, change-scope checks, and unexpected branch-movement rejection.
- SHA-bound quality/verification evidence; new commits invalidate prior verification before merge-ready.
- Strict terminal marker validation for every role and classifier output.
- Explicit verifier defect artifacts passed back into builder prompts.
- Secret redaction for artifacts and quality command output.
- Cursor CLI stdin prompt transport (argv fallback retained).
- Command/role/run timeout budgets.
- `maswe retry` and `maswe supersede` recovery commands.
- JSON schemas for configuration and run records under `schemas/`.
- Packaged CLI dry-run verification in CI via `npm ci` and `npm pack --dry-run`.

### Changed

- Default policy enables isolated worktrees and stdin prompt transport.
- Builder prompt includes `{{VERIFIER_DEFECTS}}` on verification retries.

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
