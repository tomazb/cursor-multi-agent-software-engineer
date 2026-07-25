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
      code?:
        | "missing-marker"
        | "quoted-marker"
        | "embedded-marker"
        | "duplicate-markers"
        | "conflicting-markers"
        | "marker-not-final"
        | "content-after-marker";
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

type NumberedLine = { lineNumber: number; text: string };

function numberedNonEmptyLines(output: string): NumberedLine[] {
  const lines = output.split(/\r?\n/);
  const numbered: NumberedLine[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i]!.trimEnd();
    if (text.trim().length === 0) continue;
    numbered.push({ lineNumber: i + 1, text });
  }
  return numbered;
}

function valueFromMarker(marker: string): "PASS" | "FAIL" | "IN_SCOPE" | "OUT_OF_SCOPE" | undefined {
  if (/^VERDICT:\s*PASS$/i.test(marker)) return "PASS";
  if (/^VERDICT:\s*FAIL$/i.test(marker)) return "FAIL";
  if (/^SCOPE:\s*IN_SCOPE$/i.test(marker)) return "IN_SCOPE";
  if (/^SCOPE:\s*OUT_OF_SCOPE$/i.test(marker)) return "OUT_OF_SCOPE";
  return undefined;
}

function looksQuotedMarker(line: string, token: RegExp): boolean {
  const match = token.exec(line);
  if (!match || match.index === undefined) return false;
  const start = match.index;
  const end = start + match[0].length;
  const before = start > 0 ? line[start - 1]! : "";
  const after = end < line.length ? line[end]! : "";
  return /[`'"]/.test(before) || /[`'"]/.test(after);
}

function nonExactTokenDiagnostic(
  role: RoleId,
  line: NumberedLine,
  token: RegExp,
): Extract<ParsedMarker, { ok: false }> {
  const trimmed = line.text.trim();
  if (looksQuotedMarker(trimmed, token)) {
    return {
      ok: false,
      code: "quoted-marker",
      message: `${role} output contains a quoted marker example (line ${line.lineNumber}); put exactly one bare terminal marker on the final line`,
    };
  }
  // Bare token plus trailing/leading content on the same line.
  if (token.test(trimmed) && trimmed.replace(token, "").trim().length > 0) {
    const match = token.exec(trimmed);
    const atStart = match?.index === 0;
    if (atStart) {
      return {
        ok: false,
        code: "content-after-marker",
        message: `${role} output has content after the marker on line ${line.lineNumber}; put exactly one bare terminal marker on the final logical line`,
      };
    }
  }
  return {
    ok: false,
    code: "embedded-marker",
    message: `${role} output contains an embedded marker token (line ${line.lineNumber}); put exactly one bare terminal marker on the final logical line`,
  };
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
  const lines = numberedNonEmptyLines(output);
  if (lines.length === 0) {
    return {
      ok: false,
      code: "missing-marker",
      message: `${role} output is missing required marker ${required}`,
    };
  }

  const exactMarkers: string[] = [];
  let nonExact: Extract<ParsedMarker, { ok: false }> | undefined;
  for (const line of lines) {
    const trimmed = line.text.trim();
    const normalized = spec.normalize(trimmed);
    if (normalized) {
      exactMarkers.push(normalized);
      continue;
    }
    if (spec.token.test(trimmed) && !nonExact) {
      nonExact = nonExactTokenDiagnostic(role, line, spec.token);
    }
  }

  if (nonExact) {
    return nonExact;
  }

  if (exactMarkers.length === 0) {
    return {
      ok: false,
      code: "missing-marker",
      message: `${role} output is missing required marker ${required}`,
    };
  }

  if (exactMarkers.length > 1) {
    const unique = new Set(exactMarkers);
    return unique.size > 1
      ? {
          ok: false,
          code: "conflicting-markers",
          message: `${role} output has conflicting terminal markers: ${[...unique].join(" vs ")}`,
        }
      : {
          ok: false,
          code: "duplicate-markers",
          message: `${role} output has duplicate terminal markers`,
        };
  }

  const finalLine = lines[lines.length - 1]!;
  const finalMarker = spec.normalize(finalLine.text.trim());
  if (!finalMarker || finalMarker !== exactMarkers[0]) {
    return {
      ok: false,
      code: "marker-not-final",
      message: `${role} output must end with exactly one bare terminal marker ${required} on the final logical line`,
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
