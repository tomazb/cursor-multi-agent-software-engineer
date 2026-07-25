# ADR-0007: Treat catalogue rows and smoke preferences as executable policy inputs

- Status: Accepted
- Date: 2026-07-24
- Amended: 2026-07-25 after Thermos review of PR #15

## Context

Cursor CLI model discovery is executable configuration. MASWE uses its output to resolve logical
role models and to select a concrete model for opt-in authenticated smoke tests. The trust boundary
must cover both individual row recognition and completeness of the resulting catalogue set.

The original PR #15 implementation closed two narrow gaps:

- a preferred exact smoke model could resolve outside the approved smoke-family allowlist; and
- an ID-shaped token followed by ordinary prose could be mistaken for a catalogue row.

Thermos review then reproduced a composition defect: rejecting one high-effort row while silently
accepting a lower-effort survivor could cause the wrong model to be selected. The review also found
that weak substring matches were classified through error-message prose, causing one candidate to
be called ambiguous and the automatic allowlist to abort before trying later approved families.

The existing exact-ID run snapshot and effort-aware logical resolution contracts must remain
unchanged.

## Decision

### Catalogue row grammar and completeness

Cursor catalogue parsing remains stdout-only and strips ANSI control sequences before parsing. A
row contributes only its first exact model-ID field and must match one of these structures after
optional indentation:

- an ID by itself;
- an ID after one known bullet or selection prefix;
- an ID followed by the known `(default)` or `[default]` badge;
- an ID followed by a spaced hyphen, en dash, or em dash description column;
- an ID followed by a tab-separated column; or
- an ID followed by an aligned column separated by at least two spaces.

A single ordinary space followed by text is not a structural column. For example,
`gpt-4-turbo is recommended for this task` is classified as a malformed row and contributes no ID.
Unknown trailing annotations are also malformed. Headings, aliases, metadata, Markdown headings,
standalone annotations, and non-ID prose remain ignored.

The parser returns valid IDs plus deterministic malformed-row diagnostics. `CursorCliRuntime`
rejects the entire discovery result whenever any malformed ID-shaped row is present, even if valid
IDs also survive. It never resolves from a partial catalogue because an omitted row could change
family or effort selection. Empty, headings-only, and otherwise unparseable output retains the
generic no-executable-ID failure.

### Typed logical resolution

Logical resolution distinguishes these outcomes structurally rather than by matching error text:

- exact or same-core resolution;
- one weak substring candidate, classified as an inexact match;
- multiple weak substring candidates, classified as ambiguity;
- unavailable requested effort; and
- no candidate.

One weak candidate remains fail-closed, but it is not called ambiguous. Control flow may inspect
typed errors or result discriminants; it must not inspect human-readable exception prose.

### Smoke-model policy

Automatic smoke selection resolves the ordered allowlist:

1. `grok-4.5`
2. `gpt-5.6-sol-high`
3. `claude-fable-5`

A family-specific unknown, inexact, ambiguous, or effort failure is recorded and automatic
selection continues to the next approved family. Selection fails only after no approved family can
resolve. The final error includes the family-specific attempts.

A preferred value that exactly matches a discovered catalogue ID is an exact-ID contract: MASWE
requires that exact ID to belong to an approved logical family. An allowlist entry with an explicit
effort suffix also constrains the exact ID to that effort; for example, `gpt-5.6-sol-high` does not
authorize a medium variant. An absent or disallowed exact ID fails closed and never falls back.

For compatibility with existing smoke fixtures, a preferred value may instead equal one literal
allowlist entry and act as an approved family hint. No other absent or logical preferred value is
eligible. An unresolved literal hint preserves the actionable typed resolver cause, including an
effort-substitution refusal, instead of being relabeled as an invalid preference shape.

Authenticated smoke tests may set `MASWE_MODEL_BRAINSTORMER`. Use an exact model ID returned by the
same complete `agent models` catalogue when pinning a concrete smoke model. Omitting the variable
uses the ordered automatic allowlist; a literal allowlist token is accepted only as the bounded
family-hint compatibility form described above.

## Consequences

### Positive

- Explicit exact IDs and automatic selection enforce one family and effort policy.
- The only logical preference compatibility path is itself the literal allowlist.
- Leading-ID prose cannot become executable model configuration.
- Partial catalogue drift cannot silently downgrade or otherwise change model selection.
- Failures distinguish unknown, inexact, ambiguous, effort-unavailable, disallowed-family, and
  invalid-preference outcomes without regex coupling to diagnostic prose.
- Ambiguity or an inexact derivative in one approved family does not suppress a valid later family.
- Persisted exact run IDs and new-run effort-aware resolution are unchanged.

### Negative

- Cursor catalogue format changes that do not match a documented row structure fail the whole
  catalogue until the grammar and regression fixtures are deliberately updated.
- Human-readable rows separated by a single space are rejected even when their first token happens
  to be a valid model ID; the CLI must use an accepted structural delimiter.
- Automatic smoke-selection diagnostics can contain several family-specific failure summaries,
  which is more verbose than reporting only the final attempted family.
