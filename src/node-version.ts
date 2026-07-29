export const CANONICAL_NODE_VERSION = "24.18.0";
export const NODE_COMPATIBILITY_FLOOR = "22.22.2";
export const SUPPORTED_NODE_RANGE = ">=22.22.2 <23 || >=24.18.0 <25";
export const UNSUPPORTED_NODE_VERSION_CODE = "MASWE_UNSUPPORTED_NODE_VERSION";

export type NodeVersion = readonly [major: number, minor: number, patch: number];

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function displayNodeVersion(input: unknown): string {
  if (typeof input === "string") return input.length > 0 ? input : "<unavailable>";
  if (input === null || input === undefined) return "<unavailable>";
  return String(input);
}

export function parseNodeVersion(input: unknown): NodeVersion {
  if (typeof input !== "string") {
    throw new TypeError(`Invalid Node.js version: ${displayNodeVersion(input)}`);
  }
  const match = VERSION_PATTERN.exec(input);
  if (!match) throw new TypeError(`Invalid Node.js version: ${displayNodeVersion(input)}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    throw new TypeError(`Invalid Node.js version: ${input}`);
  }
  return [major, minor, patch];
}

function atLeast(parts: NodeVersion, minimum: NodeVersion): boolean {
  for (let index = 0; index < parts.length; index += 1) {
    const value = parts[index]!;
    const floor = minimum[index]!;
    if (value > floor) return true;
    if (value < floor) return false;
  }
  return true;
}

export function isSupportedNodeVersion(input: unknown): boolean {
  try {
    const parts = parseNodeVersion(input);
    if (parts[0] === 22) return atLeast(parts, [22, 22, 2]);
    if (parts[0] === 24) return atLeast(parts, [24, 18, 0]);
    return false;
  } catch {
    return false;
  }
}

export function unsupportedNodeVersionMessage(actualVersion: unknown): string {
  const actual = displayNodeVersion(actualVersion);
  return `${UNSUPPORTED_NODE_VERSION_CODE}: Node.js ${actual} is unsupported. `
    + `Supported range: ${SUPPORTED_NODE_RANGE}. `
    + `Canonical baseline: ${CANONICAL_NODE_VERSION} from .nvmrc. `
    + `Select a supported runtime before retrying (optional NVM example: nvm install ${CANONICAL_NODE_VERSION} && nvm use ${CANONICAL_NODE_VERSION}).`;
}

export class UnsupportedNodeVersionError extends Error {
  readonly code = UNSUPPORTED_NODE_VERSION_CODE;
  readonly actualVersion: unknown;

  constructor(actualVersion: unknown) {
    super(unsupportedNodeVersionMessage(actualVersion));
    this.name = "UnsupportedNodeVersionError";
    this.actualVersion = actualVersion;
  }
}

export function assertSupportedNodeVersion(actualVersion: unknown = process.versions.node): void {
  if (!isSupportedNodeVersion(actualVersion)) {
    throw new UnsupportedNodeVersionError(actualVersion);
  }
}
