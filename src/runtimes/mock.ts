import type { AgentRuntime, RuntimeDoctorResult, RuntimeRequest, RuntimeResult } from "../domain.ts";

export class MockRuntime implements AgentRuntime {
  async execute(request: RuntimeRequest): Promise<RuntimeResult> {
    const verdict = request.role === "verifier" ? "\n\nVERDICT: PASS\n" : "";
    const scope = request.prompt.includes("Role: PR comment scope classifier")
      ? "\n\nSCOPE: IN_SCOPE\n"
      : "";
    return {
      status: "finished",
      output: `# Mock ${request.role} output\n\nRun: ${request.runId}\nModel: ${request.roleConfig.model}${verdict}${scope}`,
      requestedModel: request.roleConfig.model,
      actualModel: request.roleConfig.model,
      agentId: `mock-agent-${request.role}`,
      runId: `mock-run-${request.runId}-${request.role}`,
    };
  }

  async doctor(): Promise<RuntimeDoctorResult> {
    return {
      ok: true,
      checks: [{ name: "mock-runtime", ok: true, message: "Mock runtime is available." }],
    };
  }
}
