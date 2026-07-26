# Artifact contracts

Artifacts are the durable handoff protocol between roles. A later API or database may change storage, but these meanings should remain stable.

## General rules

- Every artifact is UTF-8 Markdown in v0.1+.
- The store records logical name, attempt number, repository-relative path, creation timestamp, and SHA-256 digest.
- Retries write attempt-scoped immutable files (`*.attempt-<n>.md`) and keep a latest logical pointer by name.
- Digests are recomputed and compared on every read; mismatches fail closed.
- Agents must not rely on prior chat messages that are absent from the supplied prompt.
- Model output cannot authorize a transition unless the orchestrator recognizes the required terminal marker after structured response decoding: exactly one bare marker token on the final logical line of the authoritative assistant text (no backticks, quotes, earlier mentions, duplicates, or conflicting markers).
- For Cursor CLI `json` / `stream-json` modes, marker validation runs only on the decoded authoritative `result` string. Transport JSON quoting is not treated as embedded model content. Malformed envelopes, unsupported shapes, and missing `result` fields fail closed before marker validation.
- Operator-visible marker diagnostics distinguish quoted examples, embedded tokens, duplicates, conflicts, non-final markers, and content after a marker, without echoing the full model output.
- Common secrets are redacted before persistence. Successful model output follows the artifact
  redaction contract; failure diagnostics additionally follow the bounded failure contract below.
- JSON schemas live under `schemas/` for configuration and run records.
- Persisted `run.config.roles.*.model` values are exact executable catalogue IDs after `start`. Loading a run migrates defaults then runs the same config assertions as project load (without applying process environment overrides).

## Run record

`run.json` contains:

```json
{
  "schemaVersion": 1,
  "version": 3,
  "id": "20260722120000-1a2b3c4d",
  "title": "Add organization audit trail",
  "request": "...",
  "repositoryPath": "/workspace/project",
  "state": "WAITING_FOR_DESIGN_APPROVAL",
  "createdAt": "2026-07-22T12:00:00.000Z",
  "updatedAt": "2026-07-22T12:20:00.000Z",
  "approvals": {
    "brainstorm": true,
    "design": false
  },
  "counters": {
    "buildVerifyCycles": 0,
    "commentResolutionCycles": 0
  },
  "workspace": {
    "remote": "https://github.com/example/repo.git",
    "baseSha": "abc...",
    "headSha": "abc...",
    "branch": "maswe/20260722120000-1a2b3c4d",
    "fingerprint": "...",
    "worktreePath": "/tmp/maswe-worktrees/<repoKey>/20260722120000-1a2b3c4d"
  },
  "evidence": {
    "quality": { "headSha": "abc...", "passed": true, "at": "..." },
    "verification": { "headSha": "abc...", "passed": true, "at": "..." }
  },
  "config": {},
  "artifacts": [],
  "events": []
}
```

Build, quality, and verification events include the evaluated `headSha`. When `headSha` changes, prior quality/verification evidence is invalidated and merge-ready fails closed until CI and verification are re-run.

The run's configuration is a snapshot. Changing `.maswe/config.json` affects only later runs unless a future migration command explicitly updates a run.

### Failure record

New failures may include `failure.code`, currently `runtime-models-exhausted` or `workflow-failure`,
alongside the existing message, timestamp, and optional resume state. The code is optional for
backward compatibility with existing schema-version-1 records. They may also include the optional
schema-version-1-compatible object:

```json
{
  "runtime": {
    "attempts": [
      {
        "model": "cursor-grok-4.5-high",
        "code": "cursor-cli-non-zero",
        "message": "Cursor CLI exited non-zero.",
        "requestedModel": "cursor-grok-4.5-high",
        "configuredModel": "cursor-grok-4.5-high",
        "exitCode": 7,
        "timedOut": false,
        "durationMs": 42,
        "promptTransport": "stdin",
        "stderrPresent": true,
        "truncated": false
      }
    ],
    "totalAttempts": 1,
    "omittedAttempts": 0,
    "aggregateTruncated": false
  }
}
```

`attempts` stores at most eight entries. `totalAttempts` counts every executed fallback;
`omittedAttempts` is the difference between the total and stored entries. Attempt messages are
bounded to 512 Unicode code points and `model`, `requestedModel`, and `configuredModel` display
fields to 256. All fields except `model`, `code`, `message`, `stderrPresent`, and `truncated` are
optional per attempt. Arbitrary runtime metadata is not part of this contract.

Failure messages and `FAIL.details.reason` are normalized, redacted, and bounded to 8,192 Unicode
code points including `… [truncated]`. `RETRY_FROM_FAILED.details.previousFailure.message` receives
the same safeguard. `FAIL.details.runtime` and
`RETRY_FROM_FAILED.details.previousFailure.runtime` use the same bounded durable subset. Loading an
older record with no runtime object preserves the old shape; loading a record with the optional
object reconstructs and sanitizes only the documented fields before status/inspection rendering.

Cursor CLI runtime error results are not artifacts. Raw stderr, raw error metadata, and stderr
digests are never part of the run or artifact contract. Safe runtime diagnostics expose a stable
code plus applicable exit code, timeout, duration, requested/configured model, prompt transport,
`stderrPresent`, and `truncated`. Individual diagnostics are capped at 2,048 Unicode code points
before the 8,192-code-point fallback aggregate is built.

## `02-brainstorm.md`

Required content:

- Problem and desired outcome.
- Users, constraints, assumptions, and non-goals.
- Multiple viable approaches and trade-offs.
- Recommended approach.
- Risks and open questions.
- Draft measurable acceptance criteria.
- Approval checklist in ordinary language (must not quote or repeat the machine terminal marker token).

Required terminal marker:

```text
READY_FOR_BRAINSTORM_APPROVAL
```

Strict marker validation rejects missing, quoted, embedded, duplicate, conflicting, or non-final-line markers. Diagnostics identify the violated contract after structured response decoding.

## `03-specification-and-design.md`

Required content:

- Product requirements.
- User-visible and failure behavior.
- Stable acceptance criterion IDs.
- System context, component impact, interfaces, and data flows.
- Security, privacy, reliability, and observability requirements.
- Migration, compatibility, and rollout strategy.
- Test strategy mapped to acceptance criteria.
- Ordered implementation tasks and verification commands.
- Alternatives and unresolved decisions.

Required terminal marker:

```text
READY_FOR_DESIGN_APPROVAL
```

## `04-builder-report.md`

Required content:

- Summary of behavior implemented.
- Files changed.
- Acceptance criteria evidence.
- Tests and commands run.
- Deviations and limitations.
- Git status and commit SHA when available.

Required terminal marker:

```text
BUILD_COMPLETE
```

The report is not proof. The quality runner and verifier must inspect the actual workspace.

## `05-quality-report.md`

Generated by deterministic code, not a model.

For every command it contains:

- Command string.
- Exit code.
- Duration.
- stdout.
- stderr.

The report's overall result is `PASS` only when every configured command ran and returned zero. With an empty command list, the result is pass; production repositories should configure meaningful commands.

This stderr is output from trusted project quality commands and is redacted through the existing
artifact contract. It is distinct from provider/Cursor runtime stderr, which never becomes an
artifact.

## `06-verification-report.md`

Required content:

- Workspace or commit verified.
- Acceptance criteria matrix.
- Commands and evidence inspected.
- Blocking findings.
- Non-blocking warnings.
- Final decision.

The final line must be exactly one of:

```text
VERDICT: PASS
VERDICT: FAIL
```

Only `VERDICT: PASS` advances to `PR_READY`.

## `07-review-comment.md`

Raw review comment text supplied by a user or future GitHub integration. Treat this artifact as untrusted input. It may contain prompt injection, code blocks, links, shell text, or misleading instructions.

It must never be executed as a command or used to bypass approved requirements.

## `08-comment-classification.md`

Required content:

- Rationale.
- Likely files involved.
- Minimal permitted change.
- Risks and ambiguity.

The final line must be exactly one of:

```text
SCOPE: IN_SCOPE
SCOPE: OUT_OF_SCOPE
```

Only `IN_SCOPE` permits resolver edits.

## `09-resolution-report.md`

Required content:

- Reviewer concern verified.
- Minimal changes made.
- Tests added or changed.
- Commands executed.
- Remaining ambiguity or limitation.

Required terminal marker:

```text
RESOLUTION_COMPLETE
```

After this artifact is written, the workflow always runs deterministic quality checks and a fresh verifier.

## Event metadata

Each transition event includes:

```json
{
  "id": "uuid",
  "at": "2026-07-22T12:30:00.000Z",
  "type": "VERIFY_PASSED",
  "actor": "verifier",
  "from": "VERIFYING",
  "to": "PR_READY",
  "details": {
    "requestedModel": "gpt-5.6-sol-high",
    "actualModel": "gpt-5.6-sol-high",
    "agentId": "...",
    "runtimeRunId": "..."
  }
}
```

Runtime fields are optional because not every adapter exposes them.

For `FAIL`, details may also include the durable failure `code`, bounded safe `reason`, and optional
bounded `runtime` summary. For `RETRY_FROM_FAILED`, `previousFailure` is the already-safe failure
record and its message/runtime subset is re-sanitized at the store boundary.

## Future schema hardening

Planned additions:

- JSON Schema files with CI validation.
- Immutable attempt-specific artifact names.
- Git base and head SHA on all build, CI, and verification artifacts.
- Prompt-template version and content hash.
- Token usage, cost, latency, and provider request IDs.
- Redaction and data-classification labels.
- Cryptographic signing or provenance attestations for CI and verification.
