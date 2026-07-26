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

export type CursorCliOutputFormat = MasweConfig["runtime"]["outputFormat"];
export type CursorCliOutputDecodeCode =
  | "invalid-transport-json"
  | "unsupported-response-shape"
  | "missing-logical-output";

export type CursorCliOutputDecode =
  | {
      ok: true;
      text: string;
    }
  | {
      ok: false;
      code: CursorCliOutputDecodeCode;
      message: string;
    };

function authoritativeResultFromObject(
  parsed: Record<string, unknown>,
  outputFormat: CursorCliOutputFormat,
): string | undefined {
  if (typeof parsed.result !== "string") return undefined;
  if (parsed.type === "result") return parsed.result;
  // Single-JSON mode may return a typeless success payload. Stream-json must
  // remain event-typed so an unsupported envelope cannot authorize a marker.
  if (outputFormat === "json" && parsed.type === undefined) return parsed.result;
  return undefined;
}

/**
 * Decode assistant text from Cursor CLI `-p` stdout.
 *
 * Structured modes first try one whole JSON envelope, then scan NDJSON records
 * when the whole buffer is not one JSON value. Only the authoritative string
 * `result` field is returned as logical assistant text.
 *
 * - Never treat transport JSON quoting as model content.
 * - Never accept arbitrary `text`/`message` fields from unrelated event types.
 * - Structured modes never fall back to raw stdout.
 * - Text mode returns raw stdout unchanged.
 */
export function decodeCursorCliAssistantOutput(
  stdout: string,
  outputFormat: CursorCliOutputFormat = "text",
): CursorCliOutputDecode {
  if (outputFormat === "text") {
    return { ok: true, text: stdout };
  }

  const trimmed = stdout.trim();
  if (!trimmed) {
    return {
      ok: false,
      code: "missing-logical-output",
      message: "Cursor CLI stdout was empty; no authoritative assistant result field",
    };
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const text = authoritativeResultFromObject(
        parsed as Record<string, unknown>,
        outputFormat,
      );
      if (text !== undefined) {
        return { ok: true, text };
      }
      return {
        ok: false,
        code: "unsupported-response-shape",
        message:
          outputFormat === "stream-json"
            ? 'Cursor CLI stream-json object lacked an authoritative string "result" field with type=result'
            : 'Cursor CLI JSON object lacked an authoritative string "result" field (type=result or typeless result)',
      };
    }
    return {
      ok: false,
      code: "unsupported-response-shape",
      message: "Cursor CLI JSON stdout was not a result-bearing object",
    };
  } catch {
    // Whole-buffer parse failed. Scan individual records so stream-json and
    // json output with non-JSON banner lines can still expose a terminal result.
  }

  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let sawJson = false;
  let sawJsonLikeMalformed = false;
  let terminal: string | undefined;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      sawJson = true;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const text = authoritativeResultFromObject(
          parsed as Record<string, unknown>,
          outputFormat,
        );
        if (text !== undefined) terminal = text;
      }
    } catch {
      if (/^[{[]/.test(line)) sawJsonLikeMalformed = true;
    }
  }

  if (sawJsonLikeMalformed) {
    return {
      ok: false,
      code: "invalid-transport-json",
      message: "Cursor CLI stdout contained malformed transport JSON for the configured output format",
    };
  }

  if (terminal !== undefined) {
    return { ok: true, text: terminal };
  }

  if (sawJson) {
    return {
      ok: false,
      code: "missing-logical-output",
      message: 'Cursor CLI JSON/NDJSON contained no authoritative string "result" field',
    };
  }

  return {
    ok: false,
    code: "unsupported-response-shape",
    message: "Cursor CLI stdout did not match a supported json/stream-json assistant result shape",
  };
}

/**
 * Extract assistant text from Cursor CLI `-p` stdout.
 *
 * - Omitted `outputFormat`: legacy auto-detect (unwrap JSON/NDJSON when present,
 *   otherwise return raw stdout). Used only by older test helpers.
 * - `outputFormat: "text"`: return stdout verbatim (matches `execute()` text mode).
 * - `outputFormat: "json" | "stream-json"`: structured decode only; never fall back
 *   to raw envelope text.
 */
export function extractCursorCliOutput(
  stdout: string,
  options?: { outputFormat?: CursorCliOutputFormat },
): string {
  if (!options || options.outputFormat === undefined) {
    return extractCursorCliOutputLegacyAuto(stdout);
  }
  if (options.outputFormat === "text") {
    return stdout;
  }
  const decoded = decodeCursorCliAssistantOutput(stdout, options.outputFormat);
  return decoded.ok ? decoded.text : "";
}

/** Legacy test helper: sniff JSON/NDJSON when present, otherwise keep raw stdout. */
function extractCursorCliOutputLegacyAuto(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return authoritativeResultFromObject(parsed as Record<string, unknown>, "json") ?? "";
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
      // Ignore non-JSON lines in this legacy test-only compatibility path.
    }
  }
  if (sawJson) return terminal ?? "";
  return stdout;
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

    const outputFormat = this.config.runtime.outputFormat;
    const decoded = decodeCursorCliAssistantOutput(result.stdout, outputFormat);
    const extracted = decoded.ok ? decoded.text : "";
    const success = result.exitCode === 0 && !result.timedOut;
    if (success && (!decoded.ok || !extracted)) {
      const decodeCode: CursorCliOutputDecodeCode = decoded.ok
        ? "missing-logical-output"
        : decoded.code;
      const decodeError = decoded.ok
        ? "Cursor CLI exited 0 but stdout contained no valid assistant result"
        : decoded.message;
      const operatorError = `${decodeCode}: ${decodeError}`;
      return {
        status: "error",
        output: operatorError,
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
          error: decodeError,
          decodeCode,
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
    if (catalogue.malformedRows.length > 0) {
      const sample = catalogue.malformedRows
        .slice(0, 3)
        .map((row) => `line ${row.lineNumber} ('${row.candidate}')`)
        .join(", ");
      const validSummary =
        parsed.length === 0
          ? "no valid executable model IDs"
          : `${parsed.length} valid executable model ID${parsed.length === 1 ? "" : "s"} also parsed`;
      throw new Error(
        `Model catalogue discovery failed: '${this.config.runtime.command} models' returned malformed catalogue row candidates (${sample}); ${validSummary}. Refusing partial catalogue resolution because omitted rows could change model family or effort selection.`,
      );
    }
    if (parsed.length === 0) {
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
