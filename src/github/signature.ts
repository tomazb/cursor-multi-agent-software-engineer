import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify GitHub webhook `X-Hub-Signature-256` against the raw request body.
 * Returns false for missing/malformed signatures; never throws on bad input.
 */
export function verifyGitHubWebhookSignature(
  secret: string,
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
): boolean {
  if (!secret || signatureHeader === undefined || signatureHeader === "") {
    return false;
  }
  const match = /^sha256=([a-fA-F0-9]{64})$/.exec(signatureHeader.trim());
  if (!match) return false;

  const expectedHex = createHmac("sha256", secret)
    .update(typeof rawBody === "string" ? rawBody : new Uint8Array(rawBody))
    .digest("hex");
  const provided = Buffer.from(match[1]!.toLowerCase(), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
