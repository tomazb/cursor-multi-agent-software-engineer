import type { QualityReport } from "./domain.ts";
import { spawnCaptured } from "./process.ts";
import { redactSecrets } from "./redaction.ts";

export async function runQualityChecks(
  cwd: string,
  commands: string[],
  options: { timeoutMs?: number } = {},
): Promise<QualityReport> {
  const results = [];
  for (const command of commands) {
    const spawnOptions: {
      cwd: string;
      shell: boolean;
      timeoutMs?: number;
    } = {
      cwd,
      shell: true,
    };
    if (options.timeoutMs !== undefined) spawnOptions.timeoutMs = options.timeoutMs;
    const result = await spawnCaptured(command, [], spawnOptions);
    results.push({
      command,
      exitCode: result.exitCode,
      stdout: redactSecrets(result.stdout),
      stderr: redactSecrets(result.stderr),
      durationMs: result.durationMs,
    });
    if (result.exitCode !== 0) break;
  }
  return {
    passed: results.length === commands.length && results.every((result) => result.exitCode === 0),
    commands: results,
  };
}

export function renderQualityReport(report: QualityReport): string {
  const lines = [
    "# Deterministic quality report",
    "",
    `Overall result: **${report.passed ? "PASS" : "FAIL"}**`,
    "",
  ];
  for (const result of report.commands) {
    lines.push(`## \`${result.command}\``);
    lines.push("");
    lines.push(`- Exit code: ${result.exitCode}`);
    lines.push(`- Duration: ${result.durationMs} ms`);
    lines.push("");
    if (result.stdout.trim()) {
      lines.push("### stdout", "", "```text", result.stdout.trim(), "```", "");
    }
    if (result.stderr.trim()) {
      lines.push("### stderr", "", "```text", result.stderr.trim(), "```", "");
    }
  }
  return `${lines.join("\n")}\n`;
}
