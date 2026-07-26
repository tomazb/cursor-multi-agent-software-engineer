# Issue 19: Redact Persisted Cursor CLI Failure Diagnostics

## Status and baseline

- Approved implementation request: GitHub Issue #19.
- Recorded base: `caba625fd9367a5fecb10f19f499f7cd5b4998ef`.
- Branch: `issue/19-redact-cursor-stderr`.
- Scope excludes Issues #16, #17, #18, #13, and #3.

## Source-to-sink audit

| Source | Transient path | Current sink | Required correction |
| --- | --- | --- | --- |
| Cursor CLI stage `stderr` | `spawnCaptured` → `CursorCliRuntime.execute` | Non-zero `RuntimeResult.output`, `metadata.stderr` | Redact, normalize, classify, and bound in the adapter; omit raw stderr from metadata |
| Cursor CLI exit-zero decode stderr | `spawnCaptured` → decode error result | `metadata.stderr` | Preserve the three decode codes and safe operator prose; retain only `stderrPresent` |
| Cursor CLI model-catalogue stderr | `listModels()` error interpolation | `start`/`doctor` normal CLI error/check output | Convert to a bounded redacted catalogue diagnostic |
| Cursor CLI version/doctor stderr | `doctor()` check message | Normal CLI doctor output | Use the same bounded redacted diagnostic policy |
| Runtime error output | `ensureSuccess()` | Fallback failure list | Consume a typed failure diagnostic and sanitize again |
| Runtime throw/rejection | `executeAgent()` catch | Fallback failure list | Classify as `runtime-error`, sanitize, and bound before aggregation |
| Per-model fallback failures | `failures.push()` → joined exception | `failRun()` | Store bounded structured entries and render a bounded aggregate |
| Final workflow exception | `advance()` catch → `failRun()` | `run.failure`, `run.json`, `FAIL.details.reason` | Sanitize and bound at `failRun()` before the first save/event |
| Failed-run retry | `run.failure` → `previousFailure` | `RETRY_FROM_FAILED.details.previousFailure` | Re-sanitize at event/store persistence boundaries |
| Supersede state | existing failure copied/saved | original/replacement `run.json` and events | Generic store safeguard sanitizes persisted failure/event failure fields |
| CLI status/JSON | persisted `RunRecord` → `renderRun`/`JSON.stringify` | Normal stdout | Persist only safe failure state; defensively render a safe message |
| Stage output | successful `RuntimeResult.output` → artifacts | artifact files | No new blanket sanitizer; retain the existing artifact-redaction contract |

Other runtime adapters were audited. `MockRuntime` returns successful deterministic output. `CursorSdkRuntime`
can return an error result or throw SDK/import/auth errors; the generic orchestrator and persistence safeguard
must sanitize and bound those failures without introducing provider-specific SDK behavior.

## Security design

### Typed runtime failures

`RuntimeResult` becomes a discriminated success/error contract. Error results carry a
`RuntimeFailureDiagnostic` with a stable code, safe message, optional safe excerpt, and operational fields:
exit code, timeout state, duration, requested/configured model, and prompt transport. Cursor CLI uses codes
that distinguish non-zero exit, timeout, exit-zero structured decode, catalogue failure, and
process-spawn/runtime errors. Authentication-like prose remains operator-visible after sanitization under the
non-zero code, but it does not control classification because Cursor CLI exposes no structured authentication
field. Control flow consumes the discriminant and code; it never parses human-readable prose.

### Redaction and diagnostic bounding

One shared helper normalizes unsafe controls (preserving newline and tab), invokes `redactSecrets()`, and only
then truncates. Truncation is measured in Unicode code points, not UTF-16 code units or UTF-8 bytes.

- Maximum individual diagnostic: 2,048 Unicode code points, including the truncation marker.
- Maximum all-model aggregate: 8,192 Unicode code points, including the truncation marker.
- Marker: `… [truncated]`.

The helper is deterministic for identical input. It exposes whether truncation occurred. Per-model entries are
bounded before aggregation, and aggregation stops once the aggregate budget is exhausted.

`redactSecrets()` is extended only for tested credential forms: GitHub/OpenAI/Slack tokens, authorization and
standalone bearer forms, URL userinfo, common API-key/token/AWS-secret assignments, private-key blocks, and
sensitive query parameters. Synthetic fixtures are used exclusively.

### Defense in depth

The Cursor CLI adapter emits no raw stderr-derived string: output, typed diagnostic, and metadata are safe and
bounded. The orchestrator sanitizes runtime failures and caught exceptions before aggregation. `failRun()`
sanitizes once more before assigning `run.failure` or applying `FAIL`. The file store applies a focused
persistence safeguard to `run.failure.message`, `FAIL.details.reason`, and retry `previousFailure.message` so
an unsafe adapter or future caller cannot trivially persist a recognizable secret.

The safeguard is deliberately failure-specific. Successful model artifacts continue through
`writeArtifact()` and its existing `redactSecrets()` contract. Exit-zero Cursor structured-output failures
retain `invalid-transport-json`, `unsupported-response-shape`, and `missing-logical-output`.

### Raw-debug policy

Raw provider stderr may exist only inside `spawnCaptured` and the Cursor runtime call stack. MASWE will not
persist it, hash it, log it, attach it, place it in runtime metadata, or add a raw-debug artifact/channel.
Operators receive bounded redacted excerpts and structured operational metadata. Secret recognition is
best-effort and pattern-based, so the persistence safeguard is defense in depth rather than a claim that
arbitrary secrets are always detectable.

## Error flow

1. The process adapter returns transient stdout/stderr and execution metadata.
2. Cursor CLI classifies the outcome without decoding non-zero stdout as authoritative assistant output.
3. Stderr is normalized, redacted, and bounded; raw stderr is discarded at the runtime return boundary.
4. The orchestrator receives a typed error, creates a bounded per-model failure, and attempts an allowed fallback.
5. If all candidates fail, it renders one bounded aggregate.
6. `failRun()` and the store sanitize failure-specific persisted fields before writing `run.json`.
7. Retry and CLI inspection consume the already-safe durable representation.

## Testing strategy

- Redaction/boundary unit tests cover all required synthetic forms, placement, multiline input, controls,
  Unicode boundaries, determinism, and truncation adjacent to secrets.
- Cursor runtime tests cover empty/structured stdout, timeout, large stderr, safe metadata, operational fields,
  catalogue/doctor failure output, and contract-equivalent PR #15 decode behavior.
- Orchestrator integration tests use unsafe runtime stubs to prove defense in depth across returned records,
  disk JSON, events, artifacts, retry history, supersede handling, fallback aggregation, and CLI rendering.
- Compatibility suites cover text/JSON/stream-json success, structured decode failures, model checks, read-only
  fingerprints, mock workflows, retry/schema migration, and artifact redaction.

## Alternatives rejected

1. Adapter-only redaction: closes the known Cursor path but leaves persistence vulnerable to other/future adapters.
2. Store-only redaction: permits raw stderr to cross runtime/orchestrator boundaries and loses useful typed fields.
3. Persist encrypted/raw stderr or a digest: creates a forbidden durable debug channel and comparison risk.
