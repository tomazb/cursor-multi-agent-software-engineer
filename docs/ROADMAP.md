# Roadmap

The roadmap prioritizes a trustworthy local workflow before hosted autonomy.

The current implementation is Cursor-first. The repository and product scope now target a future harness-neutral MASWE control plane under Issues #31 and #32; planned support must not be read as implemented support.

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

Status: **Phase A (read-only checks) implemented**; Phase B remaining on Issue #3 and gated by Issue #27.

### Phase A (done)

- GitHub App webhook service in `src/github/` (`maswe github-webhook`).
- Signature verification and `X-GitHub-Delivery` deduplication.
- PR/head-SHA-bound run association (`RunRecord.github` + association index).
- Read-only MASWE check runs (four named checks; review-resolution stays `neutral`).
- Check invalidation on new head SHA.
- Integration tests for replay, forged signature, stale SHA, rate limit, and installation suspension.

### Phase B (remaining)

- Authenticated approval comments or labels.
- Deterministic branch push and PR creation.
- Review comment ingestion and evidence replies.
- Human-approved resolver edits for pilot repositories.
- GitHub Actions artifact ingestion.
- Optional monorepo extraction to `apps/` / `packages/` with the v0.4 control plane.

Issue #34 must be completed or explicitly dispositioned before Phase B relies on repository identity across renames.

## Multi-harness execution programme

Status: owner-approved direction under Issue #31; architecture publication governed by Issue #32.

Required order:

1. Complete Issue #27 and revalidate `main` at the accepted post-hardening SHA.
2. Publish and approve the MH-00 architecture through Issue #32.
3. Complete the remaining Issue #3 Phase B before multi-harness runtime implementation.
4. Prove harness-neutral local contracts and a Cursor-preserving registry refactor before adding external harnesses.
5. Add external harnesses as read-only workers before granting write authority.
6. Freeze distributed worker schemas only after local contracts and initial adapter conformance evidence exist.

Target harnesses include Cursor, Claude Code, Codex CLI, GitHub Copilot CLI, and OpenCode. Only Cursor CLI, optional Cursor SDK, and mock are implemented today.

## v0.4 — Durable multi-harness control plane

Entry gates:

- Issue #27 completed and post-hardening `main` revalidated at an exact SHA.
- Issue #32 approved and merged.
- Remaining Issue #3 Phase B completed before multi-harness runtime implementation.
- Harness-neutral local contracts and the Cursor-preserving registry refactor proven.
- Initial external read-only adapter conformance evidence available before distributed worker schemas are frozen.

Planned capabilities:

- PostgreSQL run/event store.
- Object storage for immutable artifacts.
- Queue, worker leases, retries, and transactional outbox.
- REST API and MCP server.
- Capability-negotiated local, cloud, and self-hosted harness adapters.
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
- Reliable recovery from worker, provider, harness, and GitHub outages.
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
