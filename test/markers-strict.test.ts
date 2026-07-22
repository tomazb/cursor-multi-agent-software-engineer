import assert from "node:assert/strict";
import test from "node:test";
import { parseRoleMarker, validateRoleMarkers } from "../src/markers.ts";

test("parseRoleMarker accepts a single bare final-line marker", () => {
  const parsed = parseRoleMarker("verifier", "notes\nVERDICT: FAIL\n");
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.marker, "VERDICT: FAIL");
    assert.equal(parsed.value, "FAIL");
  }
});

test("rejects PASS then FAIL when FAIL is not exclusively terminal without conflict scan", () => {
  // Conflicting verdicts anywhere + final line must be unambiguous:
  // body has PASS then FAIL - if both appear as markers, reject unless only final counts AND no other marker lines.
  // Spec: require exactly one valid terminal marker in the output's terminal position,
  // reject conflicting/duplicate markers in the document.
  const result = validateRoleMarkers(
    "verifier",
    ["analysis", "VERDICT: PASS", "more", "VERDICT: FAIL"].join("\n"),
  );
  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /conflict|duplicate|ambiguous/i);
});

test("rejects FAIL then PASS conflicting markers", () => {
  const result = validateRoleMarkers(
    "verifier",
    ["VERDICT: FAIL", "explanation", "VERDICT: PASS"].join("\n"),
  );
  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /conflict|duplicate|ambiguous/i);
});

test("rejects conflicting SCOPE markers", () => {
  const result = validateRoleMarkers(
    "prResolver",
    ["SCOPE: IN_SCOPE", "notes", "SCOPE: OUT_OF_SCOPE"].join("\n"),
    { mode: "classify" },
  );
  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /conflict|duplicate|ambiguous/i);
});

test("rejects quoted or embedded markers that are not the bare final line", () => {
  assert.equal(
    validateRoleMarkers("builder", 'Say "BUILD_COMPLETE" when done\nBUILD_COMPLETE').ok,
    false,
  );
  assert.equal(validateRoleMarkers("builder", "Almost BUILD_COMPLETE now").ok, false);
  assert.equal(validateRoleMarkers("builder", "done\nBUILD_COMPLETE").ok, true);
});

test("typed parse result drives verifier transition decision", () => {
  const pass = parseRoleMarker("verifier", "summary\nVERDICT: PASS");
  const fail = parseRoleMarker("verifier", "summary\nVERDICT: FAIL");
  assert.equal(pass.ok && pass.value === "PASS", true);
  assert.equal(fail.ok && fail.value === "FAIL", true);
});
