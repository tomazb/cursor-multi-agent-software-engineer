# Security policy

## Supported versions

Until the first stable release, only the latest commit on `main` is supported.

## Reporting a vulnerability

Report vulnerabilities privately to the repository owner through GitHub's private vulnerability reporting feature when enabled, or through a private contact channel. Do not include secrets, production source code, or exploit details in a public issue.

Include:

- Affected version or commit.
- Reproduction steps.
- Expected and observed impact.
- Suggested mitigation when known.

## High-priority vulnerability classes

- Credential exposure in prompts, logs, artifacts, or child-process arguments.
- Bypass of read-only role enforcement.
- Unauthorized workspace, branch, PR, or review-thread modification.
- Prompt injection that crosses an approval or scope boundary.
- Model fallback or identity mismatch that is not surfaced.
- Artifact tampering or verification applied to a different git state.
- Shell command injection through untrusted configuration or webhook input.

See [docs/SECURITY.md](docs/SECURITY.md) for the system threat model.
