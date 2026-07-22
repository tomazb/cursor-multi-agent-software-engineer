# Product Requirements Document

## Product

**Cursor Multi-Agent Software Engineer (MASWE)**

## Status

- Version: 0.2 local hardening
- Date: 2026-07-22
- Owner: repository maintainer
- Intended first users: individual software engineers and small teams using Cursor and GitHub

## Executive summary

MASWE is a durable orchestration layer for software development performed by multiple specialized coding models. It assigns discovery, specification, implementation, verification, and pull-request resolution to separate roles while deterministic software owns state transitions, approvals, quality commands, permissions, retry limits, and audit records.

The first usable release is a local TypeScript CLI with Cursor CLI and Cursor SDK runtime adapters. The long-term product adds a GitHub App, remote control plane, durable database, and team policy administration without changing the role or artifact contracts.

## Problem statement

Coding agents are effective at isolated tasks but production software delivery has failure modes that a single conversation does not reliably control:

1. The model starts implementing before the problem and acceptance criteria are clear.
2. Long conversations accumulate assumptions, stale context, and self-confirming reasoning.
3. The same model that built a change verifies its own claims.
4. A provider or editor can silently use a different model than the one selected.
5. PR comments can expand scope, change requirements, or cause unrelated edits.
6. Test, build, and merge readiness can be asserted without reproducible evidence.
7. A multi-day workflow cannot depend on one editor tab remaining alive.
8. Teams lack a durable record of who approved what, which model acted, and which code state was verified.

## Product vision

A developer should be able to submit a feature request and receive an implementation that has passed explicit product and technical approval gates, deterministic quality checks, independent verification, and controlled PR review resolution—with every handoff inspectable and every model configurable.

## Target users

### Primary persona: senior individual contributor

Needs high-quality agent assistance but wants to retain control over requirements and architectural decisions. Works in Cursor, uses GitHub PRs, and is comfortable with a CLI.

### Secondary persona: engineering lead

Wants consistent delivery practices, model policies, auditability, cost controls, and standardized verification across repositories.

### Future persona: platform team

Needs a hosted control plane, GitHub App, service accounts, multi-tenant isolation, observability, and policy administration.

## Jobs to be done

- When I have an ambiguous feature idea, help me explore options before code is written.
- When an approach is approved, turn it into a complete, testable specification and plan.
- When implementation starts, use the preferred builder model and stay inside the approved scope.
- When implementation is reported complete, independently prove or reject that claim.
- When reviewers comment, resolve only requests that are within the approved change.
- When a run fails or pauses, let me inspect and resume it without losing context.
- When models or provider access changes, let me update configuration rather than rewrite the workflow.

## Goals

### G1 — Durable workflow

Persist run state, events, configuration snapshots, and artifacts outside model context so work survives process and editor restarts.

### G2 — Separation of duties

Use distinct role executions for brainstorming, design, building, verification, and PR resolution. A writer must not approve its own edits.

### G3 — Configurable model routing

Allow role-specific primary models, fallbacks, reasoning effort, permissions, and fail-closed model identity policy.

### G4 — Deterministic gates

Keep approvals, transition rules, tests, builds, and merge readiness in deterministic software.

### G5 — Evidence-based verification

Require an acceptance-criteria matrix, actual code inspection, command evidence, blocking findings, and a machine-readable verdict.

### G6 — Safe PR comment automation

Classify review comments before editing, escalate scope changes, re-run CI after edits, and use a fresh verifier.

### G7 — Cursor-native experience

Support Cursor CLI immediately, Cursor SDK through an adapter, Superpowers practices in stage prompts, and a Cursor plugin skill as the editor entry point.

## Non-goals for v0.1

- Fully autonomous requirement approval.
- Automatic merging.
- Hosting a multi-user control plane.
- Replacing GitHub Actions or a project's existing CI.
- General-purpose swarm or arbitrary recursive subagent framework.
- Guaranteeing provider model availability or pricing.
- Sandboxing untrusted repositories beyond the permissions supplied by Cursor and the local operating system.
- Creating pull requests or merging automatically (local branch/worktree/commit isolation is available in v0.2).

## Core principles

1. **Artifacts over conversation memory.** Every stage consumes approved files and repository state.
2. **One owner of orchestration.** Models perform stages; deterministic code decides what happens next.
3. **Human control at requirement boundaries.** Brainstorm and design approval are explicit by default.
4. **Independent verification.** The verifier is read-only and runs after deterministic checks.
5. **Fail closed.** Invalid transitions, model mismatches, excessive cycles, and permission violations stop the run.
6. **Minimal PR corrections.** Resolver edits must be the smallest correct response to an in-scope comment.
7. **Runtime portability.** Cursor-specific implementation stays behind an adapter.

## Functional requirements

### FR-1 — Project initialization

The CLI shall create a project-local `.maswe/config.json` without overwriting an existing file unless explicitly forced.

### FR-2 — Run creation

The user shall create a run with a title and request text or request file. The system shall snapshot effective configuration into the run record.

### FR-3 — State machine

The system shall support explicit states for discovery, approval, design, implementation, CI, verification, PR review, comment classification, resolution, merge readiness, completion, failure, and cancellation.

Invalid state/event combinations shall fail without changing state.

### FR-4 — Brainstorm stage

The brainstormer shall run read-only, inspect the request and repository as needed, compare viable approaches, identify risks and non-goals, propose acceptance criteria, and produce an approval artifact.

### FR-5 — Brainstorm approval

The workflow shall stop after brainstorming until a human records approval when `requireBrainstormApproval` is enabled. When explicitly disabled in trusted configuration, policy records the approval and proceeds automatically.

### FR-6 — Specification and design stage

The designer shall consume the approved brainstorm and produce product requirements, technical architecture, data flows, security considerations, acceptance criteria, test strategy, rollout strategy, and an ordered implementation plan.

### FR-7 — Design approval

The workflow shall stop after design until a human records approval when `requireDesignApproval` is enabled. When explicitly disabled in trusted configuration, policy records the approval and proceeds automatically.

### FR-8 — Builder stage

The builder shall receive only approved artifacts plus repository context, may modify the workspace, shall follow TDD practices, and shall produce a completion report with acceptance-criteria evidence and commands executed.

### FR-9 — Deterministic quality checks

The system shall execute configured commands sequentially outside the model and save stdout, stderr, exit codes, and durations. A failing command shall stop later commands in that quality pass and route the run back to building within policy limits.

### FR-10 — Independent verifier

The verifier shall run read-only after quality checks, inspect the actual repository, map acceptance criteria to evidence, and end with exactly `VERDICT: PASS` or `VERDICT: FAIL`.

A failed verdict shall route to the builder within the configured cycle limit.

### FR-11 — PR readiness

A successful CI and verifier pass shall produce `PR_READY`. v0.1 requires the user or external integration to create the PR and signal `PR_OPENED`.

### FR-12 — Review comment classification

A review comment shall first be evaluated read-only. The classifier shall end with `SCOPE: IN_SCOPE` or `SCOPE: OUT_OF_SCOPE`.

### FR-13 — Review comment resolution

Only in-scope comments may enter the resolver. The resolver may edit the workspace, after which deterministic quality checks and a fresh verifier shall run before returning to the existing PR review state.

### FR-14 — Human escalation

Out-of-scope or ambiguous comments shall enter `WAITING_FOR_HUMAN`. The system shall not edit code until a human resumes or updates the approved scope.

### FR-15 — Model policy

Each role shall have a configurable model. When fail-closed model fallback is enabled, the system shall use only the primary model and reject a reported mismatch. When disabled, configured fallback models may be attempted in order.

### FR-16 — Read-only enforcement

The system shall fingerprint git-tracked, staged, and untracked workspace state before and after read-only roles. A difference shall fail the run.

### FR-17 — Run inspection

The user shall list runs, inspect one run in human-readable or JSON form, and see state, timestamps, approvals, cycle counters, artifacts, and failures.

### FR-18 — Recovery controls

The user shall be able to resume an actionable run, resume human review, cancel a nonterminal run, mark merge readiness, and mark completion.

### FR-19 — Runtime adapters

The core shall support a mock runtime, Cursor CLI runtime, and optional Cursor SDK runtime behind a common interface.

### FR-20 — Environment diagnostics

The system shall provide a doctor command that checks runtime availability, credentials where applicable, and configured model slugs on a best-effort basis.

## Non-functional requirements

### NFR-1 — Reliability

- Run writes shall be atomic enough for a single local process and recoverable through JSON files.
- Automatic transition loops shall have a hard iteration limit.
- Retry loops shall be bounded by configuration.

### NFR-2 — Security

- Secrets shall come from environment variables or external secret stores, not configuration committed to git.
- Read-only stages shall be mechanically checked.
- Shell commands shall come only from trusted project configuration.
- Untrusted review comments shall never be interpolated into shell commands.

### NFR-3 — Auditability

Every transition shall record event type, actor, source and destination state, timestamp, and available model/runtime metadata. Artifacts shall include a SHA-256 digest.

### NFR-4 — Portability

The local product shall run on Node.js 22.15+ on macOS, Linux, and Windows where the configured Cursor CLI command and project commands are available.

### NFR-5 — Maintainability

- State transitions remain centralized.
- Runtime dependencies remain isolated.
- Prompt templates are versioned files.
- New behavior includes tests and documentation.

### NFR-6 — Observability

v0.1 shall preserve command output, duration, failure reasons, and run events. Later versions shall add structured logs, metrics, traces, and GitHub check summaries.

## MVP user journey

1. Developer installs and builds MASWE.
2. Developer installs Superpowers in Cursor.
3. Developer runs `maswe init` in a target repository.
4. Developer validates model slugs and quality commands with `maswe doctor`.
5. Developer starts a run from a feature request.
6. Brainstorm artifact is generated; developer reviews and approves it.
7. Specification/design artifact is generated; developer reviews and approves it.
8. Builder edits the active branch or worktree.
9. Quality commands execute.
10. Independent verifier passes or sends work back to the builder.
11. Developer opens a PR and signals it to MASWE.
12. Review comments can be classified and resolved through the loop.
13. Developer marks merge-ready and complete after external merge policy passes.

## Success metrics

For a pilot set of repositories:

- At least 90% of runs retain complete brainstorm, design, build, CI, and verification artifacts.
- Zero verifier-approved runs where the verifier modified workspace files.
- Zero automatic resolver edits for comments classified out of scope.
- At least 80% of runs can resume after process restart using only persisted state.
- Median manual effort to inspect a run state is under two minutes.
- Model selection mismatches are surfaced in 100% of runtimes that report actual model identity.
- At least 70% of accepted feature PRs require no requirement clarification after design approval.

## Release acceptance criteria for v0.1

- AC-1: `npm run check` passes on Node 22.
- AC-2: Starting a run with the mock runtime reaches the brainstorm approval gate.
- AC-3: Approving brainstorm reaches the design approval gate.
- AC-4: Approving design with passing commands and verifier reaches `PR_READY`.
- AC-5: A failing quality command routes back to building and increments bounded cycles.
- AC-6: A verifier failure routes back to building.
- AC-7: An in-scope PR comment is resolved, quality-checked, and freshly verified.
- AC-8: An out-of-scope PR comment reaches `WAITING_FOR_HUMAN` without edits.
- AC-9: Invalid events and read-only workspace modifications fail closed.
- AC-10: README, operations, architecture, security, roadmap, and contribution documentation exist.

## Future requirements

- GitHub App webhook ingestion and idempotent event processing.
- Branch and worktree lifecycle management.
- Check runs bound to exact head SHA.
- Signed or identity-aware approvals.
- SQLite and PostgreSQL stores with optimistic concurrency.
- Hosted control plane, API, MCP server, and team dashboard.
- Budget, token, latency, and provider policy controls.
- Multi-repository and cross-service change plans.
- Sandboxed execution and policy-as-code for commands and file scopes.
