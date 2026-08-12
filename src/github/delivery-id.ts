const SAFE_GITHUB_DELIVERY_ID = /^[A-Za-z0-9._-]+$/;

export function isSafeGitHubDeliveryId(value: unknown): value is string {
  return typeof value === "string" && SAFE_GITHUB_DELIVERY_ID.test(value);
}
