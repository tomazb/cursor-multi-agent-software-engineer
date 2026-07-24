import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { pickCatalogueModel } from "../src/model-resolution.ts";
import {
  parseModelCatalogue,
  parseModelCatalogueIds,
} from "../src/runtimes/cursor-model-catalogue.ts";
import { CursorCliRuntime } from "../src/runtimes/cursor-cli.ts";

const CATALOGUE = [
  "cursor-grok-4.5-high",
  "cursor-grok-4.5-low",
  "cursor-gpt-5.6-sol-high-fast",
  "cursor-gpt-5.6-sol-medium",
  "cursor-claude-fable-5-high",
  "cursor-claude-opus-4.8-high",
];

test("approved exact smoke override is accepted", () => {
  assert.equal(
    pickCatalogueModel(CATALOGUE, "CURSOR-GROK-4.5-LOW"),
    "cursor-grok-4.5-low",
  );
  assert.equal(
    pickCatalogueModel(CATALOGUE, "cursor-gpt-5.6-sol-high-fast"),
    "cursor-gpt-5.6-sol-high-fast",
  );
});

test("present exact smoke override outside approved families is rejected", () => {
  assert.throws(
    () => pickCatalogueModel(CATALOGUE, "cursor-claude-opus-4.8-high"),
    /disallowed family.*approved families/i,
  );
});

test("absent exact smoke override is rejected without automatic fallback", () => {
  assert.throws(
    () => pickCatalogueModel(CATALOGUE, "cursor-grok-4.5-medium"),
    /absent from the discovered catalogue.*never fall back/i,
  );
});

test("effort-bound approved family rejects a present wrong-effort exact override", () => {
  assert.throws(
    () => pickCatalogueModel(CATALOGUE, "cursor-gpt-5.6-sol-medium"),
    /disallowed family.*gpt-5\.6-sol-high/i,
  );
});

test("automatic smoke selection remains constrained to approved families", () => {
  assert.equal(
    pickCatalogueModel(["aaa-unapproved-1", "cursor-claude-fable-5-high"]),
    "cursor-claude-fable-5-high",
  );
  assert.throws(
    () => pickCatalogueModel(["aaa-unapproved-1", "cursor-claude-opus-4.8-high"]),
    /No approved smoke model family/i,
  );
});

test("automatic smoke selection reports ambiguous approved-family matches distinctly", () => {
  assert.throws(
    () => pickCatalogueModel(["alpha-grok-4.5-1", "beta-grok-4.5-2"]),
    /Ambiguous smoke-model selection.*approved family 'grok-4\.5'/i,
  );
});

test("catalogue parser rejects leading-ID prose and unknown annotations", () => {
  const parsed = parseModelCatalogue([
    "gpt-4-turbo is recommended for this task",
    "gpt-4-turbo (recommended for this task)",
    "gpt-4-turbo -",
  ].join("\n"));

  assert.deepEqual([...parsed.ids], []);
  assert.deepEqual(
    parsed.malformedRows.map((row) => row.candidate),
    ["gpt-4-turbo", "gpt-4-turbo", "gpt-4-turbo"],
  );
});

test("catalogue parser preserves plain, selected, indented, ANSI, and structural-column rows", () => {
  const ids = parseModelCatalogueIds([
    "Available models:",
    "gpt-5.6-sol-high",
    "  cursor-grok-4.5-high",
    "* cursor-claude-fable-5-high (default)",
    "> composer-2.5",
    "\x1b[32mcursor-gpt-5.4-high\x1b[0m - Cursor GPT",
    "model+plus-1.0  aligned display column",
    "dotted.model-2\ttabbed display column",
    "cursor-grok-4.5-low - fallback would be cursor-grok-4.5-medium",
  ].join("\n"));

  assert.deepEqual([...ids], [
    "gpt-5.6-sol-high",
    "cursor-grok-4.5-high",
    "cursor-claude-fable-5-high",
    "composer-2.5",
    "cursor-gpt-5.4-high",
    "model+plus-1.0",
    "dotted.model-2",
    "cursor-grok-4.5-low",
  ]);
});

test("catalogue parser still ignores headings, aliases, metadata, prose, and standalone annotations", () => {
  const parsed = parseModelCatalogue([
    "Available models:",
    "alias: old-model-1",
    "metadata: build-42",
    "context-200k",
    "recommended model is gpt-4-turbo",
    "# Models",
    "(default)",
    "  - see also gpt-4-turbo in docs",
  ].join("\n"));

  assert.deepEqual([...parsed.ids], []);
  assert.deepEqual(parsed.malformedRows, []);
});

test("Cursor listModels distinguishes malformed rows when no valid IDs remain", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.command = process.execPath;
  const runtime = new CursorCliRuntime(config, {
    cwd: await mkdtemp(path.join(os.tmpdir(), "maswe-issue12-malformed-cat-")),
    spawnFn: async (_command, args) => {
      if (args[0] === "models") {
        return {
          exitCode: 0,
          stdout: "gpt-4-turbo is recommended for this task\n",
          stderr: "",
          durationMs: 1,
        };
      }
      return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 };
    },
  });

  await assert.rejects(
    () => runtime.listModels(),
    /malformed catalogue row.*gpt-4-turbo.*no valid executable model IDs/i,
  );
});
