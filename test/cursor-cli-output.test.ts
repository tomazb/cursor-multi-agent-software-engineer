import assert from "node:assert/strict";
import test from "node:test";
import { extractCursorCliOutput } from "../src/runtimes/cursor-cli.ts";
import { parseRoleMarker } from "../src/markers.ts";

test("extractCursorCliOutput unwraps single json result objects", () => {
  const raw = JSON.stringify({
    type: "result",
    subtype: "success",
    result: "notes\nREADY_FOR_BRAINSTORM_APPROVAL\n",
  });
  const text = extractCursorCliOutput(raw);
  assert.equal(text, "notes\nREADY_FOR_BRAINSTORM_APPROVAL\n");
  assert.equal(parseRoleMarker("brainstormer", text).ok, true);
});

test("extractCursorCliOutput unwraps stream-json NDJSON terminal result", () => {
  const raw = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      result: "# Brainstorm\n\nReady.\nREADY_FOR_BRAINSTORM_APPROVAL\n",
    }),
  ].join("\n");
  const text = extractCursorCliOutput(raw);
  assert.match(text, /^# Brainstorm/);
  assert.equal(parseRoleMarker("brainstormer", text).ok, true);
});

test("extractCursorCliOutput keeps text-mode stdout", () => {
  const raw = "# Brainstorm\n\nReady.\nREADY_FOR_BRAINSTORM_APPROVAL\n";
  assert.equal(extractCursorCliOutput(raw), raw);
});

test("raw json stdout without extraction would look like an embedded marker", () => {
  const raw = JSON.stringify({
    type: "result",
    result: "body\nREADY_FOR_BRAINSTORM_APPROVAL\n",
  });
  // Token appears quoted in the raw JSON line.
  assert.equal(parseRoleMarker("brainstormer", raw).ok, false);
  assert.equal(parseRoleMarker("brainstormer", extractCursorCliOutput(raw)).ok, true);
});
