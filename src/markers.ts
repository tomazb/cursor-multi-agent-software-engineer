import type { RoleId } from "./domain.ts";

export type MarkerMode = "role" | "classify";

export interface MarkerValidation {
  ok: boolean;
  message?: string;
}

const ROLE_MARKERS: Record<RoleId, RegExp> = {
  brainstormer: /\bREADY_FOR_BRAINSTORM_APPROVAL\b/,
  designer: /\bREADY_FOR_DESIGN_APPROVAL\b/,
  builder: /\bBUILD_COMPLETE\b/,
  verifier: /\bVERDICT\s*:\s*(PASS|FAIL)\b/i,
  prResolver: /\bRESOLUTION_COMPLETE\b/,
};

const CLASSIFY_MARKER = /\bSCOPE\s*:\s*(IN_SCOPE|OUT_OF_SCOPE)\b/i;

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

export function validateRoleMarkers(
  role: RoleId,
  output: string,
  options: { mode?: MarkerMode } = {},
): MarkerValidation {
  if (options.mode === "classify") {
    if (CLASSIFY_MARKER.test(output)) return { ok: true };
    return {
      ok: false,
      message: `${role} output is missing required marker SCOPE: IN_SCOPE|OUT_OF_SCOPE`,
    };
  }
  const pattern = ROLE_MARKERS[role];
  if (pattern.test(output)) return { ok: true };
  return {
    ok: false,
    message: `${role} output is missing required marker ${requiredMarkerForRole(role)}`,
  };
}
