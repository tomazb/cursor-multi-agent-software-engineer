# ADR-0007: Treat catalogue rows and smoke preferences as executable policy inputs

- Status: Accepted
- Date: 2026-07-24

## Context

Cursor CLI model discovery is executable configuration. MASWE uses its output to resolve logical
role models and to select a concrete model for opt-in authenticated smoke tests. Two narrow trust
boundary gaps remained after v0.2:

- a preferred exact smoke model could resolve outside the approved smoke-family allowlist; and
- an ID-shaped token followed by ordinary prose could be mistaken for a catalogue row.

The existing exact-ID run snapshot and effort-aware logical resolution contracts must remain
unchanged.

## Decision

### Catalogue row grammar

Cursor catalogue parsing remains stdout-only and strips ANSI control sequences before parsing. A
row contributes only its first exact model-ID field and must match one of these structures after
optional indentation:

- an ID by itself;
- an ID after one known bullet or selection prefix;
- an ID followed by the known `(default)` badge;
- an ID followed by a spaced hyphen, en dash, or em dash description column;
- an ID followed by a tab-separated column; or
- an ID followed by an aligned column separated by at least two spaces.

A single ordinary space followed by text is not a structural column. For example,
`gpt-4-turbo is recommended for this task` is classified as a malformed row and contributes no ID.
Unknown trailing annotations are also malformed. Headings, aliases, metadata, Markdown headings,
standalone annotations, and non-ID prose remain ignored.

The parser returns valid IDs plus deterministic malformed-row diagnostics. `CursorCliRuntime`
continues when at least one valid ID exists and ignores malformed candidates. When no valid ID
exists, malformed candidates produce a distinct malformed-catalogue error; empty, headings-only,
or otherwise unparseable output retains the generic no-executable-ID failure.

### Smoke-model policy

Automatic smoke selection continues to resolve the ordered allowlist:

1. `grok-4.5`
2. `gpt-5.6-sol-high`
3. `claude-fable-5`

A preferred value that exactly matches a discovered catalogue ID is an exact-ID contract: MASWE
requires that exact ID to belong to an approved logical family. An allowlist entry with an explicit
effort suffix also constrains the exact ID to that effort; for example, `gpt-5.6-sol-high` does not
authorize a medium variant. An absent or disallowed exact ID fails closed and never falls back.

For compatibility with existing smoke fixtures, a preferred value may instead equal one literal
allowlist entry and act as an approved family hint. No other absent or logical preferred value is
eligible. This compatibility path cannot broaden the family policy: it invokes the same ordered,
effort-aware resolver for that already approved allowlist token. Ambiguous exact or logical
preferences fail closed with a distinct ambiguity error.

Authenticated smoke tests may set `MASWE_MODEL_BRAINSTORMER`. Use an exact model ID returned by the
same `agent models` catalogue when pinning a concrete smoke model. Omitting the variable uses the
ordered automatic allowlist; a literal allowlist token is accepted only as the bounded family-hint
compatibility form described above.

## Consequences

### Positive

- Explicit exact IDs and automatic selection enforce one family and effort policy.
- The only logical preference compatibility path is itself the literal allowlist.
- Leading-ID prose cannot become executable model configuration.
- Failures distinguish absent exact IDs, disallowed families, malformed catalogue rows, and
  ambiguous selection.
- Persisted exact run IDs and new-run effort-aware resolution are unchanged.

### Negative

- Cursor catalogue format changes that do not match a documented row structure fail closed until
  the grammar and regression fixtures are deliberately updated.
- Human-readable rows separated by a single space are rejected even when their first token happens
  to be a valid model ID; the CLI must use an accepted structural delimiter.
