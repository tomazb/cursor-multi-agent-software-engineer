import assert from "node:assert/strict";
import test from "node:test";
import { requiredMarkerForRole, validateRoleMarkers } from "../src/markers.ts";

test("each role declares a required terminal marker family", () => {
  assert.match(requiredMarkerForRole("brainstormer"), /READY_FOR_BRAINSTORM_APPROVAL/);
  assert.match(requiredMarkerForRole("designer"), /READY_FOR_DESIGN_APPROVAL/);
  assert.match(requiredMarkerForRole("builder"), /BUILD_COMPLETE/);
  assert.match(requiredMarkerForRole("verifier"), /VERDICT/);
  assert.match(requiredMarkerForRole("prResolver"), /RESOLUTION_COMPLETE/);
});

test("validateRoleMarkers accepts outputs that include the required marker", () => {
  assert.equal(
    validateRoleMarkers("brainstormer", "notes\nREADY_FOR_BRAINSTORM_APPROVAL\n").ok,
    true,
  );
  assert.equal(validateRoleMarkers("builder", "done\nBUILD_COMPLETE").ok, true);
  assert.equal(validateRoleMarkers("verifier", "VERDICT: PASS").ok, true);
  assert.equal(validateRoleMarkers("verifier", "VERDICT: FAIL").ok, true);
});

test("validateRoleMarkers rejects missing or ambiguous markers", () => {
  const missing = validateRoleMarkers("builder", "I think we are done");
  assert.equal(missing.ok, false);
  assert.match(missing.message ?? "", /BUILD_COMPLETE/);

  const badVerdict = validateRoleMarkers("verifier", "looks good");
  assert.equal(badVerdict.ok, false);
});

test("classifier scope markers are validated separately", () => {
  assert.equal(validateRoleMarkers("prResolver", "SCOPE: IN_SCOPE", { mode: "classify" }).ok, true);
  assert.equal(
    validateRoleMarkers("prResolver", "SCOPE: OUT_OF_SCOPE", { mode: "classify" }).ok,
    true,
  );
  assert.equal(validateRoleMarkers("prResolver", "maybe in scope", { mode: "classify" }).ok, false);
});
