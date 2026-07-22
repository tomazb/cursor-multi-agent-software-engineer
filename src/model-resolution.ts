import type { MasweConfig, RoleId } from "./domain.ts";
import { ROLE_IDS } from "./domain.ts";

export type ModelEffortTier = "high" | "medium" | "low";

/**
 * Strip Cursor catalogue decoration to a logical model core.
 * Effort suffixes (`-high`/`-medium`/`-low`) and `-fast` are not part of the core.
 */
export function logicalModelCore(modelId: string): string {
  return modelId
    .trim()
    .toLowerCase()
    .replace(/^cursor-/, "")
    .replace(/-fast$/, "")
    .replace(/-(high|medium|low)$/, "");
}

/**
 * Extract an explicit effort tier from a logical or catalogue model id.
 * Provider prefix and `-fast` are ignored so `cursor-gpt-5.6-sol-high-fast` → `high`.
 */
export function modelEffortTier(modelId: string): ModelEffortTier | undefined {
  const id = modelId.trim().toLowerCase().replace(/^cursor-/, "").replace(/-fast$/, "");
  const match = id.match(/-(high|medium|low)$/);
  return match ? (match[1] as ModelEffortTier) : undefined;
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
 *
 * Effort rule: when the configured logical model explicitly includes an effort
 * suffix (`-high` / `-medium` / `-low`), only same-core catalogue IDs with that
 * same effort are eligible. Missing effort fails closed (no silent upgrade or
 * downgrade). When no effort is specified, existing deterministic preference
 * (non-fast, high>medium>low, cursor-prefixed) selects among same-core IDs.
 *
 * Empty catalogue pass-through is for providers without catalogue capability
 * (e.g. Cursor SDK). Cursor CLI must never call this with an empty catalogue.
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
  const needleEffort = modelEffortTier(needle);
  const sameCore = ids.filter((id) => logicalModelCore(id) === needleCore);
  const eligible = needleEffort
    ? sameCore.filter((id) => modelEffortTier(id) === needleEffort)
    : sameCore;

  if (eligible.length === 1) {
    return eligible[0]!;
  }
  if (eligible.length > 1) {
    // Deterministic preference within the eligible set (non-fast, then tier, then prefix).
    return [...eligible].sort(comparePreference)[0]!;
  }

  if (needleEffort && sameCore.length > 0) {
    const available = [
      ...new Set(sameCore.map((id) => modelEffortTier(id)).filter(Boolean)),
    ].join(", ");
    throw new Error(
      `Requested effort '${needleEffort}' for model '${requested}' is unavailable in the catalogue (same-core efforts present: ${available || "none"}). Refusing silent effort substitution.`,
    );
  }

  // No same-core family. Reject weak substring hits across different cores.
  const weak = ids.filter((id) => id.includes(needle));
  if (weak.length === 0) {
    const sample = ids.slice(0, 8).join(", ") || "(none)";
    throw new Error(
      `Unknown model '${requested}': no matching catalogue ID among ${ids.length} entries (sample: ${sample}). Run 'agent models' and update config.`,
    );
  }
  throw new Error(
    `Ambiguous model '${requested}': matches [${weak.sort().join(", ")}]. Use an exact catalogue ID.`,
  );
}

/**
 * Project / new-run resolution: map logical role models to exact catalogue IDs
 * before the run snapshot becomes authoritative.
 */
export function resolveProjectModels(config: MasweConfig, catalogue: Iterable<string>): MasweConfig {
  return resolveConfigModels(config, catalogue);
}

/** @deprecated Prefer resolveProjectModels for new-run paths. */
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

/**
 * Existing-run validation: the persisted exact ID must still exist in the live
 * catalogue. Never substitute same-core, same-family, provider, or reasoning variants.
 */
export function validatePersistedExactModel(
  persistedExactId: string,
  catalogue: Iterable<string>,
): string {
  const needle = persistedExactId.trim().toLowerCase();
  if (!needle) {
    throw new Error("Persisted model id must not be empty");
  }
  const ids = [...new Set([...catalogue].map((id) => id.trim().toLowerCase()).filter(Boolean))];
  if (ids.length === 0) {
    throw new Error(
      `Persisted exact model '${persistedExactId}' cannot be validated: model catalogue is empty or unparseable.`,
    );
  }
  if (!ids.includes(needle)) {
    throw new Error(
      `Persisted exact model '${persistedExactId}' is no longer available in the Cursor catalogue. Refusing substitution; update the run only via a new start after correcting catalogue/auth.`,
    );
  }
  return needle;
}

/** Ordered allowlist of logical families acceptable for deterministic smoke selection. */
export const SMOKE_MODEL_FAMILY_ALLOWLIST = [
  "grok-4.5",
  "gpt-5.6-sol-high",
  "claude-fable-5",
] as const;

/**
 * Pick a concrete catalogue model for smoke helpers.
 * Resolves only within the ordered allowlist of approved logical families.
 * Never falls back to an unrelated provider/family via global sort.
 */
export function pickCatalogueModel(catalogue: Iterable<string>, preferred?: string): string {
  const ids = [...new Set([...catalogue].map((id) => id.trim().toLowerCase()).filter(Boolean))];
  if (ids.length === 0) {
    throw new Error("Model catalogue is empty. Run 'agent models' and confirm Cursor CLI auth.");
  }

  const errors: string[] = [];
  if (preferred?.trim()) {
    try {
      return resolveLogicalModelId(preferred.trim().toLowerCase(), ids);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Ambiguous preferred family must fail closed (no cross-family fallback).
      if (/Ambiguous/i.test(message)) throw error;
      errors.push(message);
    }
  }

  for (const family of SMOKE_MODEL_FAMILY_ALLOWLIST) {
    if (preferred?.trim() && family === preferred.trim().toLowerCase()) continue;
    try {
      return resolveLogicalModelId(family, ids);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  throw new Error(
    `No approved smoke model family available in the catalogue (allowlist: ${SMOKE_MODEL_FAMILY_ALLOWLIST.join(", ")}). ${errors[errors.length - 1] ?? ""}`.trim(),
  );
}
