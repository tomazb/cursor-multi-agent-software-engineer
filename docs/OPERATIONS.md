# Operations guide

## 1. Installation

```bash
git clone https://github.com/tomazb/cursor-multi-agent-software-engineer.git
cd cursor-multi-agent-software-engineer
npm install
npm run check
npm run build
npm link
```

Install Cursor CLI according to Cursor's current documentation and authenticate it. Install Superpowers in Cursor:

```text
/add-plugin superpowers
```

The optional SDK runtime additionally requires:

```bash
npm install @cursor/sdk
export CURSOR_API_KEY="cursor_..."
```

## 2. Initialize a project

From the target repository:

```bash
maswe init
```

This creates `.maswe/config.json`. The directory `.maswe/runs/` is ignored by the starter `.gitignore` in this project, but target repositories should make the same choice explicitly. Some teams may want to commit approved design artifacts while keeping raw model logs private.

## 3. Configure models

List models available to the current Cursor account:

```bash
agent models
```

Update each exact model slug in `.maswe/config.json`. Model names and access can vary by Cursor version, plan, team policy, and provider availability.

Run diagnostics:

```bash
maswe doctor
maswe doctor --cwd /path/to/repo
```

`doctor` probes the Cursor CLI from a MASWE-managed worktree when `trustManagedWorktrees` is enabled (passing `--trust`), then removes that ephemeral worktree **and** its `maswe/doctor-*` branch. Cleanup outcome is reported as a doctor check.

MASWE stores local lock history under
`.maswe/runs/<run-id>/.lock-journal-v3/`. The `data`, `admin`, and
`admin-recovery` streams contain immutable ticket claims and exact release markers. A queued claim
is not an owner; only the smallest valid unreleased ticket may enter. The journal infrastructure,
published claims, and published releases are permanent and must not be manually pruned.

If the smallest data claim belongs to a dead process, use explicit recovery. MASWE never
auto-reclaims by age:

```bash
maswe unlock <run-id>
maswe unlock <run-id> --force   # explicit assertion that every affected writer is quiescent
```

Without force, a live owner and corrupt/incomplete state are rejected; a valid dead owner is
recoverable. Force can publish an exact release for a live data/admin claim or one stable eligible
corrupt claim only after the operator confirms quiescence. Force is not fencing: it cannot stop a
live process after operator error. Every release targets one exact ticket/digest and leaves later
claims untouched.

If the admin stream is blocked, use:

```bash
maswe unlock-admin <run-id>
maswe unlock-admin <run-id> --force   # only after confirming data/admin actors are quiescent
```

Administrative recovery first publishes a ticket in the separate `admin-recovery` stream. During
forced bootstrap, a contender may exactly release one eligible dead predecessor, but that
publication does not grant recovery ownership. Every contender rescans; only the smallest
unreleased recovery ticket may enter the recovery critical section. A live recovery owner is never
force-released. Corrupt/ambiguous recovery claims remain fail-closed.

Useful semantic failures include `LOCK_LIVE_OWNER`, `LOCK_DEAD_OWNER`, `LOCK_QUEUED`,
`LOCK_CORRUPT`, `LOCK_UNSAFE_PATH_TYPE`, `LOCK_OWNERSHIP_LOST`,
`ADMIN_RECOVERY_CONCURRENT`, `LOCK_CLEANUP_FAILED`, `LOCK_UNSUPPORTED_FILESYSTEM`, and
`LOCK_TICKET_OVERFLOW`. Do not work around them by deleting journal files. Preserve the run
directory and investigate the reported exact path/state.

The journal requires coherent same-host local filesystem semantics, exclusive temporary creation,
and atomic no-clobber hard links. NFS, SMB, distributed FUSE, object-store mounts, cross-host use,
and filesystems without hard links are unsupported. Windows support requires exact-head native
testing on local NTFS; Linux-injected Windows/error cases are not Windows-native coverage. ReFS,
FAT, unsupported reparse layouts, and network shares fail closed.

Each successful lock cycle appends a claim and usually a release. Records are roughly 0.5–1 KiB
but commonly consume a filesystem block each. Ten thousand mutations can consume tens to a few
hundred MiB because data operations also use admin serialization. Issue #11 provides no
compaction. Monitor `.lock-journal-v3` size, but do not archive, compact, or delete it while using
this version.

### Model resolution invariants

Configured role models may use logical names (for example `grok-4.5`).

Fail-closed catalogue discovery and logical→exact resolution apply to runtimes that implement catalogue discovery — currently **`CursorCliRuntime`** (`agent models`).

- **Catalogue trust boundary:** only recognized stdout rows contribute IDs. Supported decorations include `(default)` and `[default]`, spaced dash descriptions, tab columns, and columns aligned with at least two spaces. Headings, aliases, metadata, and ordinary prose are ignored. Any ID-shaped row with an unsupported trailing structure makes the entire discovered catalogue unusable, even when other valid IDs survive. MASWE never resolves from a silently incomplete catalogue.
- **New runs (`start`, Cursor CLI):** logical names are resolved against the complete local catalogue to exact executable IDs. When a configured logical model explicitly includes an effort suffix (`-high` / `-medium` / `-low`), only same-core catalogue IDs with that same effort are eligible; missing effort fails closed. When no effort is specified, preference selects non-fast, then high>medium>low, then `cursor-` prefixed IDs within the same logical family.
- **Weak matches:** one substring-only candidate is an inexact match, not an ambiguity; multiple substring-only candidates are an ambiguity. Both fail closed and carry typed resolution classifications. Control flow does not inspect error-message prose.
- **Authenticated smoke selection:** automatic selection tries the approved families in order and records a family-specific failure before continuing to the next family. A preferred value must be either an exact discovered ID that satisfies the family/effort policy or one literal allowlist family hint. An unresolved literal hint preserves the actionable resolver cause; unrelated logical aliases are rejected.
- **Run snapshot:** `start` stores exact IDs in `run.config`. Environment and project-config mutations after start do not rewrite them.
- **Existing-run stages (`run`, `approve`, `retry`, …):** validate the persisted exact ID against the live complete catalogue and use it as-is. Same-core / same-family / provider / effort-level substitution is forbidden. If the persisted exact ID disappears, execution fails closed naming that ID.
- **Doctor (Cursor CLI):** discovers and validates the complete catalogue first, resolves the brainstormer model with the same project-resolution logic as `start`, then probes with that exact ID. Doctor does **not** create a run and does **not** persist a `run.config` snapshot.
- **`CursorSdkRuntime`:** has no catalogue capability. Doctor/start do not call `agent models`; empty-catalogue pass-through keeps configured IDs as-is. SDK doctor must not be described as resolving through the CLI catalogue.

Treat a Cursor CLI doctor catalogue failure as a reason to inspect `agent models` output format and authentication, not as proof the provider is unavailable and not as permission to select from surviving rows.

Doctor probe cleanup is based on recorded probe identity: once a `doctor-*` probe ID is assigned, final cleanup removes the probe worktree (if present) and `maswe/doctor-*` branch even when worktree creation failed after the branch was created. Cleanup is idempotent; cleanup failures surface as a `doctor-probe-cleanup` check without erasing the original doctor failure.

Cursor CLI assistant extraction and terminal markers:

- Pipeline: raw Cursor CLI stdout → try one whole JSON envelope → when the buffer is not one JSON value, scan individual JSON/NDJSON records → select the authoritative string `result` field → validate exactly one bare terminal marker on the final logical line.
- `stream-json`: only terminal records with `type: "result"` contribute assistant output; the last valid terminal result wins.
- `json`: result-bearing objects use `type: "result"` with string `result`, or a typeless object with string `result`. Line-by-line recovery is permitted only for the same authoritative result shapes.
- Text mode: raw stdout (Markdown may contain JSON snippets without triggering structured decoding).
- Structured modes never fall back to validating the raw JSON envelope as logical text. A malformed JSON-looking record fails with `invalid-transport-json`; plain non-JSON output fails with `unsupported-response-shape`; valid JSON events without an authoritative result fail with `missing-logical-output`.
- Exit 0 with no valid assistant result fails closed and returns a `status: "error"` result carrying
  a `RuntimeFailureDiagnostic`; the diagnostic is never treated as successful assistant content.
  The operator-visible codes remain `invalid-transport-json`, `unsupported-response-shape`, and
  `missing-logical-output`. Stderr content is discarded at the runtime boundary; only
  `stderrPresent` is retained.
- A non-zero exit never promotes structured or text stdout to assistant output. It returns a typed
  `cursor-cli-non-zero` or `cursor-cli-timeout` diagnostic with exit code, timeout state, duration,
  requested/configured model, prompt transport, stderr presence, and truncation state where
  applicable. Process-spawn rejection uses `cursor-cli-spawn`.
- Diagnostics normalize unsafe controls, redact, then truncate by Unicode code points. Per-model
  diagnostics are capped at 2,048 code points and the all-model fallback message at 8,192; both
  bounds include `… [truncated]`. If later fallback diagnostics cannot fit, the message reports
  their omitted-attempt count while the configured attempts still execute.
- Before redaction, diagnostic inspection is capped at the output budget plus 4,096 code points
  and never exceeds 12,288. The lookahead closes recognized assignments/private-key blocks that
  cross the retained output boundary, and an incomplete supported URI authority that reaches the
  inspection boundary is redacted fail-closed. URI userinfo is recognized for `http`, `https`, `ssh`,
  `git`, `git+https`, `git+ssh`, `sftp`, and `ftp` `scheme://` forms; ordinary email and SCP-like
  `user@host:path` text are not treated as URI credentials.
- Authentication-like text can remain useful in the redacted excerpt, but it does not select a
  control-flow classification. Catalogue and doctor errors use the same bounded sanitizer.
- Marker validation rejects quoted examples, embedded tokens, duplicates, conflicts, non-final markers, and content after a marker. Operator-visible messages name the violated contract and logical line number without dumping full model output.
- Authenticated validation for the earlier JSON-marker repair used Cursor CLI `2026.07.23-e383d2b` on Linux. A new exact-head external validation is required after the Thermos blocker repairs; do not infer broader provider or platform coverage.

## 4. Configure quality commands

Replace starter commands with commands that are authoritative for the target repository, for example:

```json
{
  "quality": {
    "commands": [
      "pnpm test",
      "pnpm lint",
      "pnpm typecheck",
      "pnpm build"
    ]
  }
}
```

Commands execute with the system shell and are trusted code. Only repository administrators should change them. Never derive them from issues, model output, or PR comments.

## 5. Prefer isolated worktrees

By default `policy.useIsolatedWorktree` is `true`. On `start`, MASWE creates branch `maswe/<run-id>` and a linked worktree under an **external** directory (`$TMPDIR/maswe-worktrees/...`), not inside the operator checkout. `.maswe/` is appended via `git rev-parse --git-path info/exclude` so local run storage does not dirty `git status` even when the operator is already inside a linked worktree. Builder and resolver roles execute in that worktree. With `policy.trustManagedWorktrees` (default `true`), Cursor CLI invocations pass `--trust` for every role in MASWE-created worktrees. Completed, cancelled, failed, and superseded runs remove their worktrees but **preserve** the `maswe/<run-id>` branch ref so failed-run provenance (builder `outputHeadSha`) can be restored on `retry`. Cleanup failures are surfaced to the operator.

To opt out for a trusted checkout:

```json
{
  "policy": {
    "useIsolatedWorktree": false
  }
}
```

Keep the primary workspace clean. Dirty checkouts are rejected unless `policy.allowDirtyWorkspace` is true.

## 6. Run lifecycle

### Start

```bash
maswe start \
  --title "Add organization audit trail" \
  --request-file docs/requests/organization-audit-trail.md
```

The command returns a run ID and stops at `WAITING_FOR_BRAINSTORM_APPROVAL`.

### Inspect

```bash
maswe status <run-id>
cat .maswe/runs/<run-id>/artifacts/02-brainstorm.md
```

### Approve discovery

```bash
maswe approve <run-id> brainstorm
```

Inspect the design artifact before the next approval.

### Approve design and execute

```bash
maswe approve <run-id> design
```

The orchestrator automatically advances through build, CI, and verification until it reaches a gate, terminal state, or retry ceiling.

### Signal PR creation

```bash
maswe pr-opened <run-id>
```

### Process a review comment

```bash
maswe review-comment <run-id> --text "Please cover the expired token case."
```

Or preserve the exact comment in a file:

```bash
maswe review-comment <run-id> --file /tmp/review-comment.md
```

In-scope comments pass through resolver, quality, and a fresh verifier, then return to the existing `PR_REVIEW` state. Out-of-scope comments stop at `WAITING_FOR_HUMAN`.

### Resume after human decision

When a human has handled or clarified an out-of-scope comment:

```bash
maswe resume-review <run-id>
```

A future version will allow updating the approved specification through a new approval cycle rather than merely returning to review.

### Complete

```bash
maswe merge-ready <run-id>
maswe complete <run-id>
```

These commands record workflow status only; they do not merge a PR.

## 7. Recovery

### Process interrupted

All completed transitions and artifacts are on disk. Re-run:

```bash
maswe status <run-id>
maswe run <run-id>
```

`maswe run` works only for actionable automatic states. Approval and review states require their specific commands.

### Runtime failure

Inspect:

- `run.failure` in `run.json` (includes `resumeState` when recoverable).
- Last transition details.
- The stable aggregate failure code and bounded message.
- Optional `run.failure.runtime`: `attempts` (at most eight), `totalAttempts`,
  `omittedAttempts`, and `aggregateTruncated`. Each stored attempt has a safe model display, stable
  code, a message capped at 512 code points, requested/configured model displays where supplied,
  exit/timeout/duration/transport fields where supplied, `stderrPresent`, and `truncated`.
- Human `maswe status` prints the attempt count and structured operational fields. `--json` emits
  the same durable object. Model display values are single-line and delimiter-neutral; they do not
  change the exact model value used for execution.
- Cursor authentication and model availability.

Raw provider stderr is not available in `run.json`, events, artifacts, retry history, status output,
or a debug file. MASWE intentionally has no persistent raw-stderr channel. Reproduce a failure
directly with the provider CLI only under your organization’s secure debugging procedures; never
paste credential-bearing stderr into run artifacts, logs, issues, or PR comments.

Retry the same run after fixing the cause:

```bash
maswe retry <run-id>
```

Or start a linked replacement that cancels the original when it is still active:

```bash
maswe supersede <run-id>
```

### Quality failure loop

CI failure returns to `BUILDING`. The builder sees the latest quality artifact on the next pass. After `maxBuildVerifyCycles`, the run fails.

### Verifier failure loop

A failed verifier returns to `BUILDING`. The next builder prompt includes the latest deterministic quality and independent verification reports so defects can be addressed directly.

### Read-only violation

The run fails if a read-only role changes fingerprinted workspace state. In Git checkouts that includes git status/diffs/untracked content. In both Git and non-Git working directories it also includes authoritative `.maswe` run records, durable artifacts, and project config under the fingerprinted working directory (Git excludes do not hide that state from the fingerprint). Inspect `git status` (when applicable) and `.maswe/runs/<id>/`, and revert only changes attributable to that role. Preserve unrelated user work. Ephemeral `.lock` / `.admin.lock` / `.admin.lock.recovering` / `*.tmp` churn under `.maswe` is excluded from the fingerprint by design. The fingerprint is a before/after mutation detector, not an OS sandbox.

## 8. File-store backup and privacy

A complete local backup consists of `.maswe/runs/`. Artifacts can contain proprietary source descriptions, security findings, reviewer comments, and model output. Apply the repository's data classification and retention policy.

Do not commit `.maswe/runs/` by default. If approved designs should be versioned, export selected artifacts into a reviewed documentation directory rather than committing the whole run store.

## 9. CI use

A basic CI job can build and test MASWE itself. Using MASWE to alter a target repository in CI requires:

- Cursor CLI or SDK authentication in the runner.
- A checked-out feature branch.
- Protected secrets.
- Explicit write permissions.
- Deterministic publish steps outside the model.

Do not let a model push or merge directly in production CI. Let it edit the checkout, then use scripted git and GitHub steps after policy gates pass.

## 10. Upgrades

Before pulling a new version:

1. Back up `.maswe/runs/` for active projects.
2. Read `CHANGELOG.md` for state or artifact contract changes.
3. Run `npm install` and `npm run check`.
4. Rebuild and re-link the CLI.
5. Run `maswe doctor` in target repositories.

For the v3 lock-journal upgrade:

1. Stop every MASWE process using the target `.maswe/runs/` tree.
2. Back up the tree and inspect legacy `.lock`, `.admin.lock`, and
   `.admin.lock.recovering` objects.
3. Start only the new binary. It represents an existing PR #10 lock as virtual ticket zero and
   publishes a digest-bound compatibility release only through `maswe unlock <run-id> --force`
   or `maswe unlock-admin <run-id> --force`; it never deletes the legacy path. An empty legacy
   `.admin.lock.recovering` directory is bound to stable filesystem identity and fails closed if
   replaced or if that identity is unavailable.
4. Do not run old and new binaries concurrently. Old binaries cannot see v3 claims.

After the first v3 claim, rollback to an old binary is unsupported without a separately designed
quiescent migration/archival operation. Stop and restore the backup rather than deleting claims or
journal directories. There is no general run-schema migration tool in v0.1.
