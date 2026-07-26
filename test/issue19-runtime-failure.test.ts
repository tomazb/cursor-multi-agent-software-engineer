import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { RuntimeRequest } from "../src/domain.ts";
import { FAILURE_DIAGNOSTIC_MAX_CODE_POINTS } from "../src/redaction.ts";
import {
  CursorCliRuntime,
  type RuntimeSpawnFn,
} from "../src/runtimes/cursor-cli.ts";

const CANARY = "ISSUE19_CANARY_RUNTIME_SECRET";
const FINE_GRAINED_PAT =
  "github_pat_11SYNTHETICRUNTIMEONLY_abcdefghijklmnopqrstuvwxyz0123456789";
const MODEL = "cursor-grok-4.5-high";

function config() {
  const value = structuredClone(DEFAULT_CONFIG);
  value.runtime.command = "synthetic-cursor";
  value.roles.brainstormer.model = MODEL;
  value.policy.promptTransport = "stdin";
  return value;
}

function request(cwd: string): RuntimeRequest {
  const value = config();
  return {
    runId: "issue19-runtime",
    role: "brainstormer",
    prompt: "synthetic prompt",
    cwd,
    roleConfig: value.roles.brainstormer,
    timeoutMs: 1_234,
  };
}

async function fixture(
  t: test.TestContext,
  executeResult: Awaited<ReturnType<RuntimeSpawnFn>>,
): Promise<{ cwd: string; runtime: CursorCliRuntime }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue19-runtime-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const runtime = new CursorCliRuntime(config(), {
    cwd,
    spawnFn: async (_command, args) =>
      args[0] === "models"
        ? {
            exitCode: 0,
            stdout: `${MODEL}\n`,
            stderr: "",
            durationMs: 1,
            timedOut: false,
          }
        : executeResult,
  });
  return { cwd, runtime };
}

function assertSafeRuntimeFailure(
  result: Awaited<ReturnType<CursorCliRuntime["execute"]>>,
  expectedCode: string,
): void {
  assert.equal(result.status, "error");
  if (result.status !== "error") return;
  assert.equal(result.failure?.code, expectedCode);
  assert.equal(result.failure?.requestedModel, MODEL);
  assert.equal(result.failure?.configuredModel, MODEL);
  assert.equal(result.failure?.promptTransport, "stdin");
  assert.equal(result.failure?.stderrPresent, true);
  assert.equal(JSON.stringify(result).includes(CANARY), false);
  assert.equal(Object.hasOwn(result.metadata ?? {}, "stderr"), false);
  assert.ok([...result.output].length <= FAILURE_DIAGNOSTIC_MAX_CODE_POINTS);
  assert.ok(
    [...(result.failure?.message ?? "")].length <=
      FAILURE_DIAGNOSTIC_MAX_CODE_POINTS,
  );
}

test("Cursor non-zero empty stdout returns a typed safe diagnostic", async (t) => {
  const { cwd, runtime } = await fixture(t, {
    exitCode: 7,
    stdout: "",
    stderr: `permission denied token=${CANARY}`,
    durationMs: 42,
    timedOut: false,
  });

  const result = await runtime.execute(request(cwd));

  assertSafeRuntimeFailure(result, "cursor-cli-non-zero");
  if (result.status !== "error") return;
  assert.equal(result.failure?.exitCode, 7);
  assert.equal(result.failure?.timedOut, false);
  assert.equal(result.failure?.durationMs, 42);
  assert.match(result.output, /permission denied/);
  assert.match(result.output, /\[REDACTED\]/);
});

test("Cursor non-zero structured stdout never promotes stdout or raw stderr", async (t) => {
  const { cwd, runtime } = await fixture(t, {
    exitCode: 9,
    stdout: JSON.stringify({
      type: "result",
      result: `unsafe assistant ${CANARY}\nREADY_FOR_BRAINSTORM_APPROVAL\n`,
    }),
    stderr: `remote rejected Authorization: Bearer ${CANARY}`,
    durationMs: 44,
    timedOut: false,
  });

  const result = await runtime.execute(request(cwd));

  assertSafeRuntimeFailure(result, "cursor-cli-non-zero");
  assert.doesNotMatch(result.output, /unsafe assistant|READY_FOR_BRAINSTORM_APPROVAL/);
  assert.match(result.output, /remote rejected/);
});

test("Cursor timeout remains distinguishable and retains execution metadata", async (t) => {
  const { cwd, runtime } = await fixture(t, {
    exitCode: 124,
    stdout: "",
    stderr: `partial diagnostic token=${CANARY}\nProcess timed out after 1234ms`,
    durationMs: 1_250,
    timedOut: true,
  });

  const result = await runtime.execute(request(cwd));

  assertSafeRuntimeFailure(result, "cursor-cli-timeout");
  if (result.status !== "error") return;
  assert.equal(result.failure?.exitCode, 124);
  assert.equal(result.failure?.timedOut, true);
  assert.equal(result.failure?.durationMs, 1_250);
  assert.match(result.output, /timed out/i);
});

test("Cursor authentication-like prose remains actionable without controlling classification", async (t) => {
  const { cwd, runtime } = await fixture(t, {
    exitCode: 1,
    stdout: "",
    stderr: `Authentication failed. Authorization: Bearer ${CANARY}`,
    durationMs: 10,
    timedOut: false,
  });

  const result = await runtime.execute(request(cwd));

  assertSafeRuntimeFailure(result, "cursor-cli-non-zero");
  assert.match(result.output, /Authentication failed/);
});

test("Cursor runtime removes a synthetic fine-grained GitHub PAT at its first failure boundary", async (t) => {
  const { cwd, runtime } = await fixture(t, {
    exitCode: 1,
    stdout: "",
    stderr: `Git provider rejected ${FINE_GRAINED_PAT}`,
    durationMs: 11,
    timedOut: false,
  });

  const result = await runtime.execute(request(cwd));

  assert.equal(result.status, "error");
  assert.equal(JSON.stringify(result).includes(FINE_GRAINED_PAT), false);
  assert.match(result.output, /Git provider rejected \[REDACTED\]/);
  if (result.status !== "error") return;
  assert.equal(result.failure.message.includes(FINE_GRAINED_PAT), false);
  assert.equal(
    JSON.stringify(result.metadata).includes(FINE_GRAINED_PAT),
    false,
  );
});

test("Cursor very large stderr is redacted before deterministic truncation", async (t) => {
  const large = [
    `token=${CANARY}`,
    "safe diagnostic context",
    "😀".repeat(4_000),
    `Authorization: Bearer ${CANARY}`,
  ].join("\n");
  const { cwd, runtime } = await fixture(t, {
    exitCode: 2,
    stdout: "",
    stderr: large,
    durationMs: 50,
    timedOut: false,
  });

  const first = await runtime.execute(request(cwd));
  const second = await runtime.execute(request(cwd));

  assertSafeRuntimeFailure(first, "cursor-cli-non-zero");
  assert.deepEqual(first, second);
  if (first.status !== "error") return;
  assert.equal(first.failure?.truncated, true);
  assert.match(first.output, /… \[truncated\]$/);
});

test("Cursor process-spawn failure is typed and safe", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue19-spawn-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let calls = 0;
  const runtime = new CursorCliRuntime(config(), {
    cwd,
    spawnFn: async (_command, args) => {
      calls += 1;
      if (args[0] === "models") {
        return {
          exitCode: 0,
          stdout: `${MODEL}\n`,
          stderr: "",
          durationMs: 1,
        };
      }
      throw new Error(`spawn EACCES token=${CANARY}`);
    },
  });

  const result = await runtime.execute(request(cwd));

  assert.equal(calls, 2);
  assert.equal(result.status, "error");
  if (result.status !== "error") return;
  assert.equal(result.failure?.code, "cursor-cli-spawn");
  assert.equal(JSON.stringify(result).includes(CANARY), false);
  assert.match(result.output, /spawn EACCES/);
});

test("exit-zero decode failure preserves PR 15 operator codes without stderr", async (t) => {
  const value = config();
  value.runtime.outputFormat = "json";
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue19-decode-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const runtime = new CursorCliRuntime(value, {
    cwd,
    spawnFn: async (_command, args) =>
      args[0] === "models"
        ? {
            exitCode: 0,
            stdout: `${MODEL}\n`,
            stderr: "",
            durationMs: 1,
          }
        : {
            exitCode: 0,
            stdout: "{malformed",
            stderr: `Authorization: Bearer ${CANARY}`,
            durationMs: 6,
            timedOut: false,
          },
  });

  const result = await runtime.execute(request(cwd));

  assert.equal(result.status, "error");
  if (result.status !== "error") return;
  assert.equal(result.failure?.code, "invalid-transport-json");
  assert.match(result.output, /^invalid-transport-json: /);
  assert.equal(JSON.stringify(result).includes(CANARY), false);
  assert.equal(Object.hasOwn(result.metadata ?? {}, "stderr"), false);
});

test("catalogue and doctor failures redact bounded stderr", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue19-doctor-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const value = config();
  const runtime = new CursorCliRuntime(value, {
    cwd,
    spawnFn: async (_command, args) => {
      if (args[0] === "--version") {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `login failed token=${CANARY}`,
          durationMs: 2,
        };
      }
      return {
        exitCode: 3,
        stdout: "",
        stderr: `catalogue unavailable token=${CANARY}`,
        durationMs: 2,
      };
    },
  });

  await assert.rejects(
    runtime.listModels(),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.equal(message.includes(CANARY), false);
      assert.match(message, /catalogue unavailable/);
      assert.ok([...message].length <= FAILURE_DIAGNOSTIC_MAX_CODE_POINTS);
      return true;
    },
  );

  const doctor = await runtime.doctor();
  const rendered = JSON.stringify(doctor);
  assert.equal(rendered.includes(CANARY), false);
  assert.match(rendered, /login failed/);
});
