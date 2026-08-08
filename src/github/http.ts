import type { GitHubHttpClient } from "./checks.ts";

/** Default GitHub HTTP client using global fetch (injectable in tests). */
export function createFetchGitHubHttpClient(): GitHubHttpClient {
  return {
    async request(method, url, options) {
      const init: RequestInit = { method };
      if (options?.headers) init.headers = options.headers;
      if (options?.body !== undefined) init.body = JSON.stringify(options.body);
      const response = await fetch(url, init);
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
