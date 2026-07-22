import type { AgentRuntime, MasweConfig, RuntimeDoctorResult, RuntimeRequest, RuntimeResult } from "../domain.ts";
import { gitWorkspaceFingerprint, isGitRepository } from "../git-snapshot.ts";
import { spawnCaptured, type SpawnResult } from "../process.ts";
import { ensureRunWorkspace, cleanupRunWorkspace } from "../git-workspace.ts";
import path from "node:path";
import { randomUUID } from "node:crypto";

function extractOutput(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const candidate = parsed.result ?? parsed.text ?? parsed.message;
    return typeof candidate === "string" ? candidate : JSON.stringify(parsed, null, 2);
  } catch {
    return stdout;
  }
}

function looksLikeNode(command: string): boolean {
  const base = path.basename(command);
  return base === "node" || base === "nodejs" || command === process.execPath;
}

/** Parse exact model catalogue IDs from `agent models` text output. */
export function parseModelCatalogueIds(catalogueText: string): Set<string> {
  const ids = new Set<string>();
  for (const line of catalogueText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Prefer first token that looks like a model slug (letters/digits/._-).
    const match = trimmed.match(/(?:^|[\s*`"'([-])([a-zA-Z][a-zA-Z0-9._+-]{1,80})(?=$|[\s)`"'\],])/);
    if (!match?.[1]) continue;
    const id = match[1];
    // Skip obvious non-model words.
    if (["available", "models", "model", "default", "name", "id"].includes(id.toLowerCase())) {
      continue;
    }
    ids.add(id.toLowerCase());
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
    const args = [
      "-p",
      "--output-format",
      this.config.runtime.outputFormat,
      "--model",
      request.roleConfig.model,
    ];
    if (shouldPassTrustFlag(this.config, request)) {
      args.push("--trust");
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
      requestedModel: request.roleConfig.model,
      actualModel: request.roleConfig.model,
      metadata: {
        exitCode: result.exitCode,
        stderr: result.stderr,
        durationMs: result.durationMs,
        timedOut: result.timedOut ?? false,
        promptTransport: useStdin ? "stdin" : "argv",
        trust: shouldPassTrustFlag(this.config, request),
      },
    };
  }

  async doctor(): Promise<RuntimeDoctorResult> {
    try {
      const version = await this.spawnFn(this.config.runtime.command, ["--version"], {
        cwd: this.cwd,
        timeoutMs: this.config.policy.commandTimeoutMs,
      });
      const cliOk = version.exitCode === 0;
      const checks: RuntimeDoctorResult["checks"] = [
        {
          name: "cursor-cli",
          ok: cliOk,
          message: cliOk
            ? `${this.config.runtime.command} is available: ${version.stdout.trim() || version.stderr.trim()}`
            : `${this.config.runtime.command} returned exit code ${version.exitCode}: ${version.stderr.trim()}`,
        },
        {
          name: "prompt-transport",
          ok: true,
          message: `Configured prompt transport: ${this.config.policy.promptTransport}`,
        },
      ];

      const probeCwd = await this.resolveDoctorProbeCwd();
      const managedProbe = probeCwd !== this.cwd;

      if (this.config.policy.promptTransport === "stdin") {
        const probeArgs = looksLikeNode(this.config.runtime.command)
          ? [
              "-e",
              'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.exit(d==="maswe-stdin-probe"?0:1))',
            ]
          : ["-p", "--output-format", "text", "--model", this.config.roles.brainstormer.model];
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
        const models = await this.spawnFn(this.config.runtime.command, ["models"], {
          cwd: probeCwd,
          timeoutMs: this.config.policy.commandTimeoutMs,
        });
        const ids = parseModelCatalogueIds(`${models.stdout}\n${models.stderr}`);
        for (const [role, roleConfig] of Object.entries(this.config.roles)) {
          const normalized = roleConfig.model.toLowerCase();
          const available = models.exitCode === 0 && ids.has(normalized);
          checks.push({
            name: `model-${role}`,
            ok: available,
            message: available
              ? `${roleConfig.model} is present as an exact model catalogue ID.`
              : `Could not confirm exact model ID ${roleConfig.model}. Run '${this.config.runtime.command} models' and update the exact model slug in config.`,
          });
        }
      }

      await this.cleanupDoctorProbe(probeCwd);
      return { ok: checks.every((check) => check.ok), checks };
    } catch (error) {
      return {
        ok: false,
        checks: [
          {
            name: "cursor-cli",
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
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

  private async cleanupDoctorProbe(probeCwd: string): Promise<void> {
    if (!this.doctorProbeRunId || probeCwd === this.cwd) return;
    try {
      await cleanupRunWorkspace({
        schemaVersion: 1,
        version: 1,
        id: this.doctorProbeRunId,
        title: "doctor-probe",
        request: "doctor",
        repositoryPath: this.cwd,
        state: "CANCELLED",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        approvals: { brainstorm: false, design: false },
        counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
        config: this.config,
        artifacts: [],
        events: [],
        workspace: {
          baseSha: "doctor",
          headSha: "doctor",
          branch: `maswe/${this.doctorProbeRunId}`,
          fingerprint: "doctor",
          worktreePath: probeCwd,
        },
      });
    } catch {
      // Best-effort cleanup of ephemeral doctor probe worktree.
    }
  }
}
