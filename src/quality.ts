import type { QualityReport } from "./domain.ts";
import { spawnCaptured } from "./process.ts";

export async function runQualityChecks(cwd: string, commands: string[]): Promise<QualityReport> {
  const results = [];
  for (const command of commands) {
    const result = await spawnCaptured(command, [], { cwd, shell: true });
    results.push({ command, ...result });
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
