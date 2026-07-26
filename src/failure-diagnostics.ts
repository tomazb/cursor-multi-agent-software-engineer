import type {
  RoleId,
  RunFailureCode,
  RuntimeFinishedResult,
  RuntimeResult,
} from "./domain.ts";
import {
  FAILURE_AGGREGATE_MAX_CODE_POINTS,
  FAILURE_DIAGNOSTIC_MAX_CODE_POINTS,
  sanitizeDiagnostic,
} from "./redaction.ts";

class RuntimeExecutionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RuntimeExecutionError";
    this.code = code;
  }
}

export class RuntimeModelsExhaustedError extends Error {
  readonly code: RunFailureCode = "runtime-models-exhausted";

  constructor(message: string) {
    super(message);
    this.name = "RuntimeModelsExhaustedError";
  }
}

export function ensureRuntimeSuccess(
  result: RuntimeResult,
  role: RoleId,
): asserts result is RuntimeFinishedResult {
  if (result.status === "finished") return;
  const diagnostic = sanitizeDiagnostic(
    result.failure.message || result.output || "No output was produced.",
    FAILURE_DIAGNOSTIC_MAX_CODE_POINTS,
  );
  throw new RuntimeExecutionError(
    result.failure.code,
    `${role} failed: ${diagnostic.text}`,
  );
}

export function runtimeAttemptFailure(model: string, error: unknown): string {
  const code =
    error instanceof RuntimeExecutionError ? error.code : "runtime-error";
  const rawMessage = error instanceof Error ? error.message : String(error);
  const safeModel = sanitizeDiagnostic(model, 256).text;
  return sanitizeDiagnostic(
    `${safeModel} [${code}]: ${rawMessage}`,
    FAILURE_DIAGNOSTIC_MAX_CODE_POINTS,
  ).text;
}

export function appendFailureAggregate(
  aggregate: string,
  entry: string,
  hasEntries: boolean,
): { text: string; full: boolean } {
  const combined = `${aggregate}${hasEntries ? " | " : ""}${entry}`;
  const sanitized = sanitizeDiagnostic(
    combined,
    FAILURE_AGGREGATE_MAX_CODE_POINTS,
  );
  return { text: sanitized.text, full: sanitized.truncated };
}

export function runFailureCode(error: unknown): RunFailureCode {
  if (error instanceof RuntimeModelsExhaustedError) return error.code;
  return "workflow-failure";
}

export function runFailureMessage(error: unknown): string {
  return sanitizeDiagnostic(
    error instanceof Error ? error.message : String(error),
    FAILURE_AGGREGATE_MAX_CODE_POINTS,
  ).text;
}

export function runFailureDetails(
  code: RunFailureCode,
  message: string,
): { code: RunFailureCode; reason: string } {
  return {
    code,
    reason: sanitizeDiagnostic(
      message,
      FAILURE_AGGREGATE_MAX_CODE_POINTS,
    ).text,
  };
}

export function safeFailureMessage(message: string): string {
  return sanitizeDiagnostic(
    message,
    FAILURE_AGGREGATE_MAX_CODE_POINTS,
  ).text;
}

function safeRuntimeMetadataValue(value: string): string {
  return sanitizeDiagnostic(value, FAILURE_DIAGNOSTIC_MAX_CODE_POINTS).text;
}

export function assertRuntimeIdentity(
  result: RuntimeFinishedResult,
  role: RoleId,
): void {
  if (result.actualModel && result.actualModel !== result.requestedModel) {
    throw new RuntimeExecutionError(
      "runtime-error",
      `${role} requested ${safeRuntimeMetadataValue(result.requestedModel)}, but runtime reported ${safeRuntimeMetadataValue(result.actualModel)}.`,
    );
  }
}
