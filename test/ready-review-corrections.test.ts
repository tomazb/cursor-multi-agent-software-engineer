import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  gitWorkspaceFingerprint,
  isGitRepository,
  isGitWorkspaceClean,
} from "../src/git-snapshot.ts";
import { resolveProjectModels } from "../src/model-resolution.ts";
import { spawnCaptured } from "../src/process.ts";
import { CursorCliRuntime, type RuntimeSpawnFn } from "../src/runtimes/cursor-cli.ts";

const execFileAsync = promisify(execFile);

async function withFakeGit<T>(
  mode: "hang" | "status-failure",
  action: (cwd: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-fake-git-"));
  const bin = path.join(root, "bin");
  const cwd = path.join(root, "cwd");
  await mkdir(bin, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const fakeGit = path.join(bin, "git");
  await writeFile(
    fakeGit,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const mode = process.env.MASWE_FAKE_GIT_MODE;
if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
  if (mode === "hang") setTimeout(() => {}, 10_000);
  else { console.log("true"); process.exit(0); }
} else if (args[0] === "status" && mode === "status-failure") {
  console.error("synthetic git status failure");
  process.exit(7);
} else {
  process.exit(0);
}
`,
    "utf8",
  );
  await chmod(fakeGit, 0o755);

  const oldPath = process.env.PATH;
  const oldMode = process.env.MASWE_FAKE_GIT_MODE;
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ""}`;
  process.env.MASWE_FAKE_GIT_MODE = mode;
  try {
    return await action(cwd);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldMode === undefined) delete process.env.MASWE_FAKE_GIT_MODE;
    else process.env.MASWE_FAKE_GIT_MODE = oldMode;
  }
}

test("Git repository probe propagates execution timeout instead of becoming non-Git", async () => {
  await withFakeGit("hang", async (cwd) => {
    await assert.rejects(() => isGitRepository(cwd, 25), /timed out/i);
  });
});

test("Git workspace fingerprint rejects failed snapshot commands", async () => {
  await withFakeGit("status-failure", async (cwd) => {
    await assert.rejects(
      () => gitWorkspaceFingerprint(cwd, 1_000),
      /git status .*failed with exit 7.*synthetic git status failure/i,
    );
  });
});

test("MASWE local state does not make a freshly initialized Git workspace dirty", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-cleanliness-"));
  await execFileAsync("git", ["init"], { cwd });
  await execFileAsync("git", ["config", "user.name", "MASWE Test"], { cwd });
  await execFileAsync("git", ["config", "user.email", "maswe@example.invalid"], { cwd });
  await writeFile(path.join(cwd, "README.md"), "# test\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd });

  await mkdir(path.join(cwd, ".maswe"), { recursive: true });
  await writeFile(path.join(cwd, ".maswe", "config.json"), "{}\n", "utf8");
  assert.equal(await isGitWorkspaceClean(cwd), true);

  await writeFile(path.join(cwd, "ordinary-untracked.txt"), "dirty\n", "utf8");
  assert.equal(await isGitWorkspaceClean(cwd), false);
});

test("disabled fallback models do not block project resolution", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.policy.rejectModelFallback = true;
  const catalogue = [
    "cursor-grok-4.5-high",
    "cursor-claude-fable-5-high",
    "cursor-gpt-5.6-sol-high",
  ];

  const resolved = resolveProjectModels(config, catalogue);
  assert.equal(resolved.roles.designer.model, "cursor-claude-fable-5-high");
  assert.deepEqual(resolved.roles.designer.fallbackModels, ["claude-opus-4.8"]);

  const fallbackEnabled = structuredClone(config);
  fallbackEnabled.policy.rejectModelFallback = false;
  assert.throws(
    () => resolveProjectModels(fallbackEnabled, catalogue),
    /role 'designer'.*claude-opus-4\.8/i,
  );
});

test("spawnCaptured converts early stdin closure into a controlled failure", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-epipe-"));
  const result = await spawnCaptured(
    process.execPath,
    ["-e", 'require("node:fs").closeSync(0);setTimeout(()=>process.exit(0),100)'],
    {
      cwd,
      input: "x".repeat(8 * 1024 * 1024),
      timeoutMs: 2_000,
    },
  );

  assert.equal(result.timedOut, false);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /stdin write failed/i);
});

test("text output preserves Markdown containing standalone JSON", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-text-output-"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.outputFormat = "text";
  config.roles.brainstormer.model = "cursor-grok-4.5-high";
  const textOutput = [
    "# Analysis",
    "",
    "```json",
    '{"example":true}',
    "```",
    "",
    "BRAINSTORM: COMPLETE",
    "",
  ].join("\n");

  const spawnFn: RuntimeSpawnFn = async (_command, args) => {
    if (args[0] === "models") {
      return {
        exitCode: 0,
        stdout: "cursor-grok-4.5-high\n",
        stderr: "",
        durationMs: 1,
      };
    }
    return {
      exitCode: 0,
      stdout: textOutput,
      stderr: "",
      durationMs: 1,
    };
  };

  const runtime = new CursorCliRuntime(config, { cwd, spawnFn });
  const result = await runtime.execute({
    runId: "text-json-example",
    role: "brainstormer",
    prompt: "Analyze",
    cwd,
    roleConfig: config.roles.brainstormer,
    timeoutMs: 1_000,
    managedWorktree: false,
  });

  assert.equal(result.status, "finished");
  assert.equal(result.output, textOutput);
});
