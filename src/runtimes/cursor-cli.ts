import type { AgentRuntime, MasweConfig, RuntimeDoctorResult, RuntimeRequest, RuntimeResult } from "../domain.ts";
import { gitWorkspaceFingerprint } from "../git-snapshot.ts";
import { spawnCaptured } from "../process.ts";

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

export class CursorCliRuntime implements AgentRuntime {
  private readonly config: MasweConfig;

  constructor(config: MasweConfig) {
    this.config = config;
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
    args.push(request.prompt);

    const result = await spawnCaptured(this.config.runtime.command, args, { cwd: request.cwd });
    const after = await gitWorkspaceFingerprint(request.cwd);
    if (request.roleConfig.permissions === "read-only" && before !== after) {
      throw new Error(
        `${request.role} changed the workspace despite read-only policy. Review and revert the changes before continuing.`,
      );
    }
    return {
      status: result.exitCode === 0 ? "finished" : "error",
      output: extractOutput(result.stdout) || result.stderr,
      requestedModel: request.roleConfig.model,
      actualModel: request.roleConfig.model,
      metadata: {
        exitCode: result.exitCode,
        stderr: result.stderr,
        durationMs: result.durationMs,
      },
    };
  }

  async doctor(): Promise<RuntimeDoctorResult> {
    try {
      const version = await spawnCaptured(this.config.runtime.command, ["--version"], {
        cwd: process.cwd(),
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
      ];
      if (cliOk) {
        const models = await spawnCaptured(this.config.runtime.command, ["models"], {
          cwd: process.cwd(),
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
