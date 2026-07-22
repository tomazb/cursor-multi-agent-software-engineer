import type { AgentRuntime, MasweConfig, RuntimeDoctorResult, RuntimeRequest, RuntimeResult } from "../domain.ts";
import { gitWorkspaceFingerprint } from "../git-snapshot.ts";
import { spawnCaptured } from "../process.ts";
import path from "node:path";

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

export class CursorCliRuntime implements AgentRuntime {
  private readonly config: MasweConfig;
  private readonly cwd: string;

  constructor(config: MasweConfig, options: { cwd?: string } = {}) {
    this.config = config;
    this.cwd = options.cwd ?? process.cwd();
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

    const result = await spawnCaptured(this.config.runtime.command, args, spawnOptions);
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
      },
    };
  }

  async doctor(): Promise<RuntimeDoctorResult> {
    try {
      const version = await spawnCaptured(this.config.runtime.command, ["--version"], {
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

      if (this.config.policy.promptTransport === "stdin") {
        const probe = looksLikeNode(this.config.runtime.command)
          ? await spawnCaptured(
              this.config.runtime.command,
              [
                "-e",
                'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.exit(d==="maswe-stdin-probe"?0:1))',
              ],
              {
                cwd: this.cwd,
                input: "maswe-stdin-probe",
                timeoutMs: Math.min(5_000, this.config.policy.commandTimeoutMs),
              },
            )
          : await spawnCaptured(
              this.config.runtime.command,
              ["-p", "--output-format", "text", "--model", this.config.roles.brainstormer.model],
              {
                cwd: this.cwd,
                input: "maswe-stdin-probe",
                timeoutMs: Math.min(5_000, this.config.policy.commandTimeoutMs),
              },
            );
        const probeOk = probe.exitCode === 0 && !probe.timedOut;
        checks.push({
          name: "prompt-transport-probe",
          ok: probeOk,
          message: probeOk
            ? `Configured stdin prompt execution path accepted a probe payload in cwd ${this.cwd}.`
            : `stdin prompt probe failed in cwd ${this.cwd} (exit ${probe.exitCode}${probe.timedOut ? ", timed out" : ""}).`,
        });
      }

      if (cliOk) {
        const models = await spawnCaptured(this.config.runtime.command, ["models"], {
          cwd: this.cwd,
          timeoutMs: this.config.policy.commandTimeoutMs,
        });
        const catalogue = `${models.stdout}
${models.stderr}`.toLowerCase();
        for (const [role, roleConfig] of Object.entries(this.config.roles)) {
          const normalized = roleConfig.model.toLowerCase();
          const available = models.exitCode === 0 && catalogue.includes(normalized);
          checks.push({
            name: `model-${role}`,
            ok: available,
            message: available
              ? `${roleConfig.model} appears in the Cursor model catalogue.`
              : `Could not confirm ${roleConfig.model}. Run '${this.config.runtime.command} models' and update the exact model slug in config.`,
          });
        }
      }
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
}
