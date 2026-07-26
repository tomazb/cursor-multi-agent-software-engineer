import assert from "node:assert/strict";
import test from "node:test";
import { serializeCursorSdkResult } from "../src/runtimes/cursor-sdk.ts";

test("Cursor SDK result serialization preserves JSON-compatible output", () => {
  assert.equal(serializeCursorSdkResult("assistant text"), "assistant text");
  assert.equal(serializeCursorSdkResult({ answer: 42 }), '{\n  "answer": 42\n}');
});

test("Cursor SDK result serialization always returns a string for JSON edge values", () => {
  assert.equal(serializeCursorSdkResult(undefined), "");
  assert.equal(serializeCursorSdkResult(Symbol("opaque")), "Symbol(opaque)");
  assert.equal(serializeCursorSdkResult(42n), "42");
});
