import type {
  DurableRuntimeFailureAttempt,
  DurableRuntimeFailureSummary,
  RoleId,
  RunFailureCode,
  RuntimeFinishedResult,
  RuntimeFailureCode,
  RuntimeFailureDiagnostic,
  RuntimeResult,
} from "./domain.ts";
import {
  FAILURE_AGGREGATE_MAX_CODE_POINTS,
  FAILURE_DIAGNOSTIC_MAX_CODE_POINTS,
  sanitizeDiagnostic,
} from "./redaction.ts";

export const DURABLE_RUNTIME_FAILURE_ATTEMPT_LIMIT = 8;
export const DURABLE_RUNTIME_FAILURE_MESSAGE_MAX_CODE_POINTS = 512;
export const DURABLE_RUNTIME_MODEL_MAX_CODE_POINTS = 256;

const RUNTIME_FAILURE_CODES = new Set<RuntimeFailureCode>([
  "cursor-cli-non-zero",
  "cursor-cli-timeout",
  "cursor-cli-spawn",
  "cursor-sdk-error",
  "runtime-error",
  "invalid-transport-json",
  "unsupported-response-shape",
  "missing-logical-output",
]);

class RuntimeExecutionError extends Error {
  readonly diagnostic: RuntimeFailureDiagnostic;

  constructor(
    role: RoleId,
    diagnostic: RuntimeFailureDiagnostic,
    message: string,
  ) {
    super(`${role} failed: ${message}`);
    this.name = "RuntimeExecutionError";
    this.diagnostic = {
      ...diagnostic,
      message,
    };
  }
}

export class RuntimeModelsExhaustedError extends Error {
  readonly code: RunFailureCode = "runtime-models-exhausted";
  readonly runtime: DurableRuntimeFailureSummary;

  constructor(message: string, runtime: DurableRuntimeFailureSummary) {
    super(message);
    this.name = "RuntimeModelsExhaustedError";
    this.runtime = runtime;
  }
}

export interface RuntimeAttemptFailure {
  durable: DurableRuntimeFailureAttempt;
  rendered: string;
}

function optionalSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : undefined;
}

function optionalDuration(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

function safeRuntimeFailureCode(value: unknown): RuntimeFailureCode {
  return typeof value === "string" &&
    RUNTIME_FAILURE_CODES.has(value as RuntimeFailureCode)
    ? (value as RuntimeFailureCode)
    : "runtime-error";
}

export function normalizeModelDisplay(value: string): string {
  const sanitized = sanitizeDiagnostic(
    value,
    DURABLE_RUNTIME_MODEL_MAX_CODE_POINTS,
  ).text;
  const singleLine = sanitized
    .replace(/[\r\n\t\u2028\u2029]+/g, " ")
    .replace(/\|/g, "¦")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/\s+/g, " ")
    .trim();
  return singleLine || "(empty model)";
}

function optionalModelDisplay(value: unknown): string | undefined {
  return typeof value === "string"
    ? normalizeModelDisplay(value)
    : undefined;
}

function durableAttempt(
  model: string,
  code: RuntimeFailureCode,
  rawMessage: string,
  diagnostic?: RuntimeFailureDiagnostic,
): DurableRuntimeFailureAttempt {
  const message = sanitizeDiagnostic(
    rawMessage,
    DURABLE_RUNTIME_FAILURE_MESSAGE_MAX_CODE_POINTS,
  );
  const requestedModel = optionalModelDisplay(diagnostic?.requestedModel);
  const configuredModel = optionalModelDisplay(diagnostic?.configuredModel);
  const exitCode = optionalSafeInteger(diagnostic?.exitCode);
  const durationMs = optionalDuration(diagnostic?.durationMs);

  return {
    model: normalizeModelDisplay(model),
    code,
    message: message.text,
    ...(requestedModel !== undefined ? { requestedModel } : {}),
    ...(configuredModel !== undefined ? { configuredModel } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(typeof diagnostic?.timedOut === "boolean"
      ? { timedOut: diagnostic.timedOut }
      : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(diagnostic?.promptTransport === "stdin" ||
    diagnostic?.promptTransport === "argv"
      ? { promptTransport: diagnostic.promptTransport }
      : {}),
    stderrPresent: diagnostic?.stderrPresent ?? false,
    truncated: Boolean(diagnostic?.truncated || message.truncated),
  };
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
  throw new RuntimeExecutionError(role, result.failure, diagnostic.text);
}

export function runtimeAttemptFailure(
  model: string,
  error: unknown,
): RuntimeAttemptFailure {
  const diagnostic =
    error instanceof RuntimeExecutionError ? error.diagnostic : undefined;
  const code = diagnostic?.code ?? "runtime-error";
  const rawMessage = error instanceof Error ? error.message : String(error);
  const durable = durableAttempt(
    model,
    code,
    diagnostic?.message ?? rawMessage,
    diagnostic,
  );
  return {
    durable,
    rendered: sanitizeDiagnostic(
      `${normalizeModelDisplay(model)} [${code}]: ${rawMessage}`,
      FAILURE_DIAGNOSTIC_MAX_CODE_POINTS,
    ).text,
  };
}

export function sanitizeDurableRuntimeFailureSummary(
  value: unknown,
): DurableRuntimeFailureSummary | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const rawAttempts = Array.isArray(candidate.attempts)
    ? candidate.attempts
    : [];
  const attempts: DurableRuntimeFailureAttempt[] = [];

  for (
    let index = 0;
    index < rawAttempts.length &&
    attempts.length < DURABLE_RUNTIME_FAILURE_ATTEMPT_LIMIT;
    index += 1
  ) {
    const raw = rawAttempts[index];
    if (!raw || typeof raw !== "object") continue;
    const attempt = raw as Record<string, unknown>;
    if (typeof attempt.model !== "string") continue;
    const message =
      typeof attempt.message === "string"
        ? attempt.message
        : "Runtime attempt failed.";
    const code = safeRuntimeFailureCode(attempt.code);
    const exitCode = optionalSafeInteger(attempt.exitCode);
    const durationMs = optionalDuration(attempt.durationMs);
    attempts.push(
      durableAttempt(
        attempt.model,
        code,
        message,
        {
          code,
          message,
          requestedModel:
            typeof attempt.requestedModel === "string"
              ? attempt.requestedModel
              : attempt.model,
          ...(typeof attempt.configuredModel === "string"
            ? { configuredModel: attempt.configuredModel }
            : {}),
          ...(exitCode !== undefined ? { exitCode } : {}),
          ...(typeof attempt.timedOut === "boolean"
            ? { timedOut: attempt.timedOut }
            : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(attempt.promptTransport === "stdin" ||
          attempt.promptTransport === "argv"
            ? { promptTransport: attempt.promptTransport }
            : {}),
          stderrPresent:
            typeof attempt.stderrPresent === "boolean"
              ? attempt.stderrPresent
              : false,
          truncated: attempt.truncated === true,
        },
      ),
    );
  }

  const requestedTotal = optionalSafeInteger(candidate.totalAttempts);
  const totalAttempts = Math.max(
    attempts.length,
    requestedTotal !== undefined && requestedTotal >= 0
      ? requestedTotal
      : attempts.length,
  );
  return {
    attempts,
    totalAttempts,
    omittedAttempts: Math.max(0, totalAttempts - attempts.length),
    aggregateTruncated: candidate.aggregateTruncated === true,
  };
}

export function makeDurableRuntimeFailureSummary(
  attempts: DurableRuntimeFailureAttempt[],
  totalAttempts: number,
  aggregateTruncated: boolean,
): DurableRuntimeFailureSummary {
  return sanitizeDurableRuntimeFailureSummary({
    attempts: attempts.slice(0, DURABLE_RUNTIME_FAILURE_ATTEMPT_LIMIT),
    totalAttempts,
    aggregateTruncated,
  })!;
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

export function reportOmittedFailureAttempts(
  aggregate: string,
  omittedAttempts: number,
): string {
  if (omittedAttempts === 0) return aggregate;
  const suffix = ` | ${omittedAttempts} additional model failure${omittedAttempts === 1 ? "" : "s"} omitted after aggregate limit`;
  const suffixLength = [...suffix].length;
  const prefix = sanitizeDiagnostic(
    aggregate,
    FAILURE_AGGREGATE_MAX_CODE_POINTS - suffixLength,
  ).text;
  return sanitizeDiagnostic(
    `${prefix}${suffix}`,
    FAILURE_AGGREGATE_MAX_CODE_POINTS,
  ).text;
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

export function runFailureRuntime(
  error: unknown,
): DurableRuntimeFailureSummary | undefined {
  return error instanceof RuntimeModelsExhaustedError
    ? sanitizeDurableRuntimeFailureSummary(error.runtime)
    : undefined;
}

export function runFailureDetails(
  code: RunFailureCode,
  message: string,
  runtime?: DurableRuntimeFailureSummary,
): {
  code: RunFailureCode;
  reason: string;
  runtime?: DurableRuntimeFailureSummary;
} {
  return {
    code,
    reason: sanitizeDiagnostic(
      message,
      FAILURE_AGGREGATE_MAX_CODE_POINTS,
    ).text,
    ...(runtime
      ? { runtime: sanitizeDurableRuntimeFailureSummary(runtime)! }
      : {}),
  };
}

export function safeFailureMessage(message: string): string {
  return sanitizeDiagnostic(
    message,
    FAILURE_AGGREGATE_MAX_CODE_POINTS,
  ).text;
}

export function assertRuntimeIdentity(
  result: RuntimeFinishedResult,
  role: RoleId,
): void {
  if (result.actualModel && result.actualModel !== result.requestedModel) {
    throw new Error(
      `${role} requested ${normalizeModelDisplay(result.requestedModel)}, but runtime reported ${normalizeModelDisplay(result.actualModel)}.`,
    );
  }
}
