import type { AgentRuntime, RuntimeDoctorResult, RuntimeRequest, RuntimeResult } from "../domain.ts";
import { gitWorkspaceFingerprint } from "../git-snapshot.ts";

const importOptional = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<Record<string, any>>;

export class CursorSdkRuntime implements AgentRuntime {
  async execute(request: RuntimeRequest): Promise<RuntimeResult> {
    const apiKey = process.env.CURSOR_API_KEY;
    if (!apiKey) throw new Error("CURSOR_API_KEY is required for the cursor-sdk runtime.");
    const before = await gitWorkspaceFingerprint(request.cwd);
    const sdk = await importOptional("@cursor/sdk");
    const result = await sdk.Agent.prompt(request.prompt, {
      apiKey,
      model: { id: request.roleConfig.model },
      local: { cwd: request.cwd, settingSources: [] },
    });
    const after = await gitWorkspaceFingerprint(request.cwd);
    if (request.roleConfig.permissions === "read-only" && before !== after) {
      throw new Error(
        `${request.role} changed the workspace despite read-only policy. Review and revert the changes before continuing.`,
      );
    }
    const output = typeof result.result === "string" ? result.result : JSON.stringify(result.result, null, 2);
    return {
      status: result.status === "finished" ? "finished" : "error",
      output,
      requestedModel: request.roleConfig.model,
      actualModel: result.model?.id,
      agentId: result.agentId,
      runId: result.id,
      metadata: { status: result.status },
    };
  }

  async doctor(): Promise<RuntimeDoctorResult> {
    const checks = [];
    const hasKey = Boolean(process.env.CURSOR_API_KEY);
    checks.push({
      name: "cursor-api-key",
      ok: hasKey,
      message: hasKey ? "CURSOR_API_KEY is set." : "CURSOR_API_KEY is not set.",
    });
    try {
      await importOptional("@cursor/sdk");
      checks.push({ name: "cursor-sdk", ok: true, message: "@cursor/sdk can be imported." });
    } catch (error) {
      checks.push({
        name: "cursor-sdk",
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return { ok: checks.every((check) => check.ok), checks };
  }
}
