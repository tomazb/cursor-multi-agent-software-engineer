# Roadmap

The roadmap prioritizes a trustworthy local workflow before hosted autonomy.

## v0.1 — Local foundation

Status: implemented in the initial repository bootstrap.

- TypeScript CLI and strict domain contracts.
- Explicit workflow state machine.
- File-based run and artifact store.
- Configurable role models and bounded fallbacks.
- Cursor CLI runtime.
- Optional Cursor SDK runtime.
- Mock runtime and workflow tests.
- Brainstorm and design approval gates.
- Deterministic quality commands.
- Independent read-only verifier.
- PR comment scope classification and resolution loop.
- Workspace fingerprint enforcement.
- Cursor plugin manifest and skill.
- PRD, architecture, operations, security, GitHub design, roadmap, and ADRs.

## v0.2 — Local hardening and git isolation

Status: implemented.

- `RunStore` interface and atomic file writes with lock/version checks.
- Artifact digest validation on every read.
- Attempt-specific immutable artifact history.
- Persist repository remote, branch, base SHA, head SHA, and workspace fingerprint.
- Worktree/branch manager with unexpected branch-movement rejection.
- Deterministic commit creation and change-scope checks.
- SHA-bound quality/verification evidence that invalidates when head SHA changes.
- Pass verifier defects explicitly back to the builder.
- Strict validation of all required terminal markers.
- Redaction of common secrets in artifacts and logs.
- Prompt transport through stdin where Cursor CLI supports it.
- Budget and timeout controls.
- Retry-from-failed and supersede-run operations.
- JSON schemas for configuration and artifacts.
- Packaged CLI release and lock file.

## v0.3 — GitHub App pilot

- GitHub App installation and webhook service.
- Signature verification and delivery deduplication.
- PR/head-SHA-bound run association.
- Read-only MASWE check runs.
- Authenticated approval comments or labels.
- Deterministic branch push and PR creation.
- Review comment ingestion and evidence replies.
- Human-approved resolver edits for pilot repositories.
- Check invalidation on new commits.
- GitHub Actions artifact ingestion.

## v0.4 — Durable control plane

- PostgreSQL run/event store.
- Object storage for immutable artifacts.
- Queue, worker leases, retries, and transactional outbox.
- REST API and MCP server.
- Cursor cloud and self-hosted SDK runtimes.
- Team/repository policy hierarchy.
- Service-account and secret-manager integration.
- Structured logs, metrics, traces, cost, and token accounting.
- Web dashboard for approvals, artifacts, and intervention.

## v0.5 — Safe automated PR resolution

- File and change-scope policy engine.
- Risk categories for reviewer comments.
- Automatic low-risk in-scope resolutions.
- Fresh verifier and CI checks on every head SHA.
- Thread resolution after evidence gates.
- Merge-queue awareness.
- Reviewer disagreement and requirement-change workflows.
- Audit export and retention policies.

## v1.0 — Production release

Exit criteria:

- Multi-tenant isolation review and external security assessment.
- At-least-once event processing with idempotent side effects.
- Exact model and git provenance where providers expose it.
- Zero silent fallback in fail-closed policy.
- Reliable recovery from worker, provider, and GitHub outages.
- Supported database migrations and upgrade policy.
- Signed releases, pinned dependencies, and SBOM.
- Documented SLOs, incident response, backup, and disaster recovery.
- Pilot reliability and cost targets met across multiple repositories.

## Research backlog

- Automated acceptance-criteria traceability from design to tests and code.
- Differential verification using two independent verifier models for high-risk changes.
- Formal policy language for allowed files, commands, APIs, and data classes.
- Secure execution sandboxes with network and filesystem capability controls.
- Automated UI/browser evidence capture.
- Cross-repository plans and coordinated PRs.
- Model quality/cost routing based on task risk while preserving explicit user policy.
