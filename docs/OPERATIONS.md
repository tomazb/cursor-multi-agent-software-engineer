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
```

A model check is best effort because catalogue formatting is controlled by the Cursor CLI. Treat a doctor failure as a reason to inspect `agent models`, not as proof the provider is unavailable.

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

## 5. Use a dedicated branch or worktree

v0.1 does not create git isolation. Before approving design, create a feature branch or worktree:

```bash
git switch -c feature/organization-audit-trail
```

Keep the workspace clean. A clean checkout makes read-only enforcement and recovery easier to reason about.

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

- `run.failure` in `run.json`.
- Last transition details.
- Runtime stderr captured in the failure or stage output.
- Cursor authentication and model availability.

A failed run is terminal in v0.1. Copy the approved request/artifacts into a new run after fixing the cause. A formal retry-from-failed command is planned.

### Quality failure loop

CI failure returns to `BUILDING`. The builder sees the latest quality artifact on the next pass. After `maxBuildVerifyCycles`, the run fails.

### Verifier failure loop

A failed verifier returns to `BUILDING`. The next builder prompt includes the latest deterministic quality and independent verification reports so defects can be addressed directly.

### Read-only violation

The run fails if a read-only role changes workspace state. Inspect `git status` and revert only changes attributable to that role. Preserve unrelated user work.

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

There is no run-schema migration tool in v0.1. Avoid upgrading the code that operates an active run across breaking changes.
