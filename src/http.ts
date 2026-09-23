import { IeeeMcpError } from './errors.js';
import { VERSION } from './version.js';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Diagnostics for IEEE_MCP_DEBUG=1, written to stderr so the MCP stream stays clean. */
export function debug(message: string): void {
  if (process.env.IEEE_MCP_DEBUG) process.stderr.write(`[ieee-mcp] ${message}\n`);
}

/** Remove API keys from a URL before it is logged. */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:apikey|api_key|mailto)=)[^&]*/gi, '$1***');
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
  }
}

/** Small TTL cache with insertion-order eviction. */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expires: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 500,
  ) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires < Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V, ttlMs = this.ttlMs): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expires: Date.now() + ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

export interface HttpOptions {
  fetch?: FetchLike;
  timeoutMs: number;
  /** Contact address for APIs that ask for one (OpenAlex, doi.org); never sent elsewhere. */
  email?: string;
  /** Upper bound on time spent waiting for Retry-After across retries. */
  maxRetryWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  /** Cache successful responses for this long. */
  cacheTtlMs?: number;
  /** Put the contact address in the user agent, for APIs that ask for it. */
  contact?: boolean;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/** A failure while connecting or reading a body, as a user-facing error naming only the host. */
export function transportError(url: string, error: unknown, action = 'reach'): IeeeMcpError {
  const host = new URL(url).hostname;
  if (isTimeout(error)) return new IeeeMcpError('TIMEOUT', `The request to ${host} timed out.`);
  return new IeeeMcpError('UPSTREAM_ERROR', `Could not ${action} ${host}. Check the network connection.`);
}

export class HttpClient {
  readonly fetch: FetchLike;
  readonly userAgent: string;
  private readonly contactUserAgent: string;
  private readonly cache = new TtlCache<string>(15 * 60_000);
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: HttpOptions) {
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.userAgent = `ieee-xplore-mcp/${VERSION} (+https://github.com/danieltyukov/ieee-mcp)`;
    this.contactUserAgent = options.email
      ? `ieee-xplore-mcp/${VERSION} (+https://github.com/danieltyukov/ieee-mcp; mailto:${options.email})`
      : this.userAgent;
  }

  /** GET a URL and return the body as text. Retries rate limits and transient server errors. */
  async getText(url: string, options: RequestOptions = {}): Promise<string> {
    const cacheKey = options.cacheTtlMs ? `${url}|${JSON.stringify(options.headers ?? {})}` : undefined;
    if (cacheKey) {
      const hit = this.cache.get(cacheKey);
      if (hit !== undefined) return hit;
    }
    const maxWait = this.options.maxRetryWaitMs ?? 20_000;
    let waited = 0;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      let body: string;
      try {
        debug(`GET ${redactUrl(url)}`);
        response = await this.fetch(url, {
          headers: {
            'User-Agent': options.contact ? this.contactUserAgent : this.userAgent,
            ...options.headers,
          },
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });
        body = await response.text();
      } catch (error) {
        throw transportError(url, error);
      }
      if (response.ok) {
        if (cacheKey && options.cacheTtlMs && body) this.cache.set(cacheKey, body, options.cacheTtlMs);
        return body;
      }
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      if (RETRYABLE.has(response.status) && attempt < 3) {
        const delay = Math.min(retryAfter !== undefined ? retryAfter * 1000 : 500 * 2 ** attempt, 45_000);
        if (waited + delay <= maxWait) {
          waited += delay;
          debug(`HTTP ${response.status}, retrying in ${delay} ms`);
          await this.sleep(delay);
          continue;
        }
      }
      throw new HttpError(response.status, body.slice(0, 2000), retryAfter);
    }
  }

  /** Download a binary file (one attempt, redirects followed) with a size cap. */
  async getBytes(url: string, options: { accept: string; maxBytes: number }): Promise<Uint8Array> {
    debug(`GET ${redactUrl(url)} (binary)`);
    let response: Response;
    try {
      response = await this.fetch(url, {
        headers: { 'User-Agent': this.userAgent, Accept: options.accept },
        signal: AbortSignal.timeout(this.options.timeoutMs * 2),
      });
    } catch (error) {
      throw transportError(url, error);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new HttpError(response.status, '');
    }
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > options.maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new IeeeMcpError('FILE_TOO_LARGE', 'The file is larger than the download limit.');
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      throw transportError(url, error, 'finish the download from');
    }
    if (bytes.byteLength > options.maxBytes) {
      throw new IeeeMcpError('FILE_TOO_LARGE', 'The file is larger than the download limit.');
    }
    return bytes;
  }

  async getJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
    const text = await this.getText(url, {
      ...options,
      headers: { Accept: 'application/json', ...options.headers },
    });
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new IeeeMcpError(
        'UPSTREAM_ERROR',
        `${new URL(url).hostname} returned a response that is not JSON.`,
      );
    }
  }
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.round((date - Date.now()) / 1000));
}

/** Map an HttpError from a documented API into a user-facing error. */
export function upstreamError(service: string, error: unknown): unknown {
  if (!(error instanceof HttpError)) return error;
  if (error.status === 404)
    return new IeeeMcpError('NOT_FOUND', `${service} has no record for this request.`);
  if (error.status === 429) {
    const wait = error.retryAfterSeconds !== undefined ? ` Try again in ${error.retryAfterSeconds} s.` : '';
    return new IeeeMcpError('RATE_LIMITED', `${service} rate limit reached.${wait}`);
  }
  if (error.status >= 500)
    return new IeeeMcpError('UPSTREAM_ERROR', `${service} is not responding (HTTP ${error.status}).`);
  return new IeeeMcpError('UPSTREAM_ERROR', `${service} rejected the request (HTTP ${error.status}).`);
}
