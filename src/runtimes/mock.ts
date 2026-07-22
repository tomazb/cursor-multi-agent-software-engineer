import type { AgentRuntime, RuntimeDoctorResult, RuntimeRequest, RuntimeResult } from "../domain.ts";

const ROLE_MARKERS: Record<string, string> = {
  brainstormer: "\n\nREADY_FOR_BRAINSTORM_APPROVAL\n",
  designer: "\n\nREADY_FOR_DESIGN_APPROVAL\n",
  builder: "\n\nBUILD_COMPLETE\n",
  verifier: "\n\nVERDICT: PASS\n",
  prResolver: "\n\nRESOLUTION_COMPLETE\n",
};

export class MockRuntime implements AgentRuntime {
  async execute(request: RuntimeRequest): Promise<RuntimeResult> {
    const classifying = request.prompt.includes("Role: PR comment scope classifier");
    const marker = classifying
      ? "\n\nSCOPE: IN_SCOPE\n"
      : (ROLE_MARKERS[request.role] ?? "");
    return {
      status: "finished",
      output: `# Mock ${request.role} output\n\nRun: ${request.runId}\nModel: ${request.roleConfig.model}${marker}`,
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
