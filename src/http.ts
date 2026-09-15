/** Shared HTTP layer: polite UA, timeouts, retries, abort propagation.
 * Node 20+ native fetch; zero runtime dependencies. */

export interface HttpOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Contact email for polite pools (crossref / openalex / unpaywall). */
  contactEmail?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
/** Only these statuses are retried; everything else fails fast. */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export const USER_AGENT = "dsh-papersearch/0.1.0 (+https://github.com/1-CellBio/dsh-papersearch)";

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpError";
    this.status = status;
  }
}

function mergeSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  return AbortSignal.any([signal, timeout]);
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }, { once: true });
  });

function retryDelayMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter && /^\d+$/.test(retryAfter.trim())) {
    const seconds = Number(retryAfter.trim());
    if (seconds > 0 && seconds <= 60) return seconds * 1000;
  }
  return Math.min(15_000, (attempt + 1) * 1_500);
}

async function fetchWithRetry(
  url: string,
  init: RequestInit & { timeoutMs?: number; signal?: AbortSignal },
): Promise<Response> {
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: mergeSignals(init.signal, timeoutMs),
        redirect: "follow",
      });
      if (!RETRYABLE.has(response.status)) {
        return response;
      }
      if (attempt === MAX_RETRIES - 1) {
        throw new HttpError(response.status, url);
      }
      await sleep(retryDelayMs(attempt, response.headers.get("retry-after")), init.signal);
    } catch (error) {
      lastError = error;
      if (error instanceof HttpError) throw error;
      if (init.signal?.aborted) throw error;
      if (attempt === MAX_RETRIES - 1) throw error;
      await sleep((attempt + 1) * 1_000, init.signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** GET a JSON document. Throws HttpError on non-2xx after retries. */
export async function getJson<T>(url: string, options: HttpOptions & { headers?: Record<string, string> } = {}): Promise<T> {
  const response = await fetchWithRetry(url, {
    method: "GET",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      ...(options.headers ?? {}),
    },
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  if (!response.ok) throw new HttpError(response.status, url);
  return (await response.json()) as T;
}

/** GET a text document (XML/HTML). */
export async function getText(url: string, options: HttpOptions & { headers?: Record<string, string> } = {}): Promise<string> {
  const response = await fetchWithRetry(url, {
    method: "GET",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/xml, text/xml, text/html, */*",
      ...(options.headers ?? {}),
    },
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  if (!response.ok) throw new HttpError(response.status, url);
  return await response.text();
}

/** Build a query string, skipping empty values. */
export function qs(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  return search.toString();
}

/** Polite-pool mailto query string fragment (crossref/openalex/unpaywall). */
export function mailtoParam(email?: string): string {
  const value = email?.trim();
  return value ? `mailto=${encodeURIComponent(value)}` : "";
}
