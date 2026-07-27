# Issue 19: Redact Persisted Cursor CLI Failure Diagnostics

## Status and baseline

- Approved implementation request: GitHub Issue #19.
- Recorded base: `caba625fd9367a5fecb10f19f499f7cd5b4998ef`.
- Branch: `issue/19-redact-cursor-stderr`.
- Historical head with the authoritative independent-verifier `FAIL`:
  `7b3ba017195e7ecde6722d748d678e98d567aaa9`.
- Second historical head with the authoritative second independent-verifier `FAIL`:
  `fcf4d1b11ad4d347550410327fa0799bdd906430`.
- Repair scope: modern GitHub PATs, URI userinfo, sanitizer work bounds, durable attempt metadata,
  and model-identity framing. The prior `FAIL` remains part of the validation history.
- Second repair scope: successful-event runtime identity display framing, strict nested durable
  runtime schema allowlists, deterministic Node `v22.22.2` child-test communication, and a
  supported-runtime constrained-heap probe.
- Scope excludes Issues #16, #17, #18, #13, and #3.

## Second independent-verifier correction

The second verifier returned `FAIL` for exact head
`fcf4d1b11ad4d347550410327fa0799bdd906430`. That verdict and the earlier verdict for
`7b3ba017195e7ecde6722d748d678e98d567aaa9` remain failed historical evidence and cannot approve a
later SHA.

### Successful-event identity display boundary

Runtime invocation and exact-model comparison continue to use the runtime's original
`requestedModel` and `actualModel` values. Before a successful workflow event is persisted, one
orchestrator helper constructs display-only copies. Model copies use the existing 256-code-point
model-display policy. `agentId` and `runtimeRunId` cross the same runtime-to-persistence boundary,
so a separately named 256-code-point runtime-identifier display policy applies to those optional
fields. Both policies normalize controls, line and paragraph separators, bidi framing controls,
and aggregate delimiters; preserve ordinary identifiers; and are deterministic and idempotent.

The helper is used for `BRAINSTORM_COMPLETED`, `DESIGN_COMPLETED`, `BUILD_COMPLETED`,
`VERIFY_PASSED`, `VERIFY_PASSED_AFTER_REVIEW`, `VERIFY_FAILED`, and `RESOLUTION_COMPLETED`.
Artifacts and runtime invocation inputs are unchanged.

### Strict nested durable runtime schema

`$defs.durableRuntimeFailureAttempt` and `$defs.durableRuntimeFailureSummary` are schema-closed
with `additionalProperties: false`. No historical parent object is closed by this correction.
Schema-version-1 failures without `runtime`, including historically long messages, remain valid.
Migration continues reconstructing the allowlisted runtime subset and dropping unknown data.

### Node `v22.22.2` deterministic child-test communication

Node `v22.22.2` is supported by the declared `>=22.15` engine range. In the affected test context,
small results emitted by child Node programs through buffered JavaScript stdout can be absent even
after a zero exit. Tests therefore use explicit deterministic channels: synchronous child writes
for compact machine results and unique file-backed stdout/stderr descriptors when exercising the
unchanged production CLI. The Node stand-in used by the doctor stdin probe reads its test payload
synchronously. Missing or malformed results remain hard failures, diagnostics remain on stderr,
timeouts and cleanup remain bounded, and production CLI rendering is unchanged.

CI retains current Node 22 coverage and adds an exact Node `22.22.2` compatibility job running the
full `npm run check` and package dry run while verifying the checked-out SHA.

### Constrained-heap scope

The constrained-heap regression uses an 8,000,000-character one-byte input, a 48 MiB V8 old-space
limit, and an exact 128-code-point output assertion. On Node `v22.22.2`, a representative historical
full code-point array aborts with exit 134 at approximately 108,988 KiB maximum RSS, while the
bounded-prefix sanitizer exits 0 at approximately 78,772 KiB maximum RSS. This exercises the
security property that sanitizer overhead does not allocate storage for every input code point; it
does not claim an absolute process-memory bound.

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
`RuntimeFailureDiagnostic` with a stable code, safe message, and operational fields:
exit code, timeout state, duration, requested/configured model, and prompt transport. Cursor CLI uses codes
that distinguish non-zero exit, timeout, exit-zero structured decode, catalogue failure, and
process-spawn/runtime errors. Authentication-like prose remains operator-visible after sanitization under the
non-zero code, but it does not control classification because Cursor CLI exposes no structured authentication
field. Control flow consumes the discriminant and code; it never parses human-readable prose.

### Redaction and diagnostic bounding

One shared helper bounds its input work first, normalizes unsafe controls (preserving newline and
tab), invokes `redactSecrets()` on the accepted window, and only then truncates. Truncation is
measured in Unicode code points, not UTF-16 code units or UTF-8 bytes.

- Maximum individual diagnostic: 2,048 Unicode code points, including the truncation marker.
- Maximum all-model aggregate: 8,192 Unicode code points, including the truncation marker.
- Redaction lookahead: 4,096 Unicode code points beyond the requested output budget.
- Absolute accepted diagnostic window: 12,288 Unicode code points.
- Marker: `… [truncated]`.

The helper is deterministic for identical input. It exposes whether truncation occurred. Per-model entries are
bounded before aggregation. Once the aggregate budget is exhausted, later fallbacks still run and the final
bounded message reports how many later model failures were omitted from the diagnostic text.

The bounded lookahead ensures that a recognized credential beginning near the retained boundary can
be consumed in full. A long assignment, incomplete private-key block, or supported URI authority
that reaches the accepted-window end remains redacted through that boundary. Quoted assignment
values treat a quote as a delimiter only when it is preceded by an even-length backslash run; one
JSON-encoded structural-quote layer is recognized with its corresponding backslash parity. The
fixed-token-prefix scanner likewise redacts a candidate that reaches the incomplete window end,
including when only prefix-valid punctuation has been observed. The sanitizer never constructs a
code-point array from the complete attacker-controlled input.

`redactSecrets()` is extended only for tested credential forms: classic GitHub and modern
`github_pat_` tokens, OpenAI/Slack tokens, authorization and standalone bearer forms, URI userinfo,
common API-key/token/AWS-secret assignments, private-key blocks, and sensitive query parameters.
URI userinfo requires `http`, `https`, `ssh`, `git`, `git+https`, `git+ssh`, `sftp`, or `ftp`
followed by `://`; username-only and username/password forms are redacted in full while scheme,
host, port, path, query, and fragment remain. Ordinary email and SCP-like prose are not inferred as
credentials. Synthetic fixtures are used exclusively.

Assignment, URI-authority, and private-key matching uses purpose-specific monotonic scanners. The
URI scanner records the last `@` while advancing through the current authority and never performs
a backward search over already-consumed content. This is required because the same scanner also
handles successful artifacts whose content is not subject to the failure-diagnostic inspection
cap. Remaining expressions have fixed/non-overlapping grammars and run on the bounded accepted
window. The former nested ambiguous provider-prefix assignment repetition is removed.

### Durable failure-attempt contract

`RunRecord.failure` keeps the compatible optional `code`, required `message`/`at`, and optional
`resumeState`. It may additionally carry optional `runtime`:

- `attempts`: at most eight `DurableRuntimeFailureAttempt` entries;
- `totalAttempts`: every executed model attempt;
- `omittedAttempts`: attempts not stored because of the eight-entry limit; and
- `aggregateTruncated`: whether aggregate diagnostic text was omitted by its budget.

Each attempt requires a safe `model`, typed `code`, safe `message`, `stderrPresent`, and
`truncated`. It optionally carries `requestedModel`, `configuredModel`, `exitCode`, `timedOut`,
`durationMs`, and `promptTransport`. Attempt messages are capped at 512 code points and model
display fields at 256. The aggregate remains capped at 8,192. `FAIL.details.runtime` and retry
`previousFailure.runtime` reuse this object. Old records without it retain their historical shape.
Records containing it are reconstructed from this allowlist; arbitrary adapter metadata is
discarded. Reconstruction inspects only the first eight raw attempt slots, discarding malformed
entries instead of scanning an unbounded input array to fill the durable subset.

Model values used for execution are unchanged. Diagnostic display copies replace CR/LF, NUL,
C0/C1 controls, Unicode line/paragraph separators, bidi overrides/isolates, and aggregate delimiter
characters before per-attempt formatting, persistence, and human rendering.

### Defense in depth

The Cursor CLI adapter emits no raw stderr-derived string: output, typed diagnostic, and metadata
are safe and bounded. It sanitizes stderr before trimming or summary interpolation. The
orchestrator sanitizes runtime failures and caught exceptions before aggregation. `failRun()`
sanitizes once more before assigning `run.failure` or applying `FAIL`. The file store applies a
focused persistence safeguard to failure messages and reconstructs the optional runtime attempt
subset in `run.failure`, `FAIL` details, and retry `previousFailure`; event paths exclude raw runtime
before cloning other details. An unsafe adapter or future caller therefore cannot trivially persist
a recognizable secret, arbitrary runtime object, or attacker-sized attempt array.

Schema version 1 keeps the historical `failure.message` field unconstrained for compatibility with
records written before bounded diagnostics. Migration sanitizes that field before use; all newly
persisted records remain bounded by implementation policy.

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
5. If all candidates fail, it renders one bounded aggregate and one independently bounded durable
   attempt summary.
6. `failRun()` and the store sanitize failure-specific persisted fields before writing `run.json`;
   applicable `FAIL` details receive the same runtime summary.
7. Retry, supersede, and CLI inspection consume the already-safe durable representation.

## Testing strategy

- Redaction/boundary unit tests cover all required synthetic forms, placement, multiline input, controls,
  Unicode boundaries, determinism, truncation adjacent to secrets, adversarial no-match scaling,
  match-heavy input, and the fixed work window.
- Cursor runtime tests cover empty/structured stdout, timeout, large stderr, safe metadata, operational fields,
  catalogue/doctor failure output, and contract-equivalent PR #15 decode behavior.
- Orchestrator integration tests use unsafe runtime stubs to prove defense in depth across returned records,
  disk JSON, events, artifacts, retry history, supersede handling, fallback aggregation, structured
  attempt bounds, model framing, and human/JSON CLI rendering.
- Compatibility suites cover text/JSON/stream-json success, structured decode failures, model checks, read-only
  fingerprints, mock workflows, retry/schema migration, and artifact redaction.

## Alternatives rejected

1. Adapter-only redaction: closes the known Cursor path but leaves persistence vulnerable to other/future adapters.
2. Store-only redaction: permits raw stderr to cross runtime/orchestrator boundaries and loses useful typed fields.
3. Persist encrypted/raw stderr or a digest: creates a forbidden durable debug channel and comparison risk.
4. Safe-regex-only full-input processing: removes the specific ambiguous expression but leaves CPU
   proportional to unbounded input before the 2,048-code-point output cap.
5. Persist the complete runtime metadata object: retains adapter-specific/unbounded state and weakens
   the orchestration/runtime boundary.

## Non-blocking SDK follow-up

Current `CursorSdkRuntime` returns typed `cursor-sdk-error` for a non-finished SDK result, but dynamic
import or `Agent.prompt` rejection still escapes to the generic orchestrator catch. That path is
redacted and bounded before persistence. Converting those exceptions inside the SDK adapter needs a
separate injection/lifecycle test seam and is not part of this Cursor CLI correction.
