#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig, writeStarterConfig } from "./config.ts";
import type { MasweConfig, RunRecord } from "./domain.ts";
import { Orchestrator } from "./orchestrator.ts";
import { createRuntime } from "./runtime.ts";
import { FileRunStore } from "./store.ts";
import type { AgentRuntime } from "./domain.ts";

function usage(): string {
  return `Cursor Multi-Agent Software Engineer (maswe)

Usage:
  maswe init [--force]
  maswe doctor
  maswe start --title <title> (--request <text> | --request-file <path>)
  maswe status [run-id] [--json]
  maswe approve <run-id> <brainstorm|design>
  maswe run <run-id>
  maswe pr-opened <run-id>
  maswe review-comment <run-id> (--text <text> | --file <path>)
  maswe resume-review <run-id>
  maswe merge-ready <run-id>
  maswe complete <run-id>
  maswe cancel <run-id>
  maswe retry <run-id>
  maswe supersede <run-id>
  maswe unlock <run-id> [--force]
  maswe unlock-admin <run-id> [--force]

Options:
  --config <path>  Use a specific config file.
  --cwd <path>     Run against a different repository directory.
  --json           Print machine-readable output.
  --force          init: replace config; unlock*: assert quiescence and release exactly.
`;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function has(args: string[], name: string): boolean {
  return args.includes(name);
}

function positional(args: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value) continue;
    if (value.startsWith("--")) {
      if (!["--force", "--json"].includes(value)) index += 1;
      continue;
    }
    values.push(value);
  }
  return values;
}

function renderRun(run: RunRecord): string {
  const artifacts = run.artifacts.length
    ? run.artifacts.map((artifact) => `  - ${artifact.name}: ${artifact.path}`).join("\n")
    : "  - none";
  const workspace = run.workspace
    ? `Workspace: branch=${run.workspace.branch}, head=${run.workspace.headSha.slice(0, 12)}, worktree=${run.workspace.worktreePath ?? "(repo)"}`
    : "Workspace: (unset)";
  return [
    `Run: ${run.id}`,
    `Title: ${run.title}`,
    `State: ${run.state}`,
    `Updated: ${run.updatedAt}`,
    workspace,
    `Approvals: brainstorm=${run.approvals.brainstorm}, design=${run.approvals.design}`,
    `Cycles: build/verify=${run.counters.buildVerifyCycles}, comments=${run.counters.commentResolutionCycles}`,
    "Artifacts:",
    artifacts,
    ...(run.failure ? [`Failure: ${run.failure.message}`] : []),
    ...(run.supersedes ? [`Supersedes: ${run.supersedes}`] : []),
    ...(run.supersededBy ? [`Superseded by: ${run.supersededBy}`] : []),
  ].join("\n");
}

function orchestratorForProject(cwd: string, config: MasweConfig, store: FileRunStore): Orchestrator {
  const runtime = createRuntime(config, cwd);
  return new Orchestrator(cwd, config, runtime, store);
}

async function orchestratorForRun(
  cwd: string,
  store: FileRunStore,
  runId: string,
): Promise<{ orchestrator: Orchestrator; runtime: AgentRuntime; run: RunRecord }> {
  const run = await store.load(runId);
  const runtime = createRuntime(run.config, cwd);
  const orchestrator = new Orchestrator(cwd, run.config, runtime, store);
  return { orchestrator, runtime, run };
}

const PROJECT_CONFIG_COMMANDS = new Set(["doctor", "start"]);

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const command = rawArgs[0] ?? "help";
  const args = rawArgs.slice(1);
  const cwd = path.resolve(option(rawArgs, "--cwd") ?? process.cwd());
  const configPath = option(rawArgs, "--config");

  if (["help", "--help", "-h"].includes(command)) {
    console.log(usage());
    return;
  }

  if (command === "init") {
    const target = await writeStarterConfig(cwd, has(args, "--force"));
    console.log(`Created ${target}`);
    console.log("Install Superpowers in Cursor with: /add-plugin superpowers");
    return;
  }

  const store = new FileRunStore(cwd);
  const values = positional(args);

  // Existing-run commands must not depend on current project config / env.
  let projectConfig: MasweConfig | undefined;
  if (PROJECT_CONFIG_COMMANDS.has(command)) {
    projectConfig = await loadConfig(cwd, configPath);
  }

  switch (command) {
    case "doctor": {
      const runtime = createRuntime(projectConfig!, cwd);
      const report = await runtime.doctor();
      for (const check of report.checks) {
        console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.message}`);
      }
      process.exitCode = report.ok ? 0 : 1;
      return;
    }
    case "start": {
      const title = option(args, "--title");
      const requestText = option(args, "--request");
      const requestFile = option(args, "--request-file");
      if (!title || (!requestText && !requestFile)) throw new Error("start requires --title and a request");
      const request = requestFile ? await readFile(path.resolve(cwd, requestFile), "utf8") : requestText!;
      const orchestrator = orchestratorForProject(cwd, projectConfig!, store);
      const run = await orchestrator.start(title, request);
      console.log(has(args, "--json") ? JSON.stringify(run, null, 2) : renderRun(run));
      return;
    }
    case "status": {
      const runId = values[0];
      if (runId) {
        const run = await store.load(runId);
        console.log(has(args, "--json") ? JSON.stringify(run, null, 2) : renderRun(run));
      } else {
        const runs = await store.list();
        if (has(args, "--json")) console.log(JSON.stringify(runs, null, 2));
        else console.log(runs.length ? runs.map(renderRun).join("\n\n") : "No runs found.");
      }
      return;
    }
    case "approve": {
      const [runId, gate] = values;
      if (!runId || (gate !== "brainstorm" && gate !== "design")) {
        throw new Error("approve requires <run-id> <brainstorm|design>");
      }
      const { orchestrator } = await orchestratorForRun(cwd, store, runId);
      console.log(renderRun(await orchestrator.approve(runId, gate)));
      return;
    }
    case "run": {
      const runId = values[0];
      if (!runId) throw new Error("run requires <run-id>");
      const { orchestrator } = await orchestratorForRun(cwd, store, runId);
      console.log(renderRun(await orchestrator.runUntilBlocked(runId)));
      return;
    }
    case "pr-opened": {
      const runId = values[0];
      if (!runId) throw new Error("pr-opened requires <run-id>");
      const { orchestrator } = await orchestratorForRun(cwd, store, runId);
      console.log(renderRun(await orchestrator.markPrOpened(runId)));
      return;
    }
    case "review-comment": {
      const runId = values[0];
      const text = option(args, "--text");
      const file = option(args, "--file");
      if (!runId || (!text && !file)) throw new Error("review-comment requires a run ID and comment");
      const comment = file ? await readFile(path.resolve(cwd, file), "utf8") : text!;
      const { orchestrator } = await orchestratorForRun(cwd, store, runId);
      console.log(renderRun(await orchestrator.receiveReviewComment(runId, comment)));
      return;
    }
    case "resume-review": {
      const runId = values[0];
      if (!runId) throw new Error("resume-review requires <run-id>");
      const { orchestrator } = await orchestratorForRun(cwd, store, runId);
      console.log(renderRun(await orchestrator.resumeHumanReview(runId)));
      return;
    }
    case "merge-ready": {
      const runId = values[0];
      if (!runId) throw new Error("merge-ready requires <run-id>");
      const { orchestrator } = await orchestratorForRun(cwd, store, runId);
      console.log(renderRun(await orchestrator.markMergeReady(runId)));
      return;
    }
    case "complete": {
      const runId = values[0];
      if (!runId) throw new Error("complete requires <run-id>");
      const { orchestrator } = await orchestratorForRun(cwd, store, runId);
      console.log(renderRun(await orchestrator.complete(runId)));
      return;
    }
    case "cancel": {
      const runId = values[0];
      if (!runId) throw new Error("cancel requires <run-id>");
      const { orchestrator } = await orchestratorForRun(cwd, store, runId);
      console.log(renderRun(await orchestrator.cancel(runId)));
      return;
    }
    case "retry": {
      const runId = values[0];
      if (!runId) throw new Error("retry requires <run-id>");
      const { orchestrator } = await orchestratorForRun(cwd, store, runId);
      console.log(renderRun(await orchestrator.retryFromFailed(runId)));
      return;
    }
    case "supersede": {
      const runId = values[0];
      if (!runId) throw new Error("supersede requires <run-id>");
      const { orchestrator } = await orchestratorForRun(cwd, store, runId);
      console.log(renderRun(await orchestrator.supersede(runId)));
      return;
    }
    case "unlock": {
      const runId = values[0];
      if (!runId) throw new Error("unlock requires <run-id>");
      await store.unlock(runId, { force: has(args, "--force") });
      console.log(`Published an exact data-lock release for run ${runId}`);
      return;
    }
    case "unlock-admin": {
      const runId = values[0];
      if (!runId) throw new Error("unlock-admin requires <run-id>");
      await store.unlockAdmin(runId, { force: has(args, "--force") });
      console.log(`Published an exact admin-lock release for run ${runId}`);
      return;
    }
    default:
      throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
