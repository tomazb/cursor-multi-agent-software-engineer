import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { RunRecord } from "../src/domain.ts";
import { renderRun } from "../src/run-rendering.ts";

function generatedSha(): string {
  return randomBytes(20).toString("hex");
}

function generatedRun(): RunRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    version: 7,
    id: `render-${randomUUID()}`,
    title: "Generated recovery diagnostics",
    request: "Render current recovery metadata.",
    repositoryPath: "/tmp/generated-rendering",
    state: "CI_RUNNING",
    createdAt: now,
    updatedAt: now,
    approvals: { brainstorm: true, design: true },
    counters: { buildVerifyCycles: 1, commentResolutionCycles: 0 },
    config: structuredClone(DEFAULT_CONFIG),
    artifacts: [],
    events: [],
  };
}

test("human rendering shows generated bootstrap and revalidation values while JSON keeps exact SHAs", () => {
  const sourceSha = generatedSha();
  const targetSha = generatedSha();
  const run = generatedRun();
  run.workspaceBootstrap = {
    mode: "isolated-worktree",
    sourceBaseSha: sourceSha,
    sourceBranch: "main",
    sourceTreeFingerprint: randomBytes(32).toString("hex"),
    plannedAt: new Date().toISOString(),
  };
  run.workspace = {
    baseSha: sourceSha,
    headSha: targetSha,
    branch: `maswe/${run.id}`,
    fingerprint: randomBytes(32).toString("hex"),
    worktreePath: `/tmp/${run.id}`,
  };
  run.revalidation = {
    returnState: "PR_REVIEW",
    source: "github",
    originHeadSha: sourceSha,
    requestedHeadSha: targetSha,
    generation: 2,
    requestedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const output = renderRun(run);
  assert.match(
    output,
    new RegExp(
      `Bootstrap: mode=isolated-worktree, source=${sourceSha.slice(0, 12)}, workspace=checkpointed`,
    ),
  );
  assert.match(
    output,
    new RegExp(
      `Revalidation: source=github, target=${targetSha.slice(0, 12)}, generation=2, return=PR_REVIEW`,
    ),
  );
  assert.equal(output.includes(sourceSha), false);
  assert.equal(output.includes(targetSha), false);

  const json = JSON.stringify(run);
  assert.equal(json.includes(sourceSha), true);
  assert.equal(json.includes(targetSha), true);
});

test("pending bootstrap rendering identifies the planned phase with a generated source", () => {
  const sourceSha = generatedSha();
  const run = generatedRun();
  run.state = "CREATED";
  run.workspaceBootstrap = {
    mode: "operator-checkout",
    sourceBaseSha: sourceSha,
    sourceBranch: "main",
    sourceTreeFingerprint: randomBytes(32).toString("hex"),
    plannedAt: new Date().toISOString(),
  };

  const output = renderRun(run);
  assert.match(
    output,
    new RegExp(
      `Bootstrap: mode=operator-checkout, source=${sourceSha.slice(0, 12)}, workspace=pending`,
    ),
  );
});

test("recovery rendering redacts credential-like generated values without changing JSON", () => {
  const secret = randomBytes(24).toString("hex");
  const unsafeValue = `token=${secret}`;
  const run = generatedRun();
  run.workspaceBootstrap = {
    mode: "isolated-worktree",
    sourceBaseSha: unsafeValue,
    sourceBranch: "main",
    sourceTreeFingerprint: randomBytes(32).toString("hex"),
    plannedAt: new Date().toISOString(),
  };
  run.revalidation = {
    returnState: "PR_READY",
    source: "local-workspace",
    originHeadSha: generatedSha(),
    requestedHeadSha: unsafeValue,
    generation: 1,
    requestedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const output = renderRun(run);
  assert.match(output, /Bootstrap: mode=isolated-worktree, source=\[REDACTED\], workspace=pending/);
  assert.match(
    output,
    /Revalidation: source=local-workspace, target=\[REDACTED\], generation=1, return=PR_READY/,
  );
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes(unsafeValue), false);
  assert.equal(JSON.stringify(run).includes(unsafeValue), true);
});

test("human failure diagnostics keep the stable overflow code and are bounded and redacted", () => {
  const run = generatedRun();
  const secret = randomBytes(24).toString("hex");
  run.state = "FAILED";
  run.failure = {
    code: "automatic-transition-limit-exceeded",
    message: `automatic transition overflow token=${secret} ${"x".repeat(20_000)}`,
    at: new Date().toISOString(),
    resumeState: "DESIGNING",
  };

  const output = renderRun(run);
  assert.match(output, /Failure code: automatic-transition-limit-exceeded/);
  assert.match(output, /\[REDACTED\]/);
  assert.equal(output.includes(secret), false);
  assert.match(output, /… \[truncated\]/);
  assert.ok(output.length < 10_000, `rendered diagnostics were ${output.length} characters`);
});
