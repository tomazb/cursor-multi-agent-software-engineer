# Roadmap

The roadmap prioritizes a trustworthy local workflow before hosted autonomy.

The current implementation is Cursor-first. The product now targets a future harness-neutral MASWE control plane under Issues #31 and #32; planned support is not implemented support.

## v0.1 — Local foundation

Status: implemented.

- TypeScript CLI and strict domain contracts.
- Explicit workflow state machine.
- File-based run and artifact store.
- Role-specific models and bounded fallbacks.
- Cursor CLI, optional Cursor SDK, and mock runtimes.
- Brainstorm and design approval gates.
- Deterministic quality commands.
- Independent read-only verifier.
- PR comment classification and resolution loop.
- Workspace fingerprint enforcement.
- Cursor plugin and Superpowers integration.

## v0.2 — Local hardening and git isolation

Status: implemented.

- Atomic run storage with lock/version checks.
- Artifact digest validation and immutable attempt history.
- Repository, branch, base SHA, head SHA, and fingerprint provenance.
- Isolated worktrees, deterministic commits, and scope checks.
- SHA-bound quality and verification evidence.
- Strict terminal markers, secret redaction, budgets, timeouts, and recovery controls.
- JSON schemas and packaged CLI validation.

## v0.3 — GitHub App pilot

Status: **Phase A implemented; Phase B remaining on Issue #3 and gated by Issue #27.**

### Phase A — implemented

- Authenticated webhook ingress and durable delivery deduplication.
- Typed event normalization and PR/run association.
- SHA-bound read-only MASWE checks.
- Stale-head invalidation, rate-limit handling, and authorization suspension.

### Phase B — planned

- Authenticated artifact-bound approvals.
- Deterministic branch push and PR creation.
- Review ingestion and evidence replies.
- Human-approved resolver edits.
- GitHub Actions evidence and artifact ingestion.

Issue #34 must be completed or explicitly dispositioned before Phase B relies on repository identity across renames.

## Multi-harness programme

Status: approved direction under Issue #31; architecture publication governed by Issue #32.

Required sequence:

1. Complete correctness hardening and revalidate `main`.
2. Publish and approve the multi-harness architecture.
3. Complete GitHub Phase B before multi-harness runtime implementation.
4. Introduce harness-neutral domain, route, capability, and attempt contracts.
5. Refactor mock and Cursor execution through the registry without observable behavior drift.
6. Add external harnesses as read-only workers first.
7. Add governed external writers only after read-only conformance is proven.
8. Freeze distributed worker schemas only after local contracts and adapter evidence exist.

Target harnesses include Cursor, Claude Code, Codex CLI, GitHub Copilot CLI, and OpenCode. Only Cursor CLI, optional Cursor SDK, and mock are implemented today.

## v0.4 — Durable multi-harness control plane

Entry gates:

- Issue #27 completed and post-hardening `main` revalidated.
- Issue #32 approved and merged.
- Issue #3 Phase B completed before multi-harness runtime implementation.
- Harness-neutral local contracts and the Cursor-preserving registry refactor proven.
- Initial external read-only adapter conformance evidence available.

Planned capabilities:

- PostgreSQL run/event store.
- Immutable object storage.
- Queue, worker leases, retries, and transactional outbox.
- REST API and MCP control surface.
- Capability-negotiated local, cloud, and self-hosted harness adapters.
- Team/repository policy hierarchy.
- Service-account and secret-manager integration.
- Structured logs, metrics, traces, cost, and token accounting.
- Web dashboard for approvals and intervention.

## v0.5 — Safe review resolution

- File and change-scope policy engine.
- Risk categories for reviewer comments.
- Governed low-risk resolution.
- Fresh CI and verifier evidence on every head SHA.
- Thread resolution, merge-queue awareness, and disagreement workflows.

## v1.0 — Production release

Exit criteria include multi-tenant isolation review, at-least-once idempotency, exact provenance where exposed, no silent fallback, reliable outage recovery, supported migrations, signed releases, SBOM, SLOs, incident response, backup, and disaster recovery.

## Research backlog

- Acceptance-criteria traceability from design to tests and code.
- Differential verification for high-risk changes.
- Formal policy language for files, commands, APIs, and data classes.
- Secure execution sandboxes.
- Automated UI/browser evidence capture.
- Cross-repository plans and coordinated PRs.
- Risk-aware model quality and cost routing.
