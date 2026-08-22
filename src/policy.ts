import type { PermissionMode, PolicyViolationCode, RoleId } from "./domain.ts";

export const ROLE_PERMISSION_POLICY = Object.freeze({
  brainstormer: "read-only",
  designer: "read-only",
  builder: "workspace-write",
  verifier: "read-only",
  prResolver: "workspace-write",
} satisfies Record<RoleId, PermissionMode>);

export class PolicyViolationError extends Error {
  readonly code: PolicyViolationCode;

  constructor(code: PolicyViolationCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PolicyViolationError";
    this.code = code;
  }
}

export function assertConfiguredRolePermission(
  role: RoleId,
  permission: PermissionMode,
): void {
  const expected = ROLE_PERMISSION_POLICY[role];
  if (permission !== expected) {
    throw new PolicyViolationError(
      "policy-role-permission-mismatch",
      `${role} requires ${expected} permission, got ${permission}.`,
    );
  }
}

export function resolveExecutionPermission(
  role: RoleId,
  configured: PermissionMode,
  override?: PermissionMode,
): PermissionMode {
  assertConfiguredRolePermission(role, configured);
  if (override === undefined) return configured;
  if (role === "prResolver" && override === "read-only") return override;
  throw new PolicyViolationError(
    "policy-role-permission-mismatch",
    `${role} execution cannot override ${configured} permission with ${override}.`,
  );
}

export function findPolicyViolationError(error: unknown): PolicyViolationError | undefined {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (candidate instanceof PolicyViolationError) return candidate;
    if (candidate instanceof AggregateError) pending.push(...candidate.errors);
    if (candidate instanceof Error && candidate.cause !== undefined) pending.push(candidate.cause);
  }
  return undefined;
}

export const isPolicyViolationError = (error: unknown): error is PolicyViolationError =>
  error instanceof PolicyViolationError;
