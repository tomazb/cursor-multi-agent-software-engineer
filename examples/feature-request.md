# Feature request: organization audit trail

## Problem

Organization administrators cannot determine who changed organization settings, what changed, or when. Support investigations require database access and are slow.

## Desired outcome

Authorized organization administrators can inspect a chronological, append-only audit trail for security-relevant organization setting changes.

## Constraints

- Existing API clients must remain compatible.
- Audit writes must not expose secrets or full credential values.
- Audit write failure must not silently allow a protected setting change.
- Only organization administrators may read the trail.
- Retention and export are not part of the first release.

## Initial acceptance ideas

- A successful protected setting change creates one audit event.
- The event records actor, organization, action, timestamp, request correlation ID, and a redacted before/after summary.
- Unauthorized users cannot list audit events.
- Events are returned newest first with cursor pagination.
- Tests cover successful writes, redaction, authorization, pagination, and audit-storage failure.
