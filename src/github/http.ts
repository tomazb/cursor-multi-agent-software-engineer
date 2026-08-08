import type { GitHubHttpClient } from "./checks.ts";

/** Default GitHub HTTP client using global fetch (injectable in tests). */
export function createFetchGitHubHttpClient(): GitHubHttpClient {
  return {
    async request(method, url, options) {
      const response = await fetch(url, {
        method,
        headers: options?.headers,
        body: options?.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const text = await response.text();
      let body: unknown = {};
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = { raw: text };
        }
      }
      return { status: response.status, headers, body };
    },
  };
}
