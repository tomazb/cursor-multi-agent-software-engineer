import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MasweConfig, RoleConfig, RoleId, RuntimeKind } from "./domain.ts";

export const DEFAULT_CONFIG: MasweConfig = {
  version: 1,
  runtime: {
    kind: "cursor-cli",
    command: "agent",
    outputFormat: "json",
  },
  roles: {
    brainstormer: {
      model: "grok-4.5",
      reasoning: "high",
      permissions: "read-only",
    },
    designer: {
      model: "claude-fable-5",
      fallbackModels: ["claude-opus-4.8"],
      reasoning: "high",
      permissions: "read-only",
    },
    builder: {
      model: "grok-4.5",
      reasoning: "high",
      permissions: "workspace-write",
    },
    verifier: {
      model: "gpt-5.6-sol-high",
      reasoning: "high",
      permissions: "read-only",
    },
    prResolver: {
      model: "gpt-5.6-sol-high",
      reasoning: "high",
      permissions: "workspace-write",
    },
  },
  gates: {
    requireBrainstormApproval: true,
    requireDesignApproval: true,
    requireCiPass: true,
    requireVerifierPass: true,
  },
  quality: {
    commands: ["npm test", "npm run typecheck", "npm run build"],
  },
  policy: {
    rejectModelFallback: true,
    maxBuildVerifyCycles: 3,
    maxCommentResolutionCycles: 2,
    allowDirtyWorkspace: false,
  },
};

const ROLE_ENV: Record<RoleId, string> = {
  brainstormer: "MASWE_MODEL_BRAINSTORMER",
  designer: "MASWE_MODEL_DESIGNER",
  builder: "MASWE_MODEL_BUILDER",
  verifier: "MASWE_MODEL_VERIFIER",
  prResolver: "MASWE_MODEL_PR_RESOLVER",
};

function cloneDefaults(): MasweConfig {
  return structuredClone(DEFAULT_CONFIG);
}

function mergeRole(base: RoleConfig, incoming: unknown): RoleConfig {
  if (!incoming || typeof incoming !== "object") return base;
  const value = incoming as Partial<RoleConfig>;
  const fallbackModels = value.fallbackModels ?? base.fallbackModels;
  return {
    ...base,
    ...value,
    ...(fallbackModels ? { fallbackModels } : {}),
  };
}

function mergeConfig(raw: unknown): MasweConfig {
  const base = cloneDefaults();
  if (!raw || typeof raw !== "object") return applyEnvironment(base);
  const value = raw as Partial<MasweConfig>;

  const merged: MasweConfig = {
    ...base,
    ...value,
    version: 1,
    runtime: { ...base.runtime, ...(value.runtime ?? {}) },
    roles: {
      brainstormer: mergeRole(base.roles.brainstormer, value.roles?.brainstormer),
      designer: mergeRole(base.roles.designer, value.roles?.designer),
      builder: mergeRole(base.roles.builder, value.roles?.builder),
      verifier: mergeRole(base.roles.verifier, value.roles?.verifier),
      prResolver: mergeRole(base.roles.prResolver, value.roles?.prResolver),
    },
    gates: { ...base.gates, ...(value.gates ?? {}) },
    quality: { ...base.quality, ...(value.quality ?? {}) },
    policy: { ...base.policy, ...(value.policy ?? {}) },
  };

  return applyEnvironment(merged);
}

function applyEnvironment(config: MasweConfig): MasweConfig {
  const result = structuredClone(config);
  const runtime = process.env.MASWE_RUNTIME;
  if (runtime) result.runtime.kind = runtime as RuntimeKind;

  for (const [role, variable] of Object.entries(ROLE_ENV) as Array<[RoleId, string]>) {
    const model = process.env[variable];
    if (model) result.roles[role].model = model;
  }
  return result;
}

function assertConfig(config: MasweConfig): void {
  const runtimes: RuntimeKind[] = ["mock", "cursor-cli", "cursor-sdk"];
  if (!runtimes.includes(config.runtime.kind)) {
    throw new Error(`Unsupported runtime.kind: ${config.runtime.kind}`);
  }
  if (!config.runtime.command.trim()) throw new Error("runtime.command must not be empty");
  for (const [role, roleConfig] of Object.entries(config.roles)) {
    if (!roleConfig.model.trim()) throw new Error(`roles.${role}.model must not be empty`);
  }
  if (!Array.isArray(config.quality.commands)) {
    throw new Error("quality.commands must be an array");
  }
  if (config.policy.maxBuildVerifyCycles < 1) {
    throw new Error("policy.maxBuildVerifyCycles must be at least 1");
  }
  if (config.policy.maxCommentResolutionCycles < 1) {
    throw new Error("policy.maxCommentResolutionCycles must be at least 1");
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function findConfigPath(cwd: string, explicitPath?: string): Promise<string | undefined> {
  if (explicitPath) return path.resolve(cwd, explicitPath);
  const candidates = [
    path.join(cwd, ".maswe", "config.json"),
    path.join(cwd, "devflow.config.json"),
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

export async function loadConfig(cwd: string, explicitPath?: string): Promise<MasweConfig> {
  const configPath = await findConfigPath(cwd, explicitPath);
  const raw = configPath ? JSON.parse(await readFile(configPath, "utf8")) : undefined;
  const config = mergeConfig(raw);
  assertConfig(config);
  return config;
}

export async function writeStarterConfig(cwd: string, force = false): Promise<string> {
  const directory = path.join(cwd, ".maswe");
  const target = path.join(directory, "config.json");
  await mkdir(directory, { recursive: true });
  if (!force && (await exists(target))) {
    throw new Error(`${target} already exists. Pass --force to replace it.`);
  }
  await writeFile(target, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
  return target;
}
