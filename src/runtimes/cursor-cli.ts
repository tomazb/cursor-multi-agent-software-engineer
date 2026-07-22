import type { AgentRuntime, MasweConfig, RuntimeDoctorResult, RuntimeRequest, RuntimeResult } from "../domain.ts";
import { gitWorkspaceFingerprint, isGitRepository } from "../git-snapshot.ts";
import { spawnCaptured, type SpawnResult } from "../process.ts";
import { ensureRunWorkspace, cleanupDoctorProbeResources } from "../git-workspace.ts";
import { resolveLogicalModelId } from "../model-resolution.ts";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Extract assistant text from Cursor CLI `-p` stdout (text, json, or NDJSON stream-json). */
export function extractCursorCliOutput(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";

  const tryObject = (raw: string): string | undefined => {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const candidate = parsed.result ?? parsed.text ?? parsed.message;
      if (typeof candidate === "string") return candidate;
      // Prefer terminal stream-json result events.
      if (parsed.type === "result" && typeof parsed.result === "string") {
        return parsed.result;
      }
    } catch {
      return undefined;
    }
    return undefined;
  };

  const whole = tryObject(trimmed);
  if (whole !== undefined) return whole;

  // NDJSON / stream-json: take the last parseable result-bearing object.
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.type === "result" && typeof parsed.result === "string") {
        return parsed.result;
      }
      const candidate = parsed.result ?? parsed.text ?? parsed.message;
      if (typeof candidate === "string") return candidate;
    } catch {
      // keep scanning
    }
  }

  return stdout;
}

function extractOutput(stdout: string): string {
  return extractCursorCliOutput(stdout);
}

function looksLikeNode(command: string): boolean {
  const base = path.basename(command);
  return base === "node" || base === "nodejs" || command === process.execPath;
}

/** Parse exact model catalogue IDs from `agent models` text output. */
export function parseModelCatalogueIds(catalogueText: string): Set<string> {
  const ids = new Set<string>();
  const stripped = catalogueText.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const skip = new Set([
    "available",
    "models",
    "model",
    "default",
    "name",
    "id",
    "cursor",
    "claude",
    "gpt",
    "grok",
  ]);
  for (const line of stripped.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    for (const match of trimmed.matchAll(/\b([a-zA-Z][a-zA-Z0-9._+-]{2,80})\b/g)) {
      const id = match[1]!.toLowerCase();
      if (skip.has(id)) continue;
      // Model slugs are versioned or hyphenated (avoid prose words).
      if (!/[0-9]/.test(id)) continue;
      ids.add(id);
    }
  }
  return ids;
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

export class CursorCliRuntime implements AgentRuntime {
  private readonly config: MasweConfig;
  private readonly cwd: string;
  private readonly spawnFn: RuntimeSpawnFn;
  private catalogueCache: string[] | undefined;

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
    const resolvedModel = resolveLogicalModelId(request.roleConfig.model, catalogue);
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
    return {
      status: result.exitCode === 0 && !result.timedOut ? "finished" : "error",
      output: extractOutput(result.stdout) || result.stderr,
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
    if (models.exitCode !== 0) {
      throw new Error(
        `Failed to list models via '${this.config.runtime.command} models' (exit ${models.exitCode}): ${models.stderr.trim()}`,
      );
    }
    this.catalogueCache = [...parseModelCatalogueIds(`${models.stdout}\n${models.stderr}`)];
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

      probeCwd = await this.resolveDoctorProbeCwd();
      managedProbe = probeCwd !== this.cwd;

      if (this.config.policy.promptTransport === "stdin") {
        const probeArgs = looksLikeNode(this.config.runtime.command)
          ? [
              "-e",
              'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.exit(d==="maswe-stdin-probe"?0:1))',
            ]
          : ["-p", "--output-format", "text", "--model", this.config.roles.brainstormer.model, "--mode", "ask"];
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
            ? `Configured stdin prompt execution path accepted a probe payload in cwd ${probeCwd}${managedProbe ? " (managed worktree)" : ""}.`
            : `stdin prompt probe failed in cwd ${probeCwd} (exit ${probe.exitCode}${probe.timedOut ? ", timed out" : ""}).`,
        });
      }

      if (cliOk) {
        let ids: Set<string>;
        try {
          ids = new Set(await this.listModels());
        } catch (error) {
          checks.push({
            name: "model-catalogue",
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          });
          ids = new Set();
        }
        for (const [role, roleConfig] of Object.entries(this.config.roles)) {
          if (ids.size === 0) {
            checks.push({
              name: `model-${role}`,
              ok: false,
              message: `Could not resolve ${roleConfig.model}: model catalogue unavailable.`,
            });
            continue;
          }
          try {
            const resolved = resolveLogicalModelId(roleConfig.model, ids);
            checks.push({
              name: `model-${role}`,
              ok: true,
              message:
                resolved === roleConfig.model.toLowerCase()
                  ? `${roleConfig.model} is present as an exact model catalogue ID.`
                  : `${roleConfig.model} resolves to catalogue ID ${resolved}.`,
            });
          } catch (error) {
            checks.push({
              name: `model-${role}`,
              ok: false,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
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
    const workspace = await ensureRunWorkspace(this.cwd, probeRun);
    return workspace.worktreePath ?? this.cwd;
  }

  private async cleanupDoctorProbeSafe(
    probeCwd: string,
  ): Promise<{ name: string; ok: boolean; message: string }> {
    if (!this.doctorProbeRunId || probeCwd === this.cwd) {
      return {
        name: "doctor-probe-cleanup",
        ok: true,
        message: "No ephemeral doctor probe worktree was created.",
      };
    }
    try {
      await cleanupDoctorProbeResources(this.cwd, this.doctorProbeRunId, probeCwd);
      return {
        name: "doctor-probe-cleanup",
        ok: true,
        message: `Removed doctor probe worktree and branch maswe/${this.doctorProbeRunId}.`,
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
