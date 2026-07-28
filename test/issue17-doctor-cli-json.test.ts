import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DEFAULT_CONFIG } from "../src/config.ts";

const execFileAsync = promisify(execFile);

async function runDoctor(cwd: string, args: string[] = [], env: Record<string, string> = {}) {
  try {
    const result = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", "src/cli.ts", "doctor", "--cwd", cwd, ...args],
      {
        cwd: process.cwd(),
        env: { ...process.env, ...env },
      },
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error) {
      const failed = error as { code: number; stdout?: string; stderr?: string };
      return { code: failed.code, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
    }
    throw error;
  }
}

async function writeConfig(cwd: string, config: unknown): Promise<void> {
  await mkdir(path.join(cwd, ".maswe"), { recursive: true });
  await writeFile(
    path.join(cwd, ".maswe", "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
}

test("doctor --json emits structured result while human output keeps PASS|FAIL format", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue17-cli-json-pass-"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.kind = "mock";
  await writeConfig(cwd, config);

  const human = await runDoctor(cwd);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /^PASS [^:]+: .+/m);

  const json = await runDoctor(cwd, ["--json"]);
  assert.equal(json.code, 0, json.stderr);
  const report = JSON.parse(json.stdout) as {
    ok: boolean;
    checks: Array<{ name: string; ok: boolean; message: string; code: string }>;
  };
  assert.equal(report.ok, true);
  assert.ok(report.checks.length > 0);
  for (const check of report.checks) {
    assert.equal(typeof check.code, "string");
  }
});

test("doctor --json reports cursor-cli version failure and skipped probe prerequisite", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue17-cli-json-fail-"));
  const binDir = path.join(cwd, "bin");
  const logFile = path.join(cwd, "wrapper.log");
  await mkdir(binDir, { recursive: true });
  const wrapper = path.join(binDir, "fake-agent");
  await writeFile(
    wrapper,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logFile)}, args.join(" ") + "\\n");
if (args[0] === "--version") process.exit(2);
process.exit(0);
`,
    "utf8",
  );
  await chmod(wrapper, 0o755);

  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.kind = "cursor-cli";
  config.runtime.command = wrapper;
  config.policy.promptTransport = "stdin";
  config.policy.useIsolatedWorktree = false;
  config.policy.trustManagedWorktrees = false;
  await writeConfig(cwd, config);

  const human = await runDoctor(cwd);
  assert.notEqual(human.code, 0);
  assert.match(human.stdout, /^FAIL [^:]+: .+/m);

  const json = await runDoctor(cwd, ["--json"]);
  assert.notEqual(json.code, 0);
  const report = JSON.parse(json.stdout) as {
    ok: boolean;
    checks: Array<{
      name: string;
      ok: boolean;
      message: string;
      code: string;
      prerequisite?: string;
    }>;
  };
  assert.equal(report.ok, false);
  const version = report.checks.find((check) => check.name === "cursor-cli");
  const probe = report.checks.find((check) => check.name === "prompt-transport-probe");
  assert.equal(version?.code, "cursor-version-check-failure");
  assert.equal(probe?.code, "skipped-prerequisite-failure");
  assert.equal(probe?.prerequisite, "cursor-cli");

  const log = await readFile(logFile, "utf8");
  assert.match(log, /--version/);
  assert.doesNotMatch(log, /--model/);
});
