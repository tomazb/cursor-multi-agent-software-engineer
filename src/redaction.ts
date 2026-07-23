const PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  {
    pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g,
    replacement: "[REDACTED]",
  },
  {
    pattern: /\bsk-[A-Za-z0-9]{20,}\b/g,
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
    pattern: /(aws[_-]?secret[_-]?access[_-]?key\s*[=:]\s*["']?)[^"'\\\s]+(["']?)/gi,
    replacement: "$1[REDACTED]$2",
  },
  {
    pattern: /(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g,
    replacement: "$1\n[REDACTED]\n$2",
  },
];

export function redactSecrets(input: string): string {
  let result = input;
  for (const { pattern, replacement } of PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
