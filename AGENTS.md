# Agent instructions

This repository implements a deterministic multi-agent software delivery orchestrator. Preserve the boundary between orchestration and model behavior.

## Required engineering behavior

- Read `docs/PRD.md`, `docs/ARCHITECTURE.md`, and relevant ADRs before changing architecture.
- Use Superpowers skills when available: brainstorming for product decisions, writing-plans for design, test-driven-development for implementation, and verification-before-completion before claiming success.
- Write or update tests for every behavioral change.
- Run `npm run check` before completion.
- Never weaken approval, read-only, model, scope, or verification policies merely to make a test pass.
- Keep runtime-specific code in `src/runtimes/`; core workflow code must not import a provider SDK directly.
- Keep state transitions centralized in `src/state-machine.ts`.
- Persist handoffs through artifacts; do not add hidden cross-agent conversation state.
- Do not store credentials, model responses containing secrets, or repository tokens in committed files.

## Definition of done

A change is complete only when requirements are mapped to tests, tests pass, type checking passes, the build succeeds, documentation is updated, and no unrelated files are changed.

## Cursor Cloud specific instructions

This is a self-contained TypeScript ESM CLI (`maswe`). There are no databases, servers, or external services to run; the only dependencies are dev-only (`typescript`, `@types/node`). Standard commands live in `package.json` scripts, `README.md`, and `docs/DEVELOPMENT.md` — use those.

Non-obvious caveats:

- Node version: the default `node` on the VM is v22.14.0, while `package.json` `engines` asks for `>=22.15`. This mismatch is advisory only — `npm install`, `npm run check`, and the CLI all run fine on 22.14.0. If you need an exact engine match, `nvm` has v22.22.2 installed (`export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"`).
- Tests and `npm run dev` execute TypeScript directly via Node's `--experimental-strip-types`; only `npm run build` uses `tsc`. Avoid TS syntax unsupported by strip-only mode (no enums/parameter properties), per `docs/DEVELOPMENT.md`.
- Running the workflow end-to-end without Cursor credentials: set the runtime to `mock` (either `runtime.kind: "mock"` in the config or `MASWE_RUNTIME=mock`). The default `cursor-cli` runtime requires the authenticated `agent` executable, which is not present in this environment.
- The orchestrator acts on a separate target repository passed via `--cwd`, not on this repo. That target must be a clean git checkout (or set `policy.allowDirtyWorkspace=true`), and the config's `quality.commands` are executed inside that target directory.
- This repo does not commit a `package-lock.json`; `npm install` regenerates one locally. Do not commit it.
