import type { RoleId } from "./domain.ts";

export type MarkerMode = "role" | "classify";

export type ParsedMarker =
  | {
      ok: true;
      role: RoleId;
      mode: MarkerMode;
      marker: string;
      value?: "PASS" | "FAIL" | "IN_SCOPE" | "OUT_OF_SCOPE";
    }
  | {
      ok: false;
      message: string;
    };

export interface MarkerValidation {
  ok: boolean;
  message?: string;
  parsed?: ParsedMarker;
}

type MarkerSpec = {
  exact: RegExp;
  token: RegExp;
  normalize: (line: string) => string | undefined;
};

const ROLE_SPECS: Record<RoleId, MarkerSpec> = {
  brainstormer: {
    exact: /^READY_FOR_BRAINSTORM_APPROVAL$/,
    token: /READY_FOR_BRAINSTORM_APPROVAL/,
    normalize: (line) => (line.trim() === "READY_FOR_BRAINSTORM_APPROVAL" ? line.trim() : undefined),
  },
  designer: {
    exact: /^READY_FOR_DESIGN_APPROVAL$/,
    token: /READY_FOR_DESIGN_APPROVAL/,
    normalize: (line) => (line.trim() === "READY_FOR_DESIGN_APPROVAL" ? line.trim() : undefined),
  },
  builder: {
    exact: /^BUILD_COMPLETE$/,
    token: /BUILD_COMPLETE/,
    normalize: (line) => (line.trim() === "BUILD_COMPLETE" ? line.trim() : undefined),
  },
  verifier: {
    exact: /^VERDICT\s*:\s*(PASS|FAIL)$/i,
    token: /VERDICT\s*:\s*(PASS|FAIL)/i,
    normalize: (line) => {
      const match = line.trim().match(/^VERDICT\s*:\s*(PASS|FAIL)$/i);
      return match ? `VERDICT: ${match[1]!.toUpperCase()}` : undefined;
    },
  },
  prResolver: {
    exact: /^RESOLUTION_COMPLETE$/,
    token: /RESOLUTION_COMPLETE/,
    normalize: (line) => (line.trim() === "RESOLUTION_COMPLETE" ? line.trim() : undefined),
  },
};

const CLASSIFY_SPEC: MarkerSpec = {
  exact: /^SCOPE\s*:\s*(IN_SCOPE|OUT_OF_SCOPE)$/i,
  token: /SCOPE\s*:\s*(IN_SCOPE|OUT_OF_SCOPE)/i,
  normalize: (line) => {
    const match = line.trim().match(/^SCOPE\s*:\s*(IN_SCOPE|OUT_OF_SCOPE)$/i);
    return match ? `SCOPE: ${match[1]!.toUpperCase()}` : undefined;
  },
};

export function requiredMarkerForRole(role: RoleId): string {
  switch (role) {
    case "brainstormer":
      return "READY_FOR_BRAINSTORM_APPROVAL";
    case "designer":
      return "READY_FOR_DESIGN_APPROVAL";
    case "builder":
      return "BUILD_COMPLETE";
    case "verifier":
      return "VERDICT: PASS|FAIL";
    case "prResolver":
      return "RESOLUTION_COMPLETE";
  }
}

function nonEmptyLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

function valueFromMarker(marker: string): "PASS" | "FAIL" | "IN_SCOPE" | "OUT_OF_SCOPE" | undefined {
  if (/^VERDICT:\s*PASS$/i.test(marker)) return "PASS";
  if (/^VERDICT:\s*FAIL$/i.test(marker)) return "FAIL";
  if (/^SCOPE:\s*IN_SCOPE$/i.test(marker)) return "IN_SCOPE";
  if (/^SCOPE:\s*OUT_OF_SCOPE$/i.test(marker)) return "OUT_OF_SCOPE";
  return undefined;
}

export function parseRoleMarker(
  role: RoleId,
  output: string,
  options: { mode?: MarkerMode } = {},
): ParsedMarker {
  const mode: MarkerMode = options.mode ?? "role";
  const spec = mode === "classify" ? CLASSIFY_SPEC : ROLE_SPECS[role];
  const required =
    mode === "classify" ? "SCOPE: IN_SCOPE|OUT_OF_SCOPE" : requiredMarkerForRole(role);
  const lines = nonEmptyLines(output);
  if (lines.length === 0) {
    return { ok: false, message: `${role} output is missing required marker ${required}` };
  }

  const exactMarkers: string[] = [];
  let embedded = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const normalized = spec.normalize(trimmed);
    if (normalized) {
      exactMarkers.push(normalized);
      continue;
    }
    if (spec.token.test(trimmed)) {
      embedded = true;
    }
  }

  if (embedded) {
    return {
      ok: false,
      message: `${role} output contains an embedded or quoted marker; put exactly one bare terminal marker on the final line`,
    };
  }

  if (exactMarkers.length === 0) {
    return { ok: false, message: `${role} output is missing required marker ${required}` };
  }

  if (exactMarkers.length > 1) {
    const unique = new Set(exactMarkers);
    return {
      ok: false,
      message: unique.size > 1
        ? `${role} output has conflicting terminal markers: ${[...unique].join(" vs ")}`
        : `${role} output has duplicate terminal markers`,
    };
  }

  const finalLine = lines[lines.length - 1]!.trim();
  const finalMarker = spec.normalize(finalLine);
  if (!finalMarker || finalMarker !== exactMarkers[0]) {
    return {
      ok: false,
      message: `${role} output must end with exactly one bare terminal marker ${required}`,
    };
  }

  const value = valueFromMarker(finalMarker);
  if (value) {
    return { ok: true, role, mode, marker: finalMarker, value };
  }
  return { ok: true, role, mode, marker: finalMarker };
}

export function validateRoleMarkers(
  role: RoleId,
  output: string,
  options: { mode?: MarkerMode } = {},
): MarkerValidation {
  const parsed = parseRoleMarker(role, output, options);
  if (!parsed.ok) return { ok: false, message: parsed.message, parsed };
  return { ok: true, parsed };
}
