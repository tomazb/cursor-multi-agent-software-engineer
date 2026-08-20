import path from "node:path";
import { assertSafeRunId } from "./git-workspace.ts";

export interface ValidatedArtifactReferencePath {
  canonicalPath: string;
  fileName: string;
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
  if (!fileName) return invalidArtifactPath(persistedPath);
  return {
    canonicalPath: `.maswe/runs/${runId}/artifacts/${fileName}`,
    fileName,
  };
}
