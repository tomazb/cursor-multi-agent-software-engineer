# Node.js Version Guidance Design

Date: 2026-07-28
Topic: Node.js version guidance for local development and validation
Status: Approved

## Goal

Clarify Node.js expectations by documenting both:

- minimum supported version (`>=22.15`), and
- explicitly tested versions (22.22 and 22.23).

## Scope

In scope:

- `README.md` prerequisites text
- `docs/DEVELOPMENT.md` toolchain text

Out of scope:

- Runtime/orchestrator code changes
- Workflow state or policy changes
- Dependency or build pipeline changes

## Selected approach

Use documentation updates only while keeping `package.json` `engines.node` unchanged at `>=22.15`.

Rationale:

- Preserves current compatibility contract.
- Adds concrete, recent validation context for contributors.
- Avoids introducing stricter engine constraints without evidence of necessity.

## Design details

### Architecture and components

- Keep existing architecture unchanged.
- Update only human-facing environment guidance in README and development docs.

### Data flow

- Contributors read prerequisites/toolchain guidance before running install/check/build.
- No code path or runtime behavior changes.

### Error handling

- No new runtime error handling is introduced.
- Documentation language must avoid contradiction by separating:
  - minimum supported version (`>=22.15`), and
  - tested versions (22.22, 22.23).

### Testing and acceptance

Acceptance criteria:

1. Documentation clearly distinguishes minimum supported vs tested versions.
2. `package.json` engine floor remains `>=22.15`.
3. Existing validation command (`npm run check`) succeeds after updates.

## Risks and mitigations

- Risk: readers may interpret tested versions as strict requirements.
  - Mitigation: explicit wording that tested versions are validation targets, not new minimum constraints.
