const PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  {
    pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g,
    replacement: "[REDACTED]",
  },
  {
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
    replacement: "[REDACTED]",
  },
  {
    pattern: /\b(xox[baprs]-)[A-Za-z0-9-]{10,}\b/g,
    replacement: "$1[REDACTED]",
  },
  {
    pattern: /(Authorization:\s*(?:Bearer|Basic)\s+)[^\s]+/gi,
    replacement: "$1[REDACTED]",
  },
  {
    pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/-][^\s,;]*/gi,
    replacement: "$1[REDACTED]",
  },
  {
    pattern: /(\bhttps?:\/\/[^:\s/@]+:)[^@\s/]+(@)/gi,
    replacement: "$1[REDACTED]$2",
  },
  {
    pattern:
      /([?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|signature|sig|x-amz-signature)=)[^&#\s]+/gi,
    replacement: "$1[REDACTED]",
  },
  {
    pattern:
      /\b((?:(?:[A-Za-z][A-Za-z0-9]*[_-])*(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|token))\s*[=:]\s*["']?)[^"'&,\s;]+(["']?)/gi,
    replacement: "$1[REDACTED]$2",
  },
  {
    pattern: /(aws[_-]?secret[_-]?access[_-]?key\s*[=:]\s*["']?)[^"'\\\s]+(["']?)/gi,
    replacement: "$1[REDACTED]$2",
  },
  {
    pattern: /(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g,
    replacement: "$1\n[REDACTED]\n$2",
  },
];

export const FAILURE_DIAGNOSTIC_MAX_CODE_POINTS = 2_048;
export const FAILURE_AGGREGATE_MAX_CODE_POINTS = 8_192;
export const DIAGNOSTIC_TRUNCATION_MARKER = "… [truncated]";
const DIAGNOSTIC_TRUNCATION_MARKER_CODE_POINTS = [
  ...DIAGNOSTIC_TRUNCATION_MARKER,
];

export interface SanitizedDiagnostic {
  text: string;
  truncated: boolean;
}

export function redactSecrets(input: string): string {
  let result = input;
  for (const { pattern, replacement } of PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function normalizeDiagnosticControls(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "\uFFFD");
}

/**
 * Prepare an operator diagnostic for a failure boundary.
 *
 * The fixed policy is normalize controls, redact secrets, then truncate by
 * Unicode code points. The returned text never exceeds maxCodePoints.
 */
export function sanitizeDiagnostic(
  input: string,
  maxCodePoints = FAILURE_DIAGNOSTIC_MAX_CODE_POINTS,
): SanitizedDiagnostic {
  if (!Number.isSafeInteger(maxCodePoints) || maxCodePoints < 1) {
    throw new Error("maxCodePoints must be a positive safe integer");
  }

  const redacted = redactSecrets(normalizeDiagnosticControls(input));
  const markerLength = DIAGNOSTIC_TRUNCATION_MARKER_CODE_POINTS.length;
  const prefixLimit = Math.max(0, maxCodePoints - markerLength);
  const prefix: string[] = [];
  let codePointCount = 0;

  for (const codePoint of redacted) {
    codePointCount += 1;
    if (prefix.length < prefixLimit) {
      prefix.push(codePoint);
    }
    if (codePointCount > maxCodePoints) {
      if (markerLength >= maxCodePoints) {
        return {
          text: DIAGNOSTIC_TRUNCATION_MARKER_CODE_POINTS.slice(
            0,
            maxCodePoints,
          ).join(""),
          truncated: true,
        };
      }
      return {
        text: `${prefix.join("")}${DIAGNOSTIC_TRUNCATION_MARKER}`,
        truncated: true,
      };
    }
  }

  return { text: redacted, truncated: false };
}
