# Contributing

Thank you for improving Cursor Multi-Agent Software Engineer.

## Before opening a change

1. Check the roadmap and open issues for overlapping work.
2. For behavior or architecture changes, write a short problem statement and acceptance criteria first.
3. For significant decisions, add or update an ADR under `docs/adr/`.

## Local workflow

```bash
npm install
npm run check
```

Create a focused branch and keep commits reviewable. Tests should cover the state-machine path and failure path for any new stage, event, runtime, or policy.

## Pull-request expectations

- Explain the problem and the chosen solution.
- Link requirements or issue IDs.
- List commands executed and their results.
- Call out security, migration, compatibility, and configuration effects.
- Update README and operational documentation when user behavior changes.
- Do not combine unrelated refactors with a feature or bug fix.

## Design constraints

- The orchestrator, not a model, owns state transitions.
- Deterministic tools own tests, builds, git publishing, and merge gates.
- A resolver cannot verify its own edits.
- Read-only stages must remain mechanically checked.
- Runtime adapters must implement the `AgentRuntime` interface and keep SDK details isolated.
- Existing artifact names and state values are public contracts; changing them requires a migration plan.

## Reporting security issues

Do not open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).
