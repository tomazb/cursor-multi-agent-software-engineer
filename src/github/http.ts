export interface GitHubHttpClient {
  request(
    method: string,
    url: string,
    options?: { headers?: Record<string, string>; body?: unknown },
  ): Promise<{ status: number; headers: Record<string, string>; body: unknown }>;
}

export const DEFAULT_GITHUB_HTTP_TIMEOUT_MS = 30_000;

export interface FetchGitHubHttpClientOptions {
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

/** Default GitHub HTTP client using global fetch (injectable in tests). */
export function createFetchGitHubHttpClient(
  options: FetchGitHubHttpClientOptions = {},
): GitHubHttpClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GITHUB_HTTP_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error("GitHub HTTP timeoutMs must be an integer between 1 and 2147483647");
  }
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  return {
    async request(method, url, options) {
      const init: RequestInit = { method };
      if (options?.headers) init.headers = options.headers;
      if (options?.body !== undefined) init.body = JSON.stringify(options.body);
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      init.signal = controller.signal;
      try {
        const response = await fetchFn(url, init);
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
      } catch (error) {
        if (timedOut) {
          throw new Error(`GitHub HTTP request timed out after ${timeoutMs}ms`);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
