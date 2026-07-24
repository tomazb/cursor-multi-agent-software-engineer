import type { AgentRuntime, MasweConfig, RuntimeDoctorResult, RuntimeRequest, RuntimeResult } from "../domain.ts";
import { gitWorkspaceFingerprint, isGitRepository } from "../git-snapshot.ts";
import { spawnCaptured, type SpawnResult } from "../process.ts";
import {
  cleanupDoctorProbeResources,
  ensureRunWorkspace,
  externalWorktreePath,
} from "../git-workspace.ts";
import {
  resolveLogicalModelId,
  resolveProjectModels,
  validatePersistedExactModel,
} from "../model-resolution.ts";
import { parseModelCatalogue, parseModelCatalogueIds } from "./cursor-model-catalogue.ts";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RunRecord } from "../domain.ts";

export { parseModelCatalogueIds };

/**
 * Extract assistant text from Cursor CLI `-p` stdout.
 *
 * - `outputFormat=json` / single JSON object: require a result-bearing object
 *   (`type: "result"` with string `result`, or top-level string `result`).
 * - `outputFormat=stream-json` / NDJSON: accept only terminal events with
 *   `type: "result"` and a string `result`. When multiple exist, the last one wins.
 * - Text mode (no JSON object / no NDJSON events): return raw stdout.
 * - Never accept arbitrary `text`/`message` fields from unrelated event types.
 */
export function extractCursorCliOutput(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";

  const resultFromObject = (parsed: Record<string, unknown>): string | undefined => {
    if (parsed.type === "result" && typeof parsed.result === "string") {
      return parsed.result;
    }
    // Single-JSON success payloads sometimes omit type but still carry result.
    if (parsed.type === undefined && typeof parsed.result === "string") {
      return parsed.result;
    }
    return undefined;
  };

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return resultFromObject(parsed as Record<string, unknown>) ?? "";
    }
  } catch {
    // NDJSON or text path below.
  }

  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let sawJson = false;
  let terminal: string | undefined;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      sawJson = true;
      if (parsed.type === "result" && typeof parsed.result === "string") {
        terminal = parsed.result;
      }
    } catch {
      // ignore non-JSON lines
    }
  }
  if (sawJson) return terminal ?? "";
  // Text-mode success: raw assistant stdout.
  return stdout;
}

function extractOutput(
  stdout: string,
  outputFormat: MasweConfig["runtime"]["outputFormat"],
): string {
  // Text is an explicit raw-output contract. JSON snippets in Markdown must not
  // trigger the NDJSON detector used for json/stream-json modes.
  if (outputFormat === "text") return stdout;
  return extractCursorCliOutput(stdout);
}

function looksLikeNode(command: string): boolean {
  const base = path.basename(command);
  return base === "node" || base === "nodejs" || command === process.execPath;
}

export function shouldPassTrustFlag(
  config: MasweConfig,
  request: { managedWorktree?: boolean },
): boolean {
  return Boolean(config.policy.trustManagedWorktrees && request.managedWorktree);
}

export type RuntimeSpawnFn = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    input?: string;
    timeoutMs: number;
  },
) => Promise<SpawnResult>;

type EnsureProbeWorkspaceFn = (
  repositoryPath: string,
  run: RunRecord,
) => Promise<{ worktreePath?: string }>;

export class CursorCliRuntime implements AgentRuntime {
  private readonly config: MasweConfig;
  private readonly cwd: string;
  private readonly spawnFn: RuntimeSpawnFn;
  private catalogueCache: string[] | undefined;
  /** Test seam for partial worktree-creation failure injection. */
  ensureProbeWorkspace: EnsureProbeWorkspaceFn = ensureRunWorkspace;

  constructor(
    config: MasweConfig,
    options: { cwd?: string; spawnFn?: RuntimeSpawnFn } = {},
  ) {
    this.config = config;
    this.cwd = options.cwd ?? process.cwd();
    this.spawnFn = options.spawnFn ?? ((command, args, spawnOptions) => spawnCaptured(command, args, spawnOptions));
  }

  async execute(request: RuntimeRequest): Promise<RuntimeResult> {
    const before = await gitWorkspaceFingerprint(request.cwd);
    const catalogue = await this.listModels();
    // Existing-run / stage execution: validate the persisted exact ID as-is.
    // Never re-resolve logical names or substitute family/core variants.
    const resolvedModel = validatePersistedExactModel(request.roleConfig.model, catalogue);
    const args = [
      "-p",
      "--output-format",
      this.config.runtime.outputFormat,
      "--model",
      resolvedModel,
    ];
    if (shouldPassTrustFlag(this.config, request)) {
      args.push("--trust");
    }
    // Ask mode keeps read-only roles from mutating the managed worktree (fingerprint gate).
    if (request.roleConfig.permissions === "read-only") {
      args.push("--mode", "ask");
    }
    if (request.roleConfig.permissions === "workspace-write") args.push("--force");

    const transport = this.config.policy.promptTransport;
    const useStdin = transport === "stdin" || request.prompt.length > 100_000;
    const spawnOptions: {
      cwd: string;
      input?: string;
      timeoutMs: number;
    } = {
      cwd: request.cwd,
      timeoutMs: request.timeoutMs ?? this.config.policy.roleTimeoutMs,
    };
    if (useStdin) {
      spawnOptions.input = request.prompt;
    } else {
      args.push(request.prompt);
    }

    const result = await this.spawnFn(this.config.runtime.command, args, spawnOptions);
    const after = await gitWorkspaceFingerprint(request.cwd);
    if (request.roleConfig.permissions === "read-only" && before !== after) {
      throw new Error(
        `${request.role} changed the workspace despite read-only policy. Review and revert the changes before continuing.`,
      );
    }

    const extracted = extractOutput(result.stdout, this.config.runtime.outputFormat);
    const success = result.exitCode === 0 && !result.timedOut;
    if (success && !extracted) {
      return {
        status: "error",
        output: "",
        requestedModel: resolvedModel,
        actualModel: resolvedModel,
        metadata: {
          exitCode: result.exitCode,
          stderr: result.stderr,
          durationMs: result.durationMs,
          timedOut: result.timedOut ?? false,
          promptTransport: useStdin ? "stdin" : "argv",
          trust: shouldPassTrustFlag(this.config, request),
          configuredModel: request.roleConfig.model,
          resolvedModel,
          error: "Cursor CLI exited 0 but stdout contained no valid assistant result",
        },
      };
    }

    return {
      status: success ? "finished" : "error",
      // Never treat stderr as successful assistant content.
      output: success ? extracted : extracted || result.stderr,
      requestedModel: resolvedModel,
      actualModel: resolvedModel,
      metadata: {
        exitCode: result.exitCode,
        stderr: result.stderr,
        durationMs: result.durationMs,
        timedOut: result.timedOut ?? false,
        promptTransport: useStdin ? "stdin" : "argv",
        trust: shouldPassTrustFlag(this.config, request),
        configuredModel: request.roleConfig.model,
        resolvedModel,
      },
    };
  }

  async listModels(): Promise<string[]> {
    if (this.catalogueCache) return this.catalogueCache;
    const models = await this.spawnFn(this.config.runtime.command, ["models"], {
      cwd: this.cwd,
      timeoutMs: this.config.policy.commandTimeoutMs,
    });
    if (models.timedOut) {
      throw new Error(
        `Model catalogue discovery timed out via '${this.config.runtime.command} models' after ${this.config.policy.commandTimeoutMs}ms`,
      );
    }
    if (models.exitCode !== 0) {
      throw new Error(
        `Failed to list models via '${this.config.runtime.command} models' (exit ${models.exitCode}): ${models.stderr.trim()}`,
      );
    }
    // Stdout only — never treat stderr prose as a valid catalogue.
    const catalogue = parseModelCatalogue(models.stdout);
    const parsed = [...catalogue.ids];
    if (parsed.length === 0) {
      if (catalogue.malformedRows.length > 0) {
        const sample = catalogue.malformedRows
          .slice(0, 3)
          .map((row) => `line ${row.lineNumber} ('${row.candidate}')`)
          .join(", ");
        throw new Error(
          `Model catalogue discovery failed: '${this.config.runtime.command} models' returned malformed catalogue row candidates (${sample}) but no valid executable model IDs. Recognized rows require an ID alone or a known selection/decorated/column structure.`,
        );
      }
      throw new Error(
        `Model catalogue discovery failed: '${this.config.runtime.command} models' exited successfully but no executable model IDs could be parsed from stdout. Confirm Cursor CLI auth and catalogue format.`,
      );
    }
    this.catalogueCache = parsed;
    return this.catalogueCache;
  }

  async doctor(): Promise<RuntimeDoctorResult> {
    let probeCwd = this.cwd;
    let managedProbe = false;
    const checks: RuntimeDoctorResult["checks"] = [];
    try {
      const version = await this.spawnFn(this.config.runtime.command, ["--version"], {
        cwd: this.cwd,
        timeoutMs: this.config.policy.commandTimeoutMs,
      });
      const cliOk = version.exitCode === 0;
      checks.push({
        name: "cursor-cli",
        ok: cliOk,
        message: cliOk
          ? `${this.config.runtime.command} is available: ${version.stdout.trim() || version.stderr.trim()}`
          : `${this.config.runtime.command} returned exit code ${version.exitCode}: ${version.stderr.trim()}`,
      });
      checks.push({
        name: "prompt-transport",
        ok: true,
        message: `Configured prompt transport: ${this.config.policy.promptTransport}`,
      });

      // Catalogue discovery + project resolution before any model-using probe.
      let resolvedExactBrainstormer: string | undefined;
      let catalogueIds: string[] = [];
      if (cliOk) {
        try {
          catalogueIds = await this.listModels();
          const resolved = resolveProjectModels(this.config, catalogueIds);
          resolvedExactBrainstormer = resolved.roles.brainstormer.model;
          for (const [role, roleConfig] of Object.entries(this.config.roles)) {
            try {
              const exact = resolveLogicalModelId(roleConfig.model, catalogueIds);
              checks.push({
                name: `model-${role}`,
                ok: true,
                message:
                  exact === roleConfig.model.toLowerCase()
                    ? `${roleConfig.model} is present as an exact model catalogue ID.`
                    : `${roleConfig.model} resolves to catalogue ID ${exact}.`,
              });
            } catch (error) {
              checks.push({
                name: `model-${role}`,
                ok: false,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }
        } catch (error) {
          checks.push({
            name: "model-catalogue",
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          });
          for (const [role, roleConfig] of Object.entries(this.config.roles)) {
            checks.push({
              name: `model-${role}`,
              ok: false,
              message: `Could not resolve ${roleConfig.model}: model catalogue unavailable.`,
            });
          }
        }
      }

      probeCwd = await this.resolveDoctorProbeCwd();
      managedProbe = probeCwd !== this.cwd;

      if (this.config.policy.promptTransport === "stdin") {
        if (!looksLikeNode(this.config.runtime.command) && !resolvedExactBrainstormer) {
          checks.push({
            name: "prompt-transport-probe",
            ok: false,
            message:
              "stdin prompt probe skipped: model resolution failed before catalogue-backed probe execution.",
          });
        } else {
          const probeArgs = looksLikeNode(this.config.runtime.command)
            ? [
                "-e",
                'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.exit(d==="maswe-stdin-probe"?0:1))',
              ]
            : [
                "-p",
                "--output-format",
                "text",
                "--model",
                resolvedExactBrainstormer!,
                "--mode",
                "ask",
              ];
          if (
            !looksLikeNode(this.config.runtime.command) &&
            this.config.policy.trustManagedWorktrees &&
            managedProbe
          ) {
            probeArgs.push("--trust");
          }
          const probe = await this.spawnFn(this.config.runtime.command, probeArgs, {
            cwd: probeCwd,
            input: "maswe-stdin-probe",
            timeoutMs: Math.min(5_000, this.config.policy.commandTimeoutMs),
          });
          const probeOk = probe.exitCode === 0 && !probe.timedOut;
          checks.push({
            name: "prompt-transport-probe",
            ok: probeOk,
            message: probeOk
              ? `Configured stdin prompt execution path accepted a probe payload in cwd ${probeCwd}${managedProbe ? " (managed worktree)" : ""}${resolvedExactBrainstormer ? ` using exact model ${resolvedExactBrainstormer}` : ""}.`
              : `stdin prompt probe failed in cwd ${probeCwd} (exit ${probe.exitCode}${probe.timedOut ? ", timed out" : ""}).`,
          });
        }
      }
      void catalogueIds;
    } catch (error) {
      checks.push({
        name: "cursor-cli",
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      const cleanup = await this.cleanupDoctorProbeSafe(probeCwd);
      checks.push(cleanup);
    }

    return { ok: checks.every((check) => check.ok), checks };
  }

  private doctorProbeRunId: string | undefined;

  private async resolveDoctorProbeCwd(): Promise<string> {
    if (
      !this.config.policy.trustManagedWorktrees ||
      !this.config.policy.useIsolatedWorktree ||
      !(await isGitRepository(this.cwd))
    ) {
      return this.cwd;
    }
    const probeId = `doctor-${randomUUID().slice(0, 8)}`;
    this.doctorProbeRunId = probeId;
    const probeRun = {
      schemaVersion: 1 as const,
      version: 1,
      id: probeId,
      title: "doctor-probe",
      request: "doctor",
      repositoryPath: this.cwd,
      state: "CREATED" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      approvals: { brainstorm: false, design: false },
      counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
      config: this.config,
      artifacts: [],
      events: [],
    };
    const workspace = await this.ensureProbeWorkspace(this.cwd, probeRun);
    return workspace.worktreePath ?? this.cwd;
  }

  private async cleanupDoctorProbeSafe(
    probeCwd: string,
  ): Promise<{ name: string; ok: boolean; message: string }> {
    if (!this.doctorProbeRunId) {
      return {
        name: "doctor-probe-cleanup",
        ok: true,
        message: "No ephemeral doctor probe worktree was created.",
      };
    }
    const probeId = this.doctorProbeRunId;
    const worktreePath =
      probeCwd !== this.cwd ? probeCwd : externalWorktreePath(this.cwd, probeId);
    try {
      await cleanupDoctorProbeResources(this.cwd, probeId, worktreePath);
      return {
        name: "doctor-probe-cleanup",
        ok: true,
        message: `Removed doctor probe worktree and branch maswe/${probeId}.`,
      };
    } catch (error) {
      return {
        name: "doctor-probe-cleanup",
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.doctorProbeRunId = undefined;
    }
  }
}
