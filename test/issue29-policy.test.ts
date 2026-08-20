import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, mergeConfigForTest } from "../src/config.ts";
import {
  runFailureCode,
  runFailureRuntime,
} from "../src/failure-diagnostics.ts";
import { PolicyViolationError, ROLE_PERMISSION_POLICY, resolveExecutionPermission } from "../src/policy.ts";
import { migrateRunRecord } from "../src/store.ts";

const roles = Object.entries(ROLE_PERMISSION_POLICY) as Array<
  [keyof typeof ROLE_PERMISSION_POLICY, "read-only" | "workspace-write"]
>;

function historicalRun(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    version: 1,
    id: "issue29-policy-boundary",
    title: "Policy boundary",
    request: "Fail closed",
    repositoryPath: "/tmp",
    state: "CREATED",
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    approvals: { brainstorm: false, design: false },
    counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
    config: structuredClone(DEFAULT_CONFIG),
    artifacts: [],
    events: [],
  };
}

test("role permissions are an exact persisted/project policy matrix", () => {
  for (const [role, required] of roles) {
    const wrong = required === "read-only" ? "workspace-write" : "read-only";
    assert.throws(
      () => mergeConfigForTest({ roles: { [role]: { permissions: wrong } } }),
      (error: unknown) =>
        error instanceof PolicyViolationError &&
        error.code === "policy-role-permission-mismatch",
    );
  }
});

test("only prResolver may narrow one execution to read-only", () => {
  assert.equal(
    resolveExecutionPermission("prResolver", "workspace-write", "read-only"),
    "read-only",
  );
  assert.throws(
    () => resolveExecutionPermission("builder", "workspace-write", "read-only"),
    /permission/i,
  );
  assert.throws(
    () => resolveExecutionPermission("verifier", "read-only", "workspace-write"),
    /permission/i,
  );
});

test("persisted policy and quality violations fail closed without rewriting snapshots", () => {
  const invalidPermission = historicalRun();
  const invalidPermissionConfig = invalidPermission.config as typeof DEFAULT_CONFIG;
  invalidPermissionConfig.roles.builder.permissions = "read-only";
  assert.throws(
    () => migrateRunRecord(invalidPermission),
    (error: unknown) =>
      error instanceof PolicyViolationError &&
      error.code === "policy-role-permission-mismatch",
  );
  assert.equal(invalidPermissionConfig.roles.builder.permissions, "read-only");

  for (const command of ["", " \t\n "]) {
    const invalidQuality = historicalRun();
    const invalidQualityConfig = invalidQuality.config as typeof DEFAULT_CONFIG;
    invalidQualityConfig.quality.commands = [command];
    assert.throws(() => migrateRunRecord(invalidQuality), /quality\.commands/i);
    assert.deepEqual(invalidQualityConfig.quality.commands, [command]);
  }
});

test("policy errors retain their stable classification through causes and aggregates", () => {
  const policyError = new PolicyViolationError(
    "policy-runtime-identity-mismatch",
    "runtime identity changed",
  );
  const nested = new Error("outer", {
    cause: new AggregateError([new Error("other"), policyError], "combined"),
  });

  assert.equal(runFailureCode(nested), "policy-runtime-identity-mismatch");
  assert.equal(runFailureRuntime(nested), undefined);
});
