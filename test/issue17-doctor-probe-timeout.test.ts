import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { CursorCliRuntime } from "../src/runtimes/cursor-cli.ts";

function issue17Config() {
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.kind = "cursor-cli";
  config.runtime.command = "agent";
  config.policy.promptTransport = "stdin";
  config.policy.useIsolatedWorktree = false;
  config.policy.trustManagedWorktrees = false;
  return config;
}

function catalogueStdout(): string {
  return [
    "cursor-grok-4.5-high",
    "cursor-claude-fable-5-high",
    "cursor-claude-opus-4.8-high",
    "gpt-5.6-sol-high",
    "",
  ].join("\n");
}

test("doctor probe uses exact doctorProbeTimeoutMs value", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue17-timeout-"));
  const config = issue17Config();
  config.policy.doctorProbeTimeoutMs = 15_000;
  config.policy.commandTimeoutMs = 2_000;

  let capturedProbeTimeout = -1;
  const runtime = new CursorCliRuntime(config, {
    cwd,
    spawnFn: async (_command, args, options) => {
      if (args[0] === "--version") return { exitCode: 0, stdout: "agent 1.0", stderr: "", durationMs: 1 };
      if (args[0] === "models") return { exitCode: 0, stdout: catalogueStdout(), stderr: "", durationMs: 1 };
      capturedProbeTimeout = options.timeoutMs;
      return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 };
    },
  });

  const report = await runtime.doctor();
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
  assert.equal(capturedProbeTimeout, 15_000);
});

test("doctor classifies version non-zero as version failure and skips probe with cursor-cli prerequisite", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue17-version-fail-"));
  const config = issue17Config();
  let probeInvoked = false;
  const runtime = new CursorCliRuntime(config, {
    cwd,
    spawnFn: async (_command, args) => {
      if (args[0] === "--version") return { exitCode: 2, stdout: "", stderr: "bad", durationMs: 1 };
      probeInvoked = true;
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
    },
  });

  const report = await runtime.doctor();
  const version = report.checks.find((check) => check.name === "cursor-cli");
  const probe = report.checks.find((check) => check.name === "prompt-transport-probe");
  assert.equal(version?.code, "cursor-version-check-failure");
  assert.equal(probe?.code, "skipped-prerequisite-failure");
  assert.equal(probe?.prerequisite, "cursor-cli");
  assert.equal(probeInvoked, false);
});

test("doctor classifies executable spawn rejection as unavailable and stops downstream checks", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue17-enoent-"));
  const config = issue17Config();
  const runtime = new CursorCliRuntime(config, {
    cwd,
    spawnFn: async () => {
      const error = new Error("missing") as Error & { code?: string };
      error.code = "ENOENT";
      throw error;
    },
  });

  const report = await runtime.doctor();
  const names = report.checks.map((check) => check.name);
  const version = report.checks.find((check) => check.name === "cursor-cli");
  assert.equal(version?.code, "cursor-executable-unavailable");
  assert.equal(names.includes("model-catalogue"), false);
  assert.equal(names.includes("prompt-transport-probe"), false);
});

test("doctor classifies unknown pre-version throw as doctor-unexpected-error", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue17-emfile-"));
  const config = issue17Config();
  const runtime = new CursorCliRuntime(config, {
    cwd,
    spawnFn: async () => {
      const error = new Error("fd") as Error & { code?: string };
      error.code = "EMFILE";
      throw error;
    },
  });

  const report = await runtime.doctor();
  const doctor = report.checks.find((check) => check.name === "doctor");
  const version = report.checks.find((check) => check.name === "cursor-cli");
  assert.equal(doctor?.code, "doctor-unexpected-error");
  assert.equal(version, undefined);
});

test("doctor isolates catalogue failures and marks all role checks as skipped prerequisites", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue17-catalogue-fail-"));
  const config = issue17Config();
  const runtime = new CursorCliRuntime(config, {
    cwd,
    spawnFn: async (_command, args) => {
      if (args[0] === "--version") return { exitCode: 0, stdout: "agent 1.0", stderr: "", durationMs: 1 };
      if (args[0] === "models") return { exitCode: 3, stdout: "", stderr: "nope", durationMs: 1 };
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
    },
  });

  const report = await runtime.doctor();
  const catalogue = report.checks.find((check) => check.name === "model-catalogue");
  assert.equal(catalogue?.code, "catalogue-discovery-failure");
  for (const roleCheck of report.checks.filter((check) => check.name.startsWith("model-") && check.name !== "model-catalogue")) {
    assert.equal(roleCheck.code, "skipped-prerequisite-failure", roleCheck.name);
    assert.equal(roleCheck.prerequisite, "model-catalogue", roleCheck.name);
  }
});

test("doctor uses model-resolution-failure only on actual role-resolution attempt", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue17-model-fail-"));
  const config = issue17Config();
  config.roles.brainstormer.model = "unknown-model-id";
  let resolveProbeCwdCalled = false;
  const runtime = new CursorCliRuntime(config, {
    cwd,
    spawnFn: async (_command, args) => {
      if (args[0] === "--version") return { exitCode: 0, stdout: "agent 1.0", stderr: "", durationMs: 1 };
      if (args[0] === "models") return { exitCode: 0, stdout: catalogueStdout(), stderr: "", durationMs: 1 };
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
    },
  });
  (runtime as unknown as { resolveDoctorProbeCwd: () => Promise<string> }).resolveDoctorProbeCwd = async () => {
    resolveProbeCwdCalled = true;
    return cwd;
  };

  const report = await runtime.doctor();
  const brainstormer = report.checks.find((check) => check.name === "model-brainstormer");
  const probe = report.checks.find((check) => check.name === "prompt-transport-probe");
  assert.equal(brainstormer?.code, "model-resolution-failure");
  assert.equal(probe?.code, "skipped-prerequisite-failure");
  assert.equal(probe?.prerequisite, "model-brainstormer");
  assert.equal(resolveProbeCwdCalled, false);
});

test("doctor maps timeout and non-timeout probe failures to distinct codes", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue17-probe-codes-"));
  const config = issue17Config();
  config.policy.doctorProbeTimeoutMs = 60_000;
  const timeoutRuntime = new CursorCliRuntime(config, {
    cwd,
    spawnFn: async (_command, args) => {
      if (args[0] === "--version") return { exitCode: 0, stdout: "agent 1.0", stderr: "", durationMs: 1 };
      if (args[0] === "models") return { exitCode: 0, stdout: catalogueStdout(), stderr: "", durationMs: 1 };
      return { exitCode: 124, stdout: "", stderr: "", durationMs: 60_000, timedOut: true };
    },
  });
  const timeoutReport = await timeoutRuntime.doctor();
  const timeoutProbe = timeoutReport.checks.find((check) => check.name === "prompt-transport-probe");
  assert.equal(timeoutProbe?.code, "probe-transport-timeout");
  assert.match(timeoutProbe?.message ?? "", /timed out after 60000ms/i);

  const nonTimeoutRuntime = new CursorCliRuntime(config, {
    cwd,
    spawnFn: async (_command, args) => {
      if (args[0] === "--version") return { exitCode: 0, stdout: "agent 1.0", stderr: "", durationMs: 1 };
      if (args[0] === "models") return { exitCode: 0, stdout: catalogueStdout(), stderr: "", durationMs: 1 };
      return { exitCode: 9, stdout: "", stderr: "", durationMs: 5, timedOut: false };
    },
  });
  const nonTimeoutReport = await nonTimeoutRuntime.doctor();
  const nonTimeoutProbe = nonTimeoutReport.checks.find((check) => check.name === "prompt-transport-probe");
  assert.equal(nonTimeoutProbe?.code, "probe-invocation-failure");
});

test("doctor keeps cleanup failure independent from primary probe failure", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue17-cleanup-"));
  const config = issue17Config();
  const runtime = new CursorCliRuntime(config, {
    cwd,
    spawnFn: async (_command, args) => {
      if (args[0] === "--version") return { exitCode: 0, stdout: "agent 1.0", stderr: "", durationMs: 1 };
      if (args[0] === "models") return { exitCode: 0, stdout: catalogueStdout(), stderr: "", durationMs: 1 };
      return { exitCode: 124, stdout: "", stderr: "", durationMs: 10, timedOut: true };
    },
  });
  (runtime as unknown as {
    cleanupDoctorProbeSafe: (probeCwd: string) => Promise<{ name: string; ok: boolean; message: string; code: string }>;
  }).cleanupDoctorProbeSafe = async () => ({
    name: "doctor-probe-cleanup",
    ok: false,
    code: "cleanup-failure",
    message: "synthetic cleanup failure",
  });

  const report = await runtime.doctor();
  const probe = report.checks.find((check) => check.name === "prompt-transport-probe");
  const cleanup = report.checks.find((check) => check.name === "doctor-probe-cleanup");
  assert.equal(probe?.code, "probe-transport-timeout");
  assert.equal(cleanup?.code, "cleanup-failure");
  assert.equal(report.ok, false);
});

test("doctor does not attempt probe resource setup when prompt transport is argv", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue17-argv-"));
  const config = issue17Config();
  config.policy.promptTransport = "argv";
  let resolveProbeCwdCalled = false;
  const runtime = new CursorCliRuntime(config, {
    cwd,
    spawnFn: async (_command, args) => {
      if (args[0] === "--version") return { exitCode: 0, stdout: "agent 1.0", stderr: "", durationMs: 1 };
      if (args[0] === "models") return { exitCode: 0, stdout: catalogueStdout(), stderr: "", durationMs: 1 };
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
    },
  });
  (runtime as unknown as { resolveDoctorProbeCwd: () => Promise<string> }).resolveDoctorProbeCwd = async () => {
    resolveProbeCwdCalled = true;
    return cwd;
  };
  const report = await runtime.doctor();
  assert.equal(resolveProbeCwdCalled, false);
  assert.equal(report.checks.some((check) => check.name === "prompt-transport-probe"), false);
});

test("reserved doctor codes are never emitted", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue17-reserved-"));
  const config = issue17Config();
  const runtime = new CursorCliRuntime(config, {
    cwd,
    spawnFn: async (_command, args) => {
      if (args[0] === "--version") return { exitCode: 0, stdout: "agent 1.0", stderr: "", durationMs: 1 };
      if (args[0] === "models") return { exitCode: 0, stdout: catalogueStdout(), stderr: "", durationMs: 1 };
      return { exitCode: 9, stdout: "", stderr: "unauthorized", durationMs: 1, timedOut: false };
    },
  });
  const report = await runtime.doctor();
  const reserved = new Set([
    "auth-failure",
    "process-termination-failure",
    "probe-malformed-output",
    "probe-invalid-terminal-marker",
  ]);
  for (const check of report.checks) {
    assert.equal(reserved.has(check.code), false, `${check.name} emitted reserved code ${check.code}`);
  }
});
