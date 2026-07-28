import type {
  AgentRuntime,
  DoctorCheckCode,
  MasweConfig,
  RuntimeDoctorResult,
  RuntimeErrorResult,
  RuntimeFailureCode,
  RuntimeRequest,
  RuntimeResult,
} from "../domain.ts";
import { gitWorkspaceFingerprint, isGitRepository } from "../git-snapshot.ts";
import { spawnCaptured, type SpawnResult } from "../process.ts";
import { sanitizeDiagnostic } from "../redaction.ts";
import {
  cleanupDoctorProbeResources,
  ensureRunWorkspace,
  externalWorktreePath,
} from "../git-workspace.ts";
import {
  resolveLogicalModelId,
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

function safeDiagnosticText(input: string): string {
  return sanitizeDiagnostic(input).text;
}

function boundedTrimmedDiagnosticText(input: string): string {
  return sanitizeDiagnostic(input).text.trim();
}

function cursorFailureResult(options: {
  code: RuntimeFailureCode;
  message: string;
  requestedModel: string;
  configuredModel: string;
  promptTransport: "stdin" | "argv";
  stderrPresent: boolean;
  exitCode?: number;
  timedOut?: boolean;
  durationMs?: number;
  trust: boolean;
  metadata?: Record<string, unknown>;
}): RuntimeErrorResult {
  const sanitized = sanitizeDiagnostic(options.message);
  return {
    status: "error",
    output: sanitized.text,
    requestedModel: options.requestedModel,
    actualModel: options.requestedModel,
    failure: {
      code: options.code,
      message: sanitized.text,
      requestedModel: options.requestedModel,
      configuredModel: options.configuredModel,
      promptTransport: options.promptTransport,
      ...(options.exitCode !== undefined ? { exitCode: options.exitCode } : {}),
      ...(options.timedOut !== undefined ? { timedOut: options.timedOut } : {}),
      ...(options.durationMs !== undefined ? { durationMs: options.durationMs } : {}),
      stderrPresent: options.stderrPresent,
      truncated: sanitized.truncated,
    },
    metadata: {
      ...(options.exitCode !== undefined ? { exitCode: options.exitCode } : {}),
      ...(options.timedOut !== undefined ? { timedOut: options.timedOut } : {}),
      ...(options.durationMs !== undefined ? { durationMs: options.durationMs } : {}),
      promptTransport: options.promptTransport,
      trust: options.trust,
      configuredModel: options.configuredModel,
      resolvedModel: options.requestedModel,
      stderrPresent: options.stderrPresent,
      diagnosticTruncated: sanitized.truncated,
      ...(options.metadata ?? {}),
    },
  };
}

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

    const startedAt = Date.now();
    let result: SpawnResult;
    try {
      result = await this.spawnFn(this.config.runtime.command, args, spawnOptions);
    } catch (error) {
      const after = await gitWorkspaceFingerprint(request.cwd);
      if (request.roleConfig.permissions === "read-only" && before !== after) {
        throw new Error(
          `${request.role} changed the workspace despite read-only policy. Review and revert the changes before continuing.`,
        );
      }
      const detail = error instanceof Error ? error.message : String(error);
      return cursorFailureResult({
        code: "cursor-cli-spawn",
        message: `Cursor CLI process could not be started: ${detail}`,
        requestedModel: resolvedModel,
        configuredModel: request.roleConfig.model,
        promptTransport: useStdin ? "stdin" : "argv",
        stderrPresent: false,
        timedOut: false,
        durationMs: Date.now() - startedAt,
        trust: shouldPassTrustFlag(this.config, request),
      });
    }
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
      return cursorFailureResult({
        code: decodeCode,
        message: operatorError,
        requestedModel: resolvedModel,
        configuredModel: request.roleConfig.model,
        promptTransport: useStdin ? "stdin" : "argv",
        stderrPresent: result.stderr.length > 0,
        exitCode: result.exitCode,
        timedOut: result.timedOut ?? false,
        durationMs: result.durationMs,
        trust: shouldPassTrustFlag(this.config, request),
        metadata: {
          error: decodeError,
          decodeCode,
        },
      });
    }

    if (!success) {
      const code: RuntimeFailureCode = result.timedOut
        ? "cursor-cli-timeout"
        : "cursor-cli-non-zero";
      const summary = result.timedOut
        ? `Cursor CLI timed out after ${result.durationMs}ms (exit ${result.exitCode}).`
        : `Cursor CLI exited non-zero with code ${result.exitCode}.`;
      const diagnostic = boundedTrimmedDiagnosticText(result.stderr);
      return cursorFailureResult({
        code,
        message: diagnostic ? `${summary} Diagnostic: ${diagnostic}` : summary,
        requestedModel: resolvedModel,
        configuredModel: request.roleConfig.model,
        promptTransport: useStdin ? "stdin" : "argv",
        stderrPresent: result.stderr.length > 0,
        exitCode: result.exitCode,
        timedOut: result.timedOut ?? false,
        durationMs: result.durationMs,
        trust: shouldPassTrustFlag(this.config, request),
      });
    }

    return {
      status: "finished",
      // Never treat stderr as successful assistant content.
      output: extracted,
      requestedModel: resolvedModel,
      actualModel: resolvedModel,
      metadata: {
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        timedOut: result.timedOut ?? false,
        promptTransport: useStdin ? "stdin" : "argv",
        trust: shouldPassTrustFlag(this.config, request),
        configuredModel: request.roleConfig.model,
        resolvedModel,
        stderrPresent: result.stderr.length > 0,
      },
    };
  }

  async listModels(): Promise<string[]> {
    if (this.catalogueCache) return this.catalogueCache;
    let models: SpawnResult;
    try {
      models = await this.spawnFn(this.config.runtime.command, ["models"], {
        cwd: this.cwd,
        timeoutMs: this.config.policy.commandTimeoutMs,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        safeDiagnosticText(
          `Failed to start model catalogue discovery via '${this.config.runtime.command} models': ${detail}`,
        ),
      );
    }
    const modelsDiagnostic = boundedTrimmedDiagnosticText(models.stderr);
    if (models.timedOut) {
      throw new Error(
        safeDiagnosticText(
          `Model catalogue discovery timed out via '${this.config.runtime.command} models' after ${this.config.policy.commandTimeoutMs}ms${modelsDiagnostic ? `. Diagnostic: ${modelsDiagnostic}` : ""}`,
        ),
      );
    }
    if (models.exitCode !== 0) {
      throw new Error(
        safeDiagnosticText(
          `Failed to list models via '${this.config.runtime.command} models' (exit ${models.exitCode})${modelsDiagnostic ? `: ${modelsDiagnostic}` : "."}`,
        ),
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
    const unavailableSpawnErrorCodes = new Set(["ENOENT", "EACCES", "EPERM", "ENOTDIR"]);
    try {
      let version: SpawnResult | undefined;
      try {
        version = await this.spawnFn(this.config.runtime.command, ["--version"], {
          cwd: this.cwd,
          timeoutMs: this.config.policy.commandTimeoutMs,
        });
      } catch (error) {
        const code = error instanceof Error
          ? (error as Error & { code?: string }).code
          : undefined;
        const message = safeDiagnosticText(
          error instanceof Error ? error.message : String(error),
        );
        if (code && unavailableSpawnErrorCodes.has(code)) {
          checks.push({
            name: "cursor-cli",
            ok: false,
            message,
            code: "cursor-executable-unavailable",
          });
        } else {
          checks.push({
            name: "doctor",
            ok: false,
            message,
            code: "doctor-unexpected-error",
          });
        }
        return { ok: checks.every((check) => check.ok), checks };
      }

      const cliOk = version.exitCode === 0 && !version.timedOut;
      const versionStdout = boundedTrimmedDiagnosticText(version.stdout);
      const versionStderr = boundedTrimmedDiagnosticText(version.stderr);
      const versionText = versionStdout || versionStderr;
      checks.push({
        name: "cursor-cli",
        ok: cliOk,
        message: cliOk
          ? safeDiagnosticText(
              `${this.config.runtime.command} is available${versionText ? `: ${versionText}` : "."}`,
            )
          : version.timedOut
            ? safeDiagnosticText(
                `${this.config.runtime.command} --version timed out after ${this.config.policy.commandTimeoutMs}ms${versionStderr ? `: ${versionStderr}` : "."}`,
              )
          : safeDiagnosticText(
              `${this.config.runtime.command} returned exit code ${version.exitCode}${versionStderr ? `: ${versionStderr}` : "."}`,
            ),
        code: cliOk ? "ok" : "cursor-version-check-failure",
      });
      checks.push({
        name: "prompt-transport",
        ok: true,
        message: `Configured prompt transport: ${this.config.policy.promptTransport}`,
        code: "ok",
      });

      let catalogueOk = false;
      let resolvedExactBrainstormer: string | undefined;
      let catalogueIds: string[] = [];
      if (cliOk) {
        try {
          catalogueIds = await this.listModels();
          catalogueOk = true;
          checks.push({
            name: "model-catalogue",
            ok: true,
            message: "Model catalogue discovery succeeded.",
            code: "ok",
          });
          for (const [role, roleConfig] of Object.entries(this.config.roles)) {
            try {
              const exact = resolveLogicalModelId(roleConfig.model, catalogueIds);
              if (role === "brainstormer") {
                resolvedExactBrainstormer = exact;
              }
              checks.push({
                name: `model-${role}`,
                ok: true,
                message:
                  exact === roleConfig.model.toLowerCase()
                    ? `${roleConfig.model} is present as an exact model catalogue ID.`
                    : `${roleConfig.model} resolves to catalogue ID ${exact}.`,
                code: "ok",
              });
            } catch (error) {
              checks.push({
                name: `model-${role}`,
                ok: false,
                message: safeDiagnosticText(
                  error instanceof Error ? error.message : String(error),
                ),
                code: "model-resolution-failure",
              });
            }
          }
        } catch (error) {
          catalogueOk = false;
          checks.push({
            name: "model-catalogue",
            ok: false,
            message: safeDiagnosticText(
              error instanceof Error ? error.message : String(error),
            ),
            code: "catalogue-discovery-failure",
          });
          for (const [role, roleConfig] of Object.entries(this.config.roles)) {
            checks.push({
              name: `model-${role}`,
              ok: false,
              message: `Could not resolve ${roleConfig.model}: prerequisite check 'model-catalogue' failed.`,
              code: "skipped-prerequisite-failure",
              prerequisite: "model-catalogue",
            });
          }
        }
      } else {
        catalogueOk = false;
      }

      if (this.config.policy.promptTransport === "stdin") {
        const nodeStandIn = looksLikeNode(this.config.runtime.command);
        let blockingPrerequisite: RuntimeDoctorResult["checks"][number]["prerequisite"];
        if (!cliOk) {
          blockingPrerequisite = "cursor-cli";
        } else if (!nodeStandIn && !catalogueOk) {
          blockingPrerequisite = "model-catalogue";
        } else if (!nodeStandIn && !resolvedExactBrainstormer) {
          blockingPrerequisite = "model-brainstormer";
        }
        if (blockingPrerequisite) {
          checks.push({
            name: "prompt-transport-probe",
            ok: false,
            message:
              `stdin prompt probe not executed: prerequisite check '${blockingPrerequisite}' failed.`,
            code: "skipped-prerequisite-failure",
            prerequisite: blockingPrerequisite,
          });
        } else {
          probeCwd = await this.resolveDoctorProbeCwd();
          managedProbe = probeCwd !== this.cwd;
          const probeArgs = nodeStandIn
            ? [
                "-e",
                'const d=require("node:fs").readFileSync(0,"utf8");process.exit(d==="maswe-stdin-probe"?0:1)',
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
            !nodeStandIn &&
            this.config.policy.trustManagedWorktrees &&
            managedProbe
          ) {
            probeArgs.push("--trust");
          }
          const probe = await this.spawnFn(this.config.runtime.command, probeArgs, {
            cwd: probeCwd,
            input: "maswe-stdin-probe",
            timeoutMs: this.config.policy.doctorProbeTimeoutMs,
          });
          const probeOk = probe.exitCode === 0 && !probe.timedOut;
          const probeCode: DoctorCheckCode = probeOk
            ? "ok"
            : probe.timedOut
              ? "probe-transport-timeout"
              : "probe-invocation-failure";
          checks.push({
            name: "prompt-transport-probe",
            ok: probeOk,
            message: probeOk
              ? `Configured stdin prompt execution path accepted a probe payload in cwd ${probeCwd}${managedProbe ? " (managed worktree)" : ""}${resolvedExactBrainstormer ? ` using exact model ${resolvedExactBrainstormer}` : ""}.`
              : probe.timedOut
                ? `stdin prompt probe timed out after ${this.config.policy.doctorProbeTimeoutMs}ms in cwd ${probeCwd} (exit ${probe.exitCode}).`
                : `stdin prompt probe failed in cwd ${probeCwd} (exit ${probe.exitCode}).`,
            code: probeCode,
          });
        }
      }
      void catalogueIds;
    } catch (error) {
      const hasDoctorUnexpected = checks.some(
        (check) => check.name === "doctor" && check.code === "doctor-unexpected-error",
      );
      if (!hasDoctorUnexpected) {
        checks.push({
          name: "doctor",
          ok: false,
          message: safeDiagnosticText(
            error instanceof Error ? error.message : String(error),
          ),
          code: "doctor-unexpected-error",
        });
      }
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
  ): Promise<{ name: string; ok: boolean; message: string; code: DoctorCheckCode }> {
    if (!this.doctorProbeRunId) {
      return {
        name: "doctor-probe-cleanup",
        ok: true,
        message: "No ephemeral doctor probe worktree was created.",
        code: "ok",
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
        code: "ok",
      };
    } catch (error) {
      return {
        name: "doctor-probe-cleanup",
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        code: "cleanup-failure",
      };
    } finally {
      this.doctorProbeRunId = undefined;
    }
  }
}
