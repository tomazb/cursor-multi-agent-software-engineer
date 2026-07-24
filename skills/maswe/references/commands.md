# MASWE command reference

## Initialize

```bash
maswe init
maswe init --force
```

Never use `--force` without checking whether the existing configuration contains project-specific settings.

## Diagnose

```bash
agent models
maswe doctor
```

Model catalogue mismatches require a config edit, not a prompt workaround. MASWE accepts the first
model-ID field only from recognized catalogue rows: an ID alone or after a known selection prefix,
optionally followed by `(default)`, a spaced dash description, a tab-separated column, or a column
aligned with at least two spaces. ANSI decoration is stripped. A line such as
`gpt-4-turbo is recommended for this task` is leading-ID prose, not a model row. Empty,
headings-only, malformed-only, and otherwise unparseable catalogues fail closed.

Authenticated smoke helpers choose only from the approved family allowlist. A preferred concrete
smoke model must be an exact ID present in the discovered catalogue and must satisfy the same family
and effort policy; an invalid exact preference never falls back. For compatibility, one literal
allowlist family token may be used as a bounded family hint. Omit the preference for normal ordered
automatic selection.

## Start

```bash
maswe start --title "Title" --request-file path/to/request.md
maswe start --title "Title" --request "Request text"
```

## Inspect

```bash
maswe status
maswe status <run-id>
maswe status <run-id> --json
```

Open artifacts under `.maswe/runs/<run-id>/artifacts/` before approval.

## Approval

```bash
maswe approve <run-id> brainstorm
maswe approve <run-id> design
```

The command advances automatically until the next gate.

## Resume automatic work

```bash
maswe run <run-id>
```

This is valid only for automatic states such as building, CI, verification, classification, or resolution. Use the state-specific command at human gates.

## PR review

```bash
maswe pr-opened <run-id>
maswe review-comment <run-id> --text "..."
maswe review-comment <run-id> --file /path/to/comment.md
maswe resume-review <run-id>
```

## Finish, recover, or stop

```bash
maswe merge-ready <run-id>
maswe complete <run-id>
maswe cancel <run-id>
maswe retry <run-id>
maswe supersede <run-id>
```

These commands record workflow state; they do not merge or close a GitHub PR. `retry` resumes a `FAILED` run from `failure.resumeState`. `supersede` creates a linked replacement run.

## Locks

```bash
maswe unlock <run-id>
maswe unlock <run-id> --force
maswe unlock-admin <run-id>
maswe unlock-admin <run-id> --force
```

Data, admin, and admin-recovery locks are immutable ticket journals and are never auto-reclaimed
by age. Non-force recovery accepts a valid dead data/admin owner and rejects live, corrupt, or
ambiguous state. `--force` is an explicit assertion that affected data/admin processes are
quiescent; it is not process fencing. A live administrative-recovery owner is never revoked,
including with force.

Recovery publishes one deterministic release for the exact ticket and digest. It does not delete
claims, successor records, or `.lock-journal-v3` infrastructure. Do not manually remove journal
files. NFS, SMB, distributed FUSE, object-store mounts, and other filesystems without coherent
atomic hard-link publication are unsupported. Mixed old/new binaries and rollback after the first
v3 claim are unsupported without a fully quiescent separately designed migration.

Logical role models resolve only on `doctor`/`start`. Existing-run commands use the exact IDs persisted in `run.config` and fail closed if those IDs leave the catalogue.
