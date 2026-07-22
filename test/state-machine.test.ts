import assert from "node:assert/strict";
import test from "node:test";
import { allowedEvents, transition } from "../src/state-machine.ts";

test("happy-path transitions are deterministic", () => {
  let state = transition("CREATED", "START");
  state = transition(state, "BRAINSTORM_COMPLETED");
  state = transition(state, "APPROVE_BRAINSTORM");
  state = transition(state, "DESIGN_COMPLETED");
  state = transition(state, "APPROVE_DESIGN");
  state = transition(state, "BUILD_COMPLETED");
  state = transition(state, "CI_PASSED");
  state = transition(state, "VERIFY_PASSED");
  assert.equal(state, "PR_READY");
});

test("invalid transitions fail closed", () => {
  assert.throws(() => transition("CREATED", "VERIFY_PASSED"), /not allowed/);
});

test("cancel and fail are available from non-terminal states", () => {
  assert.equal(transition("BUILDING", "CANCEL"), "CANCELLED");
  assert.equal(transition("VERIFYING", "FAIL"), "FAILED");
  assert.deepEqual(allowedEvents("COMPLETED"), []);
});

test("post-review verification returns to the existing PR review state", () => {
  assert.equal(transition("VERIFYING", "VERIFY_PASSED_AFTER_REVIEW"), "PR_REVIEW");
});

test("retry-from-failed resumes into the provided resumeState", () => {
  assert.equal(transition("FAILED", "RETRY_FROM_FAILED", "BUILDING"), "BUILDING");
  assert.throws(() => transition("PR_READY", "RETRY_FROM_FAILED", "BUILDING"), /not allowed/);
  assert.throws(() => transition("FAILED", "RETRY_FROM_FAILED"), /resumeState/);
  assert.deepEqual(allowedEvents("FAILED"), ["RETRY_FROM_FAILED"]);
});
