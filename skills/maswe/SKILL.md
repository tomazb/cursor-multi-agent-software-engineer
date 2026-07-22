---
name: maswe
description: Use when the user explicitly asks to start, inspect, approve, resume, or operate a Cursor Multi-Agent Software Engineer workflow. This skill delegates durable state and model routing to the repository's `maswe` CLI rather than simulating the workflow in one chat.
disable-model-invocation: true
---

# MASWE workflow control

Use this skill only for explicit MASWE workflow operations.

## Preconditions

1. Confirm the current workspace is the intended target repository.
2. Look for `.maswe/config.json` or `devflow.config.json`.
3. Confirm the `maswe` executable is available with `maswe help`.
4. If it is not globally available and this repository is open, use `npm run dev -- <command>` after dependencies are installed.
5. Confirm Superpowers is installed. If not, instruct the user to run `/add-plugin superpowers` in Cursor.
6. Before a real model run, use `maswe doctor` and surface failures rather than bypassing them.

## Operating rules

- The CLI is the source of truth for state. Never infer or invent a transition from chat context.
- Read run artifacts before asking the user to approve a gate.
- Do not approve brainstorming or design on the user's behalf.
- Do not edit `run.json` manually.
- Do not skip deterministic quality or independent verification.
- Do not process a review comment as in-scope without the classifier stage.
- Do not mark merge-ready unless the current run state allows it and external repository policy has passed.

## Common operations

Read `references/commands.md` for exact commands and recovery behavior.

When the user asks to start a feature, prefer a request file so the original input is durable:

```bash
maswe start --title "<title>" --request-file "<path>"
```

After execution, report the run ID, state, artifact paths, any failure, and the single next user decision. Do not summarize an artifact without opening it first.
