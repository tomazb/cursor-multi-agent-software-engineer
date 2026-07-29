import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type {
  DoctorCheckPrerequisite,
  RuntimeDoctorResult,
} from "../src/domain.ts";
import {
  CursorCliRuntime,
  type RuntimeSpawnFn,
} from "../src/runtimes/cursor-cli.ts";

const DOCTOR_CHECK_PREREQUISITES = [
  "cursor-cli",
  "model-catalogue",
  "model-brainstormer",
] as const satisfies readonly DoctorCheckPrerequisite[];

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
    (<T>() => T extends B ? 1 : 2)
    ? true
    : false;
type Assert<T extends true> = T;
type DoctorCheckPrerequisiteIsExact = Assert<
  Equal<DoctorCheckPrerequisite, (typeof DOCTOR_CHECK_PREREQUISITES)[number]>
>;
const doctorCheckPrerequisiteIsExact: DoctorCheckPrerequisiteIsExact = true;

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

test("doctor maps non-zero and timed-out version checks to cursor-version-check-failure without probe resources", async (t) => {
  for (const fixture of [
    {
      label: "non-zero",
      result: { exitCode: 2, stdout: "", stderr: "bad", durationMs: 1 },
    },
    {
      label: "timed-out",
      result: {
        exitCode: 124,
        stdout: "",
        stderr: "",
        durationMs: 600_000,
        timedOut: true,
      },
    },
  ] as const) {
    await t.test(fixture.label, async () => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue17-version-fail-"));
      const config = issue17Config();
      let downstreamInvoked = false;
      let resolveProbeCwdCalls = 0;
      const runtime = new CursorCliRuntime(config, {
        cwd,
        spawnFn: async (_command, args) => {
          if (args[0] === "--version") return fixture.result;
          downstreamInvoked = true;
          return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
        },
      });
      (runtime as unknown as {
        resolveDoctorProbeCwd: () => Promise<string>;
      }).resolveDoctorProbeCwd = async () => {
        resolveProbeCwdCalls += 1;
        return cwd;
      };

      const report = await runtime.doctor();
      const version = report.checks.find((check) => check.name === "cursor-cli");
      const probe = report.checks.find((check) => check.name === "prompt-transport-probe");
      assert.equal(version?.code, "cursor-version-check-failure");
      assert.equal(probe?.code, "skipped-prerequisite-failure");
      assert.equal(probe?.prerequisite, "cursor-cli");
      assert.equal(downstreamInvoked, false);
      assert.equal(resolveProbeCwdCalls, 0);
      assert.equal(
        report.checks.find((check) => check.name === "doctor-probe-cleanup")?.code,
        "ok",
      );
    });
  }
});

test("doctor classifies known executable-unavailability errors and stops downstream checks", async (t) => {
  for (const errorCode of ["ENOENT", "EACCES", "EPERM", "ENOTDIR"] as const) {
    await t.test(errorCode, async () => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue17-unavailable-"));
      const config = issue17Config();
      let spawnCalls = 0;
      const runtime = new CursorCliRuntime(config, {
        cwd,
        spawnFn: async () => {
          spawnCalls += 1;
          const error = new Error("unavailable") as Error & { code?: string };
          error.code = errorCode;
          throw error;
        },
      });

      const report = await runtime.doctor();
      const names = report.checks.map((check) => check.name);
      const version = report.checks.find((check) => check.name === "cursor-cli");
      assert.equal(version?.code, "cursor-executable-unavailable");
      assert.equal(spawnCalls, 1);
      assert.equal(names.includes("model-catalogue"), false);
      assert.equal(names.some((name) => name.startsWith("model-")), false);
      assert.equal(names.includes("prompt-transport-probe"), false);
    });
  }
});

test("doctor classifies every unexpected pre-version rejection without a cursor-cli check", async (t) => {
  const fixtures: Array<{ label: string; rejection: unknown }> = [
    {
      label: "unknown-coded-error",
      rejection: Object.assign(new Error("fd"), { code: "EMFILE" }),
    },
    { label: "plain-error", rejection: new Error("plain") },
    { label: "non-error", rejection: "synthetic rejection" },
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.label, async () => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue17-unexpected-"));
      const config = issue17Config();
      let spawnCalls = 0;
      const runtime = new CursorCliRuntime(config, {
        cwd,
        spawnFn: async () => {
          spawnCalls += 1;
          throw fixture.rejection;
        },
      });

      const report = await runtime.doctor();
      const names = report.checks.map((check) => check.name);
      const doctor = report.checks.find((check) => check.name === "doctor");
      assert.equal(doctor?.code, "doctor-unexpected-error");
      assert.equal(spawnCalls, 1);
      assert.equal(names.includes("cursor-cli"), false);
      assert.equal(names.some((name) => name.startsWith("model-")), false);
      assert.equal(names.includes("prompt-transport-probe"), false);
    });
  }
});

test("doctor isolates catalogue failures and marks all role checks as skipped prerequisites", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue17-catalogue-fail-"));
  const config = issue17Config();
  let resolveProbeCwdCalls = 0;
  const runtime = new CursorCliRuntime(config, {
    cwd,
    spawnFn: async (_command, args) => {
      if (args[0] === "--version") return { exitCode: 0, stdout: "agent 1.0", stderr: "", durationMs: 1 };
      if (args[0] === "models") return { exitCode: 3, stdout: "", stderr: "nope", durationMs: 1 };
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
    },
  });
  (runtime as unknown as {
    resolveDoctorProbeCwd: () => Promise<string>;
  }).resolveDoctorProbeCwd = async () => {
    resolveProbeCwdCalls += 1;
    throw new Error("skipped probe must not create a worktree");
  };

  const report = await runtime.doctor();
  const catalogue = report.checks.find((check) => check.name === "model-catalogue");
  assert.equal(catalogue?.code, "catalogue-discovery-failure");
  for (const roleCheck of report.checks.filter((check) => check.name.startsWith("model-") && check.name !== "model-catalogue")) {
    assert.equal(roleCheck.code, "skipped-prerequisite-failure", roleCheck.name);
    assert.equal(roleCheck.prerequisite, "model-catalogue", roleCheck.name);
  }
  assert.equal(
    report.checks.find((check) => check.name === "prompt-transport-probe")?.prerequisite,
    "model-catalogue",
  );
  assert.equal(resolveProbeCwdCalls, 0);
});

test("Node stand-in catalogue failure does not weaken real-command model gating", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue17-node-stand-in-"));
  const config = issue17Config();
  config.runtime.command = process.execPath;
  config.policy.doctorProbeTimeoutMs = 19_000;
  let probeInvocations = 0;
  let probeTimeout = -1;
  let probeInput: string | undefined;
  const runtime = new CursorCliRuntime(config, {
    cwd,
    spawnFn: async (_command, args, options) => {
      if (args[0] === "--version") {
        return { exitCode: 0, stdout: "node v22", stderr: "", durationMs: 1 };
      }
      if (args[0] === "models") {
        return { exitCode: 1, stdout: "", stderr: "Node has no models command", durationMs: 1 };
      }
      assert.equal(args[0], "-e");
      probeInvocations += 1;
      probeTimeout = options.timeoutMs;
      probeInput = options.input;
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
    },
  });

  const report = await runtime.doctor();
  assert.equal(
    report.checks.find((check) => check.name === "model-catalogue")?.code,
    "catalogue-discovery-failure",
  );
  const probe = report.checks.find((check) => check.name === "prompt-transport-probe");
  assert.equal(probe?.ok, true);
  assert.equal(probe?.code, "ok");
  assert.match(
    probe?.message ?? "",
    /started with a probe payload and exited zero/,
  );
  assert.doesNotMatch(probe?.message ?? "", /\baccepted\b/i);
  assert.equal(probeInvocations, 1);
  assert.equal(probeTimeout, 19_000);
  assert.equal(probeInput, "maswe-stdin-probe");
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

test("doctor keeps a valid catalogue isolated from one invalid non-brainstormer role", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue17-role-isolation-"));
  const config = issue17Config();
  config.roles.designer.model = "unknown-designer-model";
  let probeInvocations = 0;
  let resolveProbeCwdCalls = 0;
  const runtime = new CursorCliRuntime(config, {
    cwd,
    spawnFn: async (_command, args) => {
      if (args[0] === "--version") {
        return { exitCode: 0, stdout: "agent 1.0", stderr: "", durationMs: 1 };
      }
      if (args[0] === "models") {
        return { exitCode: 0, stdout: catalogueStdout(), stderr: "", durationMs: 1 };
      }
      probeInvocations += 1;
      return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 };
    },
  });
  (runtime as unknown as {
    resolveDoctorProbeCwd: () => Promise<string>;
  }).resolveDoctorProbeCwd = async () => {
    resolveProbeCwdCalls += 1;
    return cwd;
  };

  const report = await runtime.doctor();
  assert.equal(
    report.checks.find((check) => check.name === "model-catalogue")?.code,
    "ok",
  );
  assert.equal(
    report.checks.find((check) => check.name === "model-designer")?.code,
    "model-resolution-failure",
  );
  assert.equal(
    report.checks.find((check) => check.name === "model-brainstormer")?.code,
    "ok",
  );
  assert.equal(
    report.checks.filter((check) => check.code === "model-resolution-failure").length,
    1,
  );
  assert.equal(
    report.checks.find((check) => check.name === "prompt-transport-probe")?.code,
    "ok",
  );
  assert.equal(probeInvocations, 1);
  assert.equal(resolveProbeCwdCalls, 1);
});

test("doctor preserves a successful cursor-cli check when probe resource resolution throws", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue17-post-version-error-"));
  const config = issue17Config();
  const runtime = new CursorCliRuntime(config, {
    cwd,
    spawnFn: async (_command, args) => {
      if (args[0] === "--version") {
        return { exitCode: 0, stdout: "agent 1.0", stderr: "", durationMs: 1 };
      }
      if (args[0] === "models") {
        return { exitCode: 0, stdout: catalogueStdout(), stderr: "", durationMs: 1 };
      }
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
    },
  });
  (runtime as unknown as {
    resolveDoctorProbeCwd: () => Promise<string>;
  }).resolveDoctorProbeCwd = async () => {
    throw new Error("synthetic worktree creation failure");
  };

  const report = await runtime.doctor();
  const cursorChecks = report.checks.filter((check) => check.name === "cursor-cli");
  assert.equal(cursorChecks.length, 1);
  assert.equal(cursorChecks[0]?.code, "ok");
  assert.equal(
    report.checks.find((check) => check.name === "doctor")?.code,
    "doctor-unexpected-error",
  );
  assert.equal(
    report.checks.find((check) => check.name === "doctor-probe-cleanup")?.code,
    "ok",
  );
});

test("doctor emitted prerequisites stay within the exact typed vocabulary", async () => {
  assert.equal(doctorCheckPrerequisiteIsExact, true);
  const emitted: DoctorCheckPrerequisite[] = [];
  const scenarios: Array<{
    config: ReturnType<typeof issue17Config>;
    spawnFn: RuntimeSpawnFn;
  }> = [];

  const versionFailure = issue17Config();
  scenarios.push({
    config: versionFailure,
    spawnFn: async (_command, args) => {
      if (args[0] === "--version") {
        return { exitCode: 2, stdout: "", stderr: "", durationMs: 1 };
      }
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
    },
  });
  const catalogueFailure = issue17Config();
  scenarios.push({
    config: catalogueFailure,
    spawnFn: async (_command, args) => {
      if (args[0] === "--version") {
        return { exitCode: 0, stdout: "agent 1.0", stderr: "", durationMs: 1 };
      }
      if (args[0] === "models") {
        return { exitCode: 3, stdout: "", stderr: "", durationMs: 1 };
      }
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
    },
  });
  const brainstormerFailure = issue17Config();
  brainstormerFailure.roles.brainstormer.model = "unknown-model";
  scenarios.push({
    config: brainstormerFailure,
    spawnFn: async (_command, args) => {
      if (args[0] === "--version") {
        return { exitCode: 0, stdout: "agent 1.0", stderr: "", durationMs: 1 };
      }
      if (args[0] === "models") {
        return { exitCode: 0, stdout: catalogueStdout(), stderr: "", durationMs: 1 };
      }
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
    },
  });

  for (const scenario of scenarios) {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue17-vocabulary-"));
    const report: RuntimeDoctorResult = await new CursorCliRuntime(scenario.config, {
      cwd,
      spawnFn: scenario.spawnFn,
    }).doctor();
    for (const check of report.checks) {
      if (check.prerequisite) emitted.push(check.prerequisite);
    }
  }

  assert.deepEqual(
    [...new Set(emitted)].sort(),
    [...DOCTOR_CHECK_PREREQUISITES].sort(),
  );
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
