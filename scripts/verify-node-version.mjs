#!/usr/bin/env node
import { pathToFileURL } from "node:url";

export const CANONICAL_NODE_VERSION = "24.18.0";
export const NODE_COMPATIBILITY_FLOOR = "22.22.2";
export const SUPPORTED_NODE_RANGE = ">=22.22.2 <23 || >=24.18.0 <25";
export const UNSUPPORTED_NODE_VERSION_CODE = "MASWE_UNSUPPORTED_NODE_VERSION";

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseNodeVersion(input) {
  if (typeof input !== "string") {
    throw new TypeError(`Invalid Node.js version: ${String(input)}`);
  }
  const match = VERSION_PATTERN.exec(input);
  if (!match) throw new TypeError(`Invalid Node.js version: ${input || "<empty>"}`);
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    throw new TypeError(`Invalid Node.js version: ${input}`);
  }
  return parts;
}

function atLeast(parts, minimum) {
  for (let index = 0; index < parts.length; index += 1) {
    const value = parts[index];
    const floor = minimum[index];
    if (value > floor) return true;
    if (value < floor) return false;
  }
  return true;
}

export function isSupportedNodeVersion(input) {
  try {
    const parts = parseNodeVersion(input);
    if (parts[0] === 22) return atLeast(parts, [22, 22, 2]);
    if (parts[0] === 24) return atLeast(parts, [24, 18, 0]);
    return false;
  } catch {
    return false;
  }
}

export function unsupportedNodeVersionMessage(actualVersion) {
  const actual = typeof actualVersion === "string" && actualVersion.length > 0
    ? actualVersion
    : "<unavailable>";
  return `${UNSUPPORTED_NODE_VERSION_CODE}: Node.js ${actual} is unsupported. `
    + `Supported range: ${SUPPORTED_NODE_RANGE}. `
    + `Canonical baseline: ${CANONICAL_NODE_VERSION} from .nvmrc. `
    + `Select a supported runtime before retrying (optional NVM example: nvm install ${CANONICAL_NODE_VERSION} && nvm use ${CANONICAL_NODE_VERSION}).`;
}

export class UnsupportedNodeVersionError extends Error {
  constructor(actualVersion) {
    super(unsupportedNodeVersionMessage(actualVersion));
    this.name = "UnsupportedNodeVersionError";
    this.code = UNSUPPORTED_NODE_VERSION_CODE;
    this.actualVersion = actualVersion;
  }
}

export function assertSupportedNodeVersion(actualVersion = process.versions.node) {
  if (!isSupportedNodeVersion(actualVersion)) {
    throw new UnsupportedNodeVersionError(actualVersion);
  }
}

const invokedAsProgram = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedAsProgram) {
  try {
    assertSupportedNodeVersion();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
