const PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  {
    pattern:
      /\b(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
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
    pattern:
      /([?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|signature|sig|x-amz-signature)=)[^&#\s]+/gi,
    replacement: "$1[REDACTED]",
  },
];

export const FAILURE_DIAGNOSTIC_MAX_CODE_POINTS = 2_048;
export const FAILURE_AGGREGATE_MAX_CODE_POINTS = 8_192;
export const DIAGNOSTIC_REDACTION_LOOKAHEAD_CODE_POINTS = 4_096;
export const DIAGNOSTIC_MAX_INSPECTION_CODE_POINTS =
  FAILURE_AGGREGATE_MAX_CODE_POINTS +
  DIAGNOSTIC_REDACTION_LOOKAHEAD_CODE_POINTS;
export const DIAGNOSTIC_TRUNCATION_MARKER = "… [truncated]";
const DIAGNOSTIC_TRUNCATION_MARKER_CODE_POINTS = [
  ...DIAGNOSTIC_TRUNCATION_MARKER,
];
const URI_USERINFO_SCHEME =
  /\b(?:https?|ssh|git|git\+https|git\+ssh|sftp|ftp):\/\//gi;
const PRIVATE_KEY_BEGIN =
  /-----BEGIN [A-Z ]{0,64}PRIVATE KEY-----/g;
const SENSITIVE_ASSIGNMENT_KEY =
  /(?:^|[_-])(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|token|signature|sig|aws[_-]?secret[_-]?access[_-]?key)$/i;

export interface SanitizedDiagnostic {
  text: string;
  truncated: boolean;
}

function isIdentifierCharacter(value: string): boolean {
  return /[A-Za-z0-9_-]/.test(value);
}

function isWhitespace(value: string): boolean {
  return /\s/.test(value);
}

function redactUriUserinfo(input: string): string {
  let cursor = 0;
  let output = "";
  URI_USERINFO_SCHEME.lastIndex = 0;

  for (const match of input.matchAll(URI_USERINFO_SCHEME)) {
    const schemeStart = match.index;
    const authorityStart = schemeStart + match[0].length;
    let authorityEnd = authorityStart;
    while (authorityEnd < input.length) {
      const value = input[authorityEnd]!;
      if (
        isWhitespace(value) ||
        value === "/" ||
        value === "?" ||
        value === "#"
      ) {
        break;
      }
      authorityEnd += 1;
    }

    const at = input.lastIndexOf("@", authorityEnd - 1);
    if (at < authorityStart || at >= authorityEnd) continue;
    if (at === authorityStart) continue;

    output += input.slice(cursor, authorityStart);
    output += "[REDACTED]";
    cursor = at;
  }

  return cursor === 0 ? input : `${output}${input.slice(cursor)}`;
}

function redactAssignments(input: string): string {
  const output: string[] = [];
  let cursor = 0;
  let index = 0;

  while (index < input.length) {
    if (
      !isIdentifierCharacter(input[index]!) ||
      (index > 0 && isIdentifierCharacter(input[index - 1]!))
    ) {
      index += 1;
      continue;
    }

    const keyStart = index;
    while (
      index < input.length &&
      isIdentifierCharacter(input[index]!)
    ) {
      index += 1;
    }
    const keyEnd = index;
    const keyTail = input
      .slice(Math.max(keyStart, keyEnd - 160), keyEnd)
      .toLowerCase();
    if (!SENSITIVE_ASSIGNMENT_KEY.test(keyTail)) continue;

    let separator = keyEnd;
    if (input[separator] === '"' || input[separator] === "'") separator += 1;
    while (
      separator < input.length &&
      isWhitespace(input[separator]!)
    ) {
      separator += 1;
    }
    if (input[separator] !== "=" && input[separator] !== ":") continue;
    separator += 1;
    while (
      separator < input.length &&
      isWhitespace(input[separator]!)
    ) {
      separator += 1;
    }

    const quote =
      input[separator] === '"' || input[separator] === "'"
        ? input[separator]
        : undefined;
    const valueStart = quote ? separator + 1 : separator;
    let valueEnd = valueStart;
    if (quote) {
      while (valueEnd < input.length && input[valueEnd] !== quote) {
        valueEnd += 1;
      }
    } else {
      while (valueEnd < input.length) {
        const value = input[valueEnd]!;
        if (
          isWhitespace(value) ||
          value === '"' ||
          value === "'" ||
          value === "&" ||
          value === "," ||
          value === ";"
        ) {
          break;
        }
        valueEnd += 1;
      }
    }
    if (valueEnd === valueStart) continue;

    output.push(input.slice(cursor, valueStart), "[REDACTED]");
    cursor = valueEnd;
    index = valueEnd;
  }

  if (output.length === 0) return input;
  output.push(input.slice(cursor));
  return output.join("");
}

function redactPrivateKeyBlocks(input: string): string {
  let cursor = 0;
  let output = "";
  PRIVATE_KEY_BEGIN.lastIndex = 0;

  for (const match of input.matchAll(PRIVATE_KEY_BEGIN)) {
    const beginStart = match.index;
    if (beginStart < cursor) continue;
    const bodyStart = beginStart + match[0].length;
    const endMarker = match[0].replace("BEGIN", "END");
    const endStart = input.indexOf(endMarker, bodyStart);

    output += input.slice(cursor, bodyStart);
    output += "\n[REDACTED]";
    if (endStart < 0) {
      cursor = input.length;
      break;
    }
    output += "\n";
    cursor = endStart;
  }

  return cursor === 0 ? input : `${output}${input.slice(cursor)}`;
}

export function redactSecrets(input: string): string {
  let result = redactUriUserinfo(input);
  for (const { pattern, replacement } of PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return redactPrivateKeyBlocks(redactAssignments(result));
}

function boundedNormalizedDiagnosticPrefix(
  input: string,
  maxCodePoints: number,
): { text: string; omitted: boolean } {
  const output: string[] = [];
  let codePoints = 0;
  let index = 0;

  while (index < input.length && codePoints < maxCodePoints) {
    const value = input[index]!;
    if (value === "\r") {
      output.push("\n");
      index += input[index + 1] === "\n" ? 2 : 1;
    } else {
      const scalar = input.codePointAt(index)!;
      const codePoint = String.fromCodePoint(scalar);
      output.push(
        (scalar >= 0x00 && scalar <= 0x08) ||
          scalar === 0x0b ||
          scalar === 0x0c ||
          (scalar >= 0x0e && scalar <= 0x1f) ||
          (scalar >= 0x7f && scalar <= 0x9f)
          ? "\uFFFD"
          : codePoint,
      );
      index += codePoint.length;
    }
    codePoints += 1;
  }

  return { text: output.join(""), omitted: index < input.length };
}

function truncateSanitizedDiagnostic(
  input: string,
  maxCodePoints: number,
  forceTruncated: boolean,
): SanitizedDiagnostic {
  const codePoints = [...input];
  if (!forceTruncated && codePoints.length <= maxCodePoints) {
    return { text: input, truncated: false };
  }

  const markerLength = DIAGNOSTIC_TRUNCATION_MARKER_CODE_POINTS.length;
  if (markerLength >= maxCodePoints) {
    return {
      text: DIAGNOSTIC_TRUNCATION_MARKER_CODE_POINTS.slice(
        0,
        maxCodePoints,
      ).join(""),
      truncated: true,
    };
  }
  const prefixLimit = maxCodePoints - markerLength;
  return {
    text: `${codePoints.slice(0, prefixLimit).join("")}${DIAGNOSTIC_TRUNCATION_MARKER}`,
    truncated: true,
  };
}

/**
 * Prepare an operator diagnostic for a failure boundary.
 *
 * Work is bounded before pattern application: collect at most maxCodePoints
 * plus a fixed lookahead, normalize controls during that collection, redact
 * the bounded window, then truncate by Unicode code points. Credential
 * scanners treat the end of the accepted window as a delimiter so a long
 * assignment or incomplete private-key block cannot expose a retained prefix.
 */
export function sanitizeDiagnostic(
  input: string,
  maxCodePoints = FAILURE_DIAGNOSTIC_MAX_CODE_POINTS,
): SanitizedDiagnostic {
  if (!Number.isSafeInteger(maxCodePoints) || maxCodePoints < 1) {
    throw new Error("maxCodePoints must be a positive safe integer");
  }
  if (maxCodePoints > FAILURE_AGGREGATE_MAX_CODE_POINTS) {
    throw new Error(
      `maxCodePoints must not exceed ${FAILURE_AGGREGATE_MAX_CODE_POINTS}`,
    );
  }

  const inspectionLimit = Math.min(
    maxCodePoints + DIAGNOSTIC_REDACTION_LOOKAHEAD_CODE_POINTS,
    DIAGNOSTIC_MAX_INSPECTION_CODE_POINTS,
  );
  const accepted = boundedNormalizedDiagnosticPrefix(input, inspectionLimit);
  const redacted = redactSecrets(accepted.text);
  return truncateSanitizedDiagnostic(
    redacted,
    maxCodePoints,
    accepted.omitted,
  );
}
