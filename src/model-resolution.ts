import type { MasweConfig, RoleId } from "./domain.ts";
import { ROLE_IDS } from "./domain.ts";

/** Strip Cursor catalogue decoration to a logical model core. */
export function logicalModelCore(modelId: string): string {
  return modelId
    .trim()
    .toLowerCase()
    .replace(/^cursor-/, "")
    .replace(/-fast$/, "")
    .replace(/-(high|medium|low)$/, "");
}

function preferenceScore(modelId: string): [number, number, number, string] {
  const id = modelId.toLowerCase();
  const nonFast = id.endsWith("-fast") ? 0 : 1;
  const tier = id.includes("-high") ? 3 : id.includes("-medium") ? 2 : id.includes("-low") ? 1 : 0;
  const cursorPrefixed = id.startsWith("cursor-") ? 1 : 0;
  // Higher tuple wins; final element is ascending tie-break for determinism.
  return [nonFast, tier, cursorPrefixed, id];
}

function comparePreference(a: string, b: string): number {
  const sa = preferenceScore(a);
  const sb = preferenceScore(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (sb[i] as number) - (sa[i] as number);
    if (diff !== 0) return diff;
  }
  return (sa[3] as string).localeCompare(sb[3] as string);
}

/**
 * Resolve a configured logical model name to exactly one catalogue ID.
 * Fail closed when no candidate exists or unrelated candidates tie.
 */
export function resolveLogicalModelId(requested: string, catalogue: Iterable<string>): string {
  const needle = requested.trim().toLowerCase();
  if (!needle) {
    throw new Error("Model id must not be empty");
  }

  const ids = [...new Set([...catalogue].map((id) => id.trim().toLowerCase()).filter(Boolean))];
  if (ids.length === 0) {
    // Provider catalogue unavailable (e.g. SDK): keep the configured id as-is.
    return needle;
  }
  if (ids.includes(needle)) {
    return needle;
  }

  const needleCore = logicalModelCore(needle);
  const sameCore = ids.filter((id) => logicalModelCore(id) === needleCore);
  if (sameCore.length === 1) {
    return sameCore[0]!;
  }
  if (sameCore.length > 1) {
    // Deterministic preference within the same logical family (non-fast, high>medium>low).
    return [...sameCore].sort(comparePreference)[0]!;
  }

  // No same-core family. Reject weak substring hits across different cores.
  const weak = ids.filter((id) => id.includes(needle));
  if (weak.length === 0) {
    throw new Error(
      `Unknown model '${requested}': no matching catalogue ID. Run 'agent models' and update config.`,
    );
  }
  throw new Error(
    `Ambiguous model '${requested}': matches [${weak.sort().join(", ")}]. Use an exact catalogue ID.`,
  );
}

export function resolveConfigModels(config: MasweConfig, catalogue: Iterable<string>): MasweConfig {
  const resolved = structuredClone(config);
  for (const role of ROLE_IDS) {
    const roleConfig = resolved.roles[role as RoleId];
    roleConfig.model = resolveLogicalModelId(roleConfig.model, catalogue);
    if (roleConfig.fallbackModels?.length) {
      roleConfig.fallbackModels = roleConfig.fallbackModels.map((model) =>
        resolveLogicalModelId(model, catalogue),
      );
    }
  }
  return resolved;
}
