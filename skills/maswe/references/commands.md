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

Model catalogue mismatches require a config edit, not a prompt workaround.

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

Data locks and admin locks are never auto-reclaimed. Use `unlock-admin` only when `.admin.lock` is stale/corrupt after confirming no writer is active.

Logical role models resolve only on `doctor`/`start`. Existing-run commands use the exact IDs persisted in `run.config` and fail closed if those IDs leave the catalogue.

