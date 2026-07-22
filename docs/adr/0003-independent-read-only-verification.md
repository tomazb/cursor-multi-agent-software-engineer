# ADR-0003: Require independent read-only verification after deterministic checks

- Status: Accepted
- Date: 2026-07-22

## Context

A builder is biased toward its own implementation and may report tests it did not run or miss requirement gaps. Deterministic CI proves command outcomes but cannot fully judge specification compliance, edge cases, or scope.

## Decision

After builder or resolver edits, run trusted quality commands, then launch a separate verifier role in read-only mode. Require an acceptance-criteria evidence report and a strict `VERDICT: PASS|FAIL` terminal line. Any edit invalidates prior verification and requires a fresh verifier.

## Consequences

### Positive

- Separates implementation from acceptance judgment.
- Combines deterministic and semantic checks.
- Gives reviewers a structured evidence artifact.
- Reduces self-confirming completion claims.

### Negative

- Additional model cost and latency.
- A verifier can still miss defects.
- Current local implementation detects writes after execution rather than preventing them.
- v0.1 is not yet bound to an exact remote git SHA.

## Follow-up

Persist base/head SHA, publish SHA-bound GitHub checks, add optional dual-model verification for high-risk changes, and enforce preventive sandbox permissions.
