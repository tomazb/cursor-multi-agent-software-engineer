import path from "node:path";
import { assertSafeRunId } from "./git-workspace.ts";

export interface ValidatedArtifactReferencePath {
  canonicalPath: string;
  fileName: string;
}

const PORTABLE_ARTIFACT_FILE_NAME = /^[A-Za-z0-9._-]+$/;
const WINDOWS_DEVICE_STEM = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;
const GENERATED_ARTIFACT_ESCAPE_PREFIX = "_maswe-escaped-";

export function isPortableArtifactFileName(fileName: unknown): fileName is string {
  return (
    typeof fileName === "string" &&
    PORTABLE_ARTIFACT_FILE_NAME.test(fileName) &&
    !fileName.endsWith(".") &&
    !fileName.endsWith(" ") &&
    !WINDOWS_DEVICE_STEM.test(fileName)
  );
}

/**
 * Preserve existing lowercase portable leaves while escaping every other generated leaf into an
 * injective, case-insensitive-filesystem-safe namespace. Inputs already resembling the escape
 * namespace are escaped too, so an encoded output can never collide with a passthrough input.
 */
export function generatedArtifactFileName(candidateFileName: string): string {
  if (
    isPortableArtifactFileName(candidateFileName) &&
    candidateFileName === candidateFileName.toLowerCase() &&
    !candidateFileName.startsWith(GENERATED_ARTIFACT_ESCAPE_PREFIX)
  ) {
    return candidateFileName;
  }

  const encoded = Buffer.from(candidateFileName, "utf8").toString("hex");
  return `${GENERATED_ARTIFACT_ESCAPE_PREFIX}${encoded}.md`;
}

function invalidArtifactPath(persistedPath: string): never {
  throw new Error(`Artifact reference path '${persistedPath}' is invalid`);
}

export function canonicalArtifactReferencePath(runId: string, fileName: string): string {
  assertSafeRunId(runId);
  return validateArtifactReferencePath(
    runId,
    `.maswe/runs/${runId}/artifacts/${fileName}`,
  ).canonicalPath;
}

export function validateArtifactReferencePath(
  runId: string,
  persistedPath: string,
): ValidatedArtifactReferencePath {
  assertSafeRunId(runId);
  if (
    typeof persistedPath !== "string" ||
    path.posix.isAbsolute(persistedPath) ||
    path.win32.isAbsolute(persistedPath) ||
    /^[A-Za-z]:/.test(persistedPath)
  ) {
    return invalidArtifactPath(String(persistedPath));
  }

  const normalized = persistedPath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (
    segments.length !== 5 ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
    segments[0] !== ".maswe" ||
    segments[1] !== "runs" ||
    segments[2] !== runId ||
    segments[3] !== "artifacts"
  ) {
    return invalidArtifactPath(persistedPath);
  }

  const fileName = segments[4];
  if (!isPortableArtifactFileName(fileName)) return invalidArtifactPath(persistedPath);
  return {
    canonicalPath: `.maswe/runs/${runId}/artifacts/${fileName}`,
    fileName,
  };
}
