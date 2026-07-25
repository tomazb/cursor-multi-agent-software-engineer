import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import {
  AmbiguousModelError,
  InexactModelMatchError,
  pickCatalogueModel,
  resolveLogicalModelId,
} from "../src/model-resolution.ts";
import { parseModelCatalogue } from "../src/runtimes/cursor-model-catalogue.ts";
import {
  CursorCliRuntime,
  decodeCursorCliAssistantOutput,
} from "../src/runtimes/cursor-cli.ts";

test("Thermos blocker 1: bracketed default badge preserves the high-effort catalogue row", () => {
  const parsed = parseModelCatalogue([
    "cursor-grok-4.5-high [default]",
    "cursor-grok-4.5-low",
  ].join("\n"));

  assert.deepEqual([...parsed.ids], [
    "cursor-grok-4.5-high",
    "cursor-grok-4.5-low",
  ]);
  assert.deepEqual(parsed.malformedRows, []);
  assert.equal(resolveLogicalModelId("grok-4.5", parsed.ids), "cursor-grok-4.5-high");
});

test("Thermos blocker 1: listModels rejects a partial catalogue instead of selecting from survivors", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.command = process.execPath;
  const runtime = new CursorCliRuntime(config, {
    cwd: await mkdtemp(path.join(os.tmpdir(), "maswe-thermos-partial-cat-")),
    spawnFn: async (_command, args) => {
      if (args[0] === "models") {
        return {
          exitCode: 0,
          stdout: [
            "cursor-grok-4.5-high [unknown-badge]",
            "cursor-grok-4.5-low",
          ].join("\n"),
          stderr: "",
          durationMs: 1,
        };
      }
      return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 };
    },
  });

  await assert.rejects(
    () => runtime.listModels(),
    /malformed catalogue row.*1 valid executable model ID.*Refusing partial catalogue resolution/i,
  );
});

test("Thermos blockers 2 and 4: weak-match classification is typed and cardinality-correct", () => {
  assert.throws(
    () => resolveLogicalModelId("opus", ["cursor-opus-4.8-high"]),
    (error: unknown) => {
      assert.ok(error instanceof InexactModelMatchError);
      assert.equal(error.candidate, "cursor-opus-4.8-high");
      assert.doesNotMatch(error.message, /Ambiguous model/i);
      return true;
    },
  );

  assert.throws(
    () => resolveLogicalModelId("opus", ["cursor-opus-4.8-high", "cursor-opus-4.8-low"]),
    (error: unknown) => {
      assert.ok(error instanceof AmbiguousModelError);
      assert.deepEqual(error.candidates, ["cursor-opus-4.8-high", "cursor-opus-4.8-low"]);
      return true;
    },
  );
});

test("Thermos blocker 2: automatic selection continues after an inexact first approved family", () => {
  assert.equal(
    pickCatalogueModel([
      "cursor-grok-4.5-mini-high",
      "cursor-claude-fable-5-high",
      "cursor-gpt-5.6-sol-high",
    ]),
    "cursor-gpt-5.6-sol-high",
  );
});

test("Thermos blocker 4: literal allowlist hint preserves the actionable effort error", () => {
  assert.throws(
    () => pickCatalogueModel(["cursor-gpt-5.6-sol-medium"], "gpt-5.6-sol-high"),
    /approved smoke-model family hint.*Requested effort 'high'.*Refusing silent effort substitution/i,
  );
});

test("Thermos blocker 4: non-allowlist weak preferences are never mislabeled as a literal hint", () => {
  assert.throws(
    () => pickCatalogueModel(["cursor-opus-4.8-high"], "opus"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Inexact preferred smoke-model selection/i);
      assert.match(error.message, /neither an exact ID.*literal approved-family hint/i);
      assert.doesNotMatch(error.message, /Ambiguous preferred/i);
      return true;
    },
  );
});

test("Thermos decoder cleanup: plain prose is unsupported shape, malformed JSON is invalid transport", () => {
  const prose = decodeCursorCliAssistantOutput("Authentication required. Run agent login.", "json");
  assert.equal(prose.ok, false);
  if (!prose.ok) assert.equal(prose.code, "unsupported-response-shape");

  const malformed = decodeCursorCliAssistantOutput('{"type":"result","result":"x"', "json");
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.code, "invalid-transport-json");
});

test("Codex P1: typeless whole-buffer results are accepted only in json mode", () => {
  const logical = "report\nVERDICT: PASS";
  const raw = JSON.stringify({ result: logical });

  const json = decodeCursorCliAssistantOutput(raw, "json");
  assert.deepEqual(json, { ok: true, text: logical });

  const stream = decodeCursorCliAssistantOutput(raw, "stream-json");
  assert.equal(stream.ok, false);
  if (!stream.ok) {
    assert.equal(stream.code, "unsupported-response-shape");
    assert.match(stream.message, /stream-json.*type=result/i);
  }
});

test("Codex P1: typed terminal results are accepted in both structured modes", () => {
  const logical = "report\nVERDICT: PASS";
  const raw = JSON.stringify({ type: "result", result: logical });

  assert.deepEqual(decodeCursorCliAssistantOutput(raw, "json"), {
    ok: true,
    text: logical,
  });
  assert.deepEqual(decodeCursorCliAssistantOutput(raw, "stream-json"), {
    ok: true,
    text: logical,
  });
});

test("Codex P1: record scanning applies the same format-aware typeless policy", () => {
  const logical = "report\nVERDICT: PASS";
  const raw = ["Cursor banner", JSON.stringify({ result: logical })].join("\n");

  assert.deepEqual(decodeCursorCliAssistantOutput(raw, "json"), {
    ok: true,
    text: logical,
  });

  const stream = decodeCursorCliAssistantOutput(raw, "stream-json");
  assert.equal(stream.ok, false);
  if (!stream.ok) assert.equal(stream.code, "missing-logical-output");
});

function createDecodeFailureRuntime(cwd: string, config: typeof DEFAULT_CONFIG): CursorCliRuntime {
  return new CursorCliRuntime(config, {
    cwd,
    spawnFn: async (_command, args) => {
      if (args[0] === "models") {
        return {
          exitCode: 0,
          stdout: [
            "cursor-grok-4.5-high",
            "cursor-claude-fable-5-high",
            "cursor-claude-opus-4.8-high",
            "gpt-5.6-sol-high",
          ].join("\n"),
          stderr: "",
          durationMs: 1,
        };
      }
      return {
        exitCode: 0,
        stdout: '{"type":"result","result":"broken"',
        stderr: "auth detail that must not replace the structured diagnostic",
        durationMs: 1,
      };
    },
  });
}

function createTypelessStreamRuntime(cwd: string, config: typeof DEFAULT_CONFIG): CursorCliRuntime {
  return new CursorCliRuntime(config, {
    cwd,
    spawnFn: async (_command, args) => {
      if (args[0] === "models") {
        return {
          exitCode: 0,
          stdout: [
            "cursor-grok-4.5-high",
            "cursor-claude-fable-5-high",
            "cursor-claude-opus-4.8-high",
            "gpt-5.6-sol-high",
          ].join("\n"),
          stderr: "",
          durationMs: 1,
        };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          result: "unsupported envelope\nREADY_FOR_BRAINSTORM_APPROVAL",
        }),
        stderr: "raw stderr must not replace the structured diagnostic",
        durationMs: 1,
      };
    },
  });
}

test("Thermos blocker 3: exit-zero decode diagnostics reach the runtime output consumed by operators", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-thermos-decode-diagnostic-"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.command = process.execPath;
  config.runtime.outputFormat = "json";
  config.roles.brainstormer.model = "cursor-grok-4.5-high";
  config.policy.promptTransport = "argv";

  const runtime = createDecodeFailureRuntime(cwd, config);
  const result = await runtime.execute({
    runId: "thermos-decode",
    role: "brainstormer",
    prompt: "hello",
    cwd,
    roleConfig: config.roles.brainstormer,
  });

  assert.equal(result.status, "error");
  assert.match(result.output, /^invalid-transport-json: .*malformed transport JSON/i);
  assert.doesNotMatch(result.output, /auth detail/);
  assert.equal(result.metadata?.decodeCode, "invalid-transport-json");
});

test("Thermos blocker 3: orchestrator persists the structured decode diagnostic instead of a generic empty-output error", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-thermos-orchestrator-diagnostic-"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.kind = "cursor-cli";
  config.runtime.command = process.execPath;
  config.runtime.outputFormat = "json";
  config.policy.promptTransport = "argv";
  config.policy.useIsolatedWorktree = false;
  config.policy.allowDirtyWorkspace = true;
  config.quality.commands = [];

  const run = await new Orchestrator(
    cwd,
    config,
    createDecodeFailureRuntime(cwd, config),
  ).start("decode diagnostic", "exercise the failure path");

  assert.equal(run.state, "FAILED");
  assert.match(
    run.failure?.message ?? "",
    /brainstormer failed for all configured models: .*invalid-transport-json: .*malformed transport JSON/i,
  );
  assert.doesNotMatch(run.failure?.message ?? "", /No output was produced|auth detail/i);
});

test("Codex P1: typeless stream-json result cannot authorize a runtime marker", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-codex-stream-runtime-"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.command = process.execPath;
  config.runtime.outputFormat = "stream-json";
  config.roles.brainstormer.model = "cursor-grok-4.5-high";
  config.policy.promptTransport = "argv";

  const result = await createTypelessStreamRuntime(cwd, config).execute({
    runId: "codex-stream-runtime",
    role: "brainstormer",
    prompt: "hello",
    cwd,
    roleConfig: config.roles.brainstormer,
  });

  assert.equal(result.status, "error");
  assert.match(result.output, /^unsupported-response-shape: .*stream-json.*type=result/i);
  assert.doesNotMatch(result.output, /raw stderr/);
  assert.equal(result.metadata?.decodeCode, "unsupported-response-shape");
});

test("Codex P1: typeless stream-json marker cannot advance the orchestrator", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-codex-stream-orchestrator-"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.kind = "cursor-cli";
  config.runtime.command = process.execPath;
  config.runtime.outputFormat = "stream-json";
  config.policy.promptTransport = "argv";
  config.policy.useIsolatedWorktree = false;
  config.policy.allowDirtyWorkspace = true;
  config.quality.commands = [];

  const run = await new Orchestrator(
    cwd,
    config,
    createTypelessStreamRuntime(cwd, config),
  ).start("typed stream result", "reject unsupported envelope");

  assert.equal(run.state, "FAILED");
  assert.match(
    run.failure?.message ?? "",
    /brainstormer failed for all configured models: .*unsupported-response-shape: .*stream-json.*type=result/i,
  );
  assert.doesNotMatch(
    run.failure?.message ?? "",
    /No output was produced|raw stderr|WAITING_FOR_BRAINSTORM_APPROVAL/i,
  );
});
