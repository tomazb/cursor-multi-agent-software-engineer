import { createSign, createPrivateKey } from "node:crypto";

export interface GitHubTokenHttp {
  request(
    method: string,
    url: string,
    options?: { headers?: Record<string, string>; body?: unknown },
  ): Promise<{ status: number; headers: Record<string, string>; body: unknown }>;
}

function base64Url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64url");
}

/** Create a short-lived GitHub App JWT (RS256) from a PEM private key. */
export function createGitHubAppJwt(appId: string, privateKeyPem: string, nowMs = Date.now()): string {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const iat = Math.floor(nowMs / 1000) - 60;
  const exp = iat + 10 * 60;
  const payload = base64Url(JSON.stringify({ iat, exp, iss: appId }));
  const data = `${header}.${payload}`;
  const key = createPrivateKey(privateKeyPem);
  const signer = createSign("RSA-SHA256");
  signer.update(data);
  signer.end();
  const signature = signer.sign(key).toString("base64url");
  return `${data}.${signature}`;
}

export async function createInstallationAccessToken(options: {
  appId: string;
  privateKeyPem: string;
  installationId: number;
  http: GitHubTokenHttp;
  nowMs?: number;
}): Promise<string> {
  const jwt = createGitHubAppJwt(options.appId, options.privateKeyPem, options.nowMs);
  const response = await options.http.request(
    "POST",
    `https://api.github.com/app/installations/${options.installationId}/access_tokens`,
    {
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "user-agent": "maswe-github-app",
      },
      body: {},
    },
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Failed to create installation token: HTTP ${response.status}`);
  }
  const body = response.body as { token?: string };
  if (typeof body.token !== "string" || !body.token) {
    throw new Error("Installation token response missing token");
  }
  return body.token;
}
