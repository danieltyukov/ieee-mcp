import type { Config } from '../config.js';
import { IeeeMcpError } from '../errors.js';
import { debug, type FetchLike } from '../http.js';
import { VERSION } from '../version.js';
import { proxySuffix } from './browser.js';
import { cookieHeader, mergeCookies, parseSetCookie, type Cookie } from './cookies.js';
import {
  withFileLock,
  type ProxySession,
  type ProxyUsage,
  type SessionStore,
  type UsageStore,
} from './session.js';

export interface ProxyStatus {
  configured: boolean;
  origin?: string;
  signedIn: boolean;
  savedAt?: string;
  /** Result of a live check, when requested. */
  valid?: boolean;
  /** Why the live check could not decide, e.g. the proxy was unreachable. */
  checkError?: string;
  downloadsToday: number;
  dailyLimit: number;
}

interface Fetched {
  url: URL;
  status: number;
  contentType: string;
  body: Uint8Array;
}

export class AuthRequired extends IeeeMcpError {
  constructor(detail?: string) {
    super(
      'AUTH_REQUIRED',
      `The institutional proxy session has expired or was never created.${detail ? ` ${detail}` : ''} Run "ieee-xplore-mcp login" in a terminal, or ask to use the sign_in tool.`,
    );
  }
}

export type RenewResult = { ok: true } | { ok: false; reason: string };

/** Pages IEEE or a proxy shows instead of content when it suspects automated access. */
const BLOCK_PAGE =
  /captcha|unusual traffic|are you a robot|request (was )?blocked|access (is )?denied|too many requests|excessive/i;

function utcDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

export function isPdf(bytes: Uint8Array): boolean {
  // "%PDF-", allowing a little leading whitespace or a byte order mark.
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
  return head.includes('%PDF-');
}

/** IEEE sometimes wraps the PDF in a stamp page that embeds getPDF.jsp in a frame. */
export function embeddedPdfUrl(html: string, base: URL): URL | undefined {
  const match = /<(?:iframe|embed|frame)[^>]+src=["']([^"']+)["']/i.exec(html);
  if (!match?.[1]) return undefined;
  const src = match[1].replace(/&amp;/g, '&');
  if (!/getPDF\.jsp|\.pdf/i.test(src)) return undefined;
  try {
    return new URL(src, base);
  } catch {
    return undefined;
  }
}

export interface ProxyClientOptions {
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Silent re-sign-in through the saved browser profile. */
  renew?: () => Promise<RenewResult>;
}

/** Fetches one PDF at a time through the institution's EZproxy with the saved sign-in. */
export class ProxyClient {
  private lane: Promise<unknown> = Promise.resolve();
  private readonly fetch: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Why refreshed cookies could not be saved, reported with the next sign-in error. */
  private saveFailure?: string;

  constructor(
    private readonly config: Config,
    private readonly sessions: SessionStore,
    private readonly usage: UsageStore,
    private readonly options: ProxyClientOptions = {},
  ) {
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get origin(): string | undefined {
    return this.config.proxyOrigin;
  }

  /** The proxied Xplore page of an article, for the user to open in a browser. */
  documentUrl(articleNumber: string): string | undefined {
    return this.origin ? `${this.origin}/document/${articleNumber}` : undefined;
  }

  async status(check: boolean): Promise<ProxyStatus> {
    const session = await this.session();
    const usage = await this.todayUsage();
    const status: ProxyStatus = {
      configured: Boolean(this.origin),
      signedIn: Boolean(session),
      downloadsToday: usage.count,
      dailyLimit: this.config.proxyDailyLimit,
      ...(this.origin ? { origin: this.origin } : {}),
      ...(session ? { savedAt: session.savedAt } : {}),
    };
    if (check && session) {
      // Through the lane, so a check never races a download over the same cookies.
      const check = async (): Promise<void> => {
        try {
          await this.request(session, new URL(`${this.origin}/Xplore/home.jsp`), 'text/html');
          status.valid = true;
        } catch (error) {
          if (error instanceof AuthRequired) status.valid = false;
          else status.checkError = error instanceof IeeeMcpError ? error.message : 'The check failed.';
        }
      };
      const next = this.lane.then(check, check);
      this.lane = next.catch(() => undefined);
      await next;
    }
    return status;
  }

  private async session(): Promise<ProxySession | undefined> {
    if (!this.origin) return undefined;
    const session = await this.sessions.load();
    return session && session.origin === this.origin ? session : undefined;
  }

  private async todayUsage(): Promise<ProxyUsage> {
    const saved = await this.usage.load();
    const day = utcDay(this.now());
    return saved && saved.day === day ? saved : { day, count: 0, lastAt: saved?.lastAt ?? 0 };
  }

  /** Download one article's PDF. Serialised, spaced out and capped per day. */
  async fetchPdf(articleNumber: string): Promise<Uint8Array> {
    if (!this.origin) {
      throw new IeeeMcpError('NOT_CONFIGURED', 'No institutional proxy is configured (IEEE_PROXY_URL).');
    }
    const run = async (): Promise<Uint8Array> => {
      let session = await this.session();
      if (!session) throw new AuthRequired();
      await this.reserve();
      const url = new URL(
        `${this.origin}/stampPDF/getPDF.jsp?tp=&arnumber=${encodeURIComponent(articleNumber)}&ref=`,
      );
      try {
        return await this.download(session, url);
      } catch (error) {
        if (!(error instanceof AuthRequired)) throw error;
        if (!this.options.renew) throw this.explainAuth();
        debug('proxy session expired, trying a silent renewal');
        const renewed = await this.options.renew();
        if (!renewed.ok) throw this.explainAuth(`Silent renewal failed: ${renewed.reason}`);
        session = await this.session();
        if (!session) throw this.explainAuth();
        return this.download(session, url);
      }
    };
    const next = this.lane.then(run, run);
    this.lane = next.catch(() => undefined);
    return next;
  }

  private explainAuth(detail?: string): AuthRequired {
    const parts = [detail, this.saveFailure].filter(Boolean);
    return new AuthRequired(parts.length ? parts.join(' ') : undefined);
  }

  /**
   * Book a download slot under a lock shared by every server process: check the daily cap, then
   * record the slot before waiting, so concurrent processes queue behind it instead of all
   * reading the same count.
   */
  private async reserve(): Promise<void> {
    const interval = this.config.proxyMinIntervalMs;
    const wait = await withFileLock(this.usage.lock, async () => {
      const usage = await this.todayUsage();
      if (usage.count >= this.config.proxyDailyLimit) {
        throw new IeeeMcpError(
          'RATE_LIMITED',
          `The daily limit of ${this.config.proxyDailyLimit} proxy downloads is reached. It resets at midnight UTC (IEEE_MCP_PROXY_DAILY_LIMIT).`,
        );
      }
      const now = this.now();
      // A slot far in the future can only come from a clock that moved backwards.
      const last = Math.min(usage.lastAt, now + interval * this.config.proxyDailyLimit);
      const slot = Math.max(now, last + interval);
      await this.usage.save({ day: usage.day, count: usage.count + 1, lastAt: slot });
      return slot - now;
    });
    if (wait > 0) await this.sleep(wait);
  }

  private async download(session: ProxySession, url: URL): Promise<Uint8Array> {
    let fetched = await this.request(session, url, 'application/pdf');
    if (!isPdf(fetched.body)) {
      const html = Buffer.from(fetched.body).toString('utf8');
      const inner = embeddedPdfUrl(html, fetched.url);
      if (inner) fetched = await this.request((await this.session()) ?? session, inner, 'application/pdf');
    }
    if (isPdf(fetched.body)) return fetched.body;
    const html = Buffer.from(fetched.body.subarray(0, 20_000)).toString('utf8');
    debug(`proxy returned a page titled "${/<title[^>]*>([^<]{0,120})/i.exec(html)?.[1]?.trim() ?? ''}"`);
    if (/type=["']password["']/i.test(html)) throw new AuthRequired();
    if (BLOCK_PAGE.test(html)) {
      throw new IeeeMcpError(
        'RATE_LIMITED',
        'IEEE or the proxy answered with a bot check or an access block. Stop downloading for now and open the paper in a browser.',
      );
    }
    throw new IeeeMcpError(
      'NO_FULL_TEXT',
      'The proxy returned a web page instead of the PDF, so your institution probably does not license this paper.',
    );
  }

  /**
   * GET through the proxy, following redirects by hand so cookies apply per host. A redirect
   * away from the proxy's hosts or onto a login page means the session is gone.
   */
  private async request(session: ProxySession, start: URL, accept: string): Promise<Fetched> {
    const proxyHost = new URL(session.origin).hostname.toLowerCase();
    const suffix = proxySuffix(proxyHost);
    let jar: Cookie[] = session.cookies;
    const updates: Cookie[] = [];
    let url = start;
    try {
      for (let hop = 0; hop < 10; hop++) {
        const host = url.hostname.toLowerCase();
        const onProxy = host === proxyHost || host.endsWith(`.${suffix}`);
        if (url.protocol !== 'https:') {
          throw new IeeeMcpError(
            'UPSTREAM_ERROR',
            'The proxy pointed to an insecure http address; stopped to protect the session.',
          );
        }
        if (!onProxy && hop === 0) {
          throw new IeeeMcpError('UPSTREAM_ERROR', `The PDF link points outside the proxy (${host}).`);
        }
        // A redirect off the proxy or onto its login page means the session is gone.
        if (!onProxy || /\/login\b/i.test(url.pathname)) throw new AuthRequired();
        debug(`proxy GET ${url.host}${url.pathname}`);
        let response: Response;
        let body: Uint8Array | undefined;
        try {
          response = await this.fetch(url, {
            redirect: 'manual',
            headers: {
              // The session belongs to the browser that signed in, so requests carry its user agent.
              'User-Agent': session.userAgent ?? `ieee-xplore-mcp/${VERSION}`,
              Accept: accept === 'application/pdf' ? 'application/pdf,*/*;q=0.8' : 'text/html,*/*;q=0.8',
              Cookie: cookieHeader(jar, url, this.now() / 1000),
            },
            signal: AbortSignal.timeout(this.config.timeoutMs * 2),
          });
          const setCookies = response.headers.getSetCookie?.() ?? [];
          if (setCookies.length) {
            const parsed = setCookies
              .map((header) => parseSetCookie(header, url, this.now() / 1000))
              .filter((c): c is Cookie => Boolean(c));
            jar = mergeCookies(jar, parsed, this.now() / 1000);
            updates.push(...parsed);
          }
          const location = response.headers.get('location');
          if (response.status >= 300 && response.status < 400 && location) {
            await response.body?.cancel().catch(() => undefined);
            url = new URL(location, url);
            continue;
          }
          if (response.ok) {
            const length = Number(response.headers.get('content-length') ?? 0);
            if (length > this.config.maxPdfBytes) {
              await response.body?.cancel().catch(() => undefined);
              throw new IeeeMcpError('FILE_TOO_LARGE', 'The PDF is larger than the 60 MB limit.');
            }
            body = new Uint8Array(await response.arrayBuffer());
          } else {
            await response.body?.cancel().catch(() => undefined);
          }
        } catch (error) {
          if (error instanceof IeeeMcpError) throw error;
          if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
            throw new IeeeMcpError('TIMEOUT', 'The institutional proxy did not answer in time.');
          }
          throw new IeeeMcpError('UPSTREAM_ERROR', 'The connection to the institutional proxy failed.');
        }
        if (response.status === 401 || response.status === 403) throw new AuthRequired();
        if (response.status === 404)
          throw new IeeeMcpError('NOT_FOUND', 'The proxy does not know this article.');
        if (!body) {
          throw new IeeeMcpError(
            'UPSTREAM_ERROR',
            `The institutional proxy answered HTTP ${response.status}.`,
          );
        }
        if (body.byteLength > this.config.maxPdfBytes) {
          throw new IeeeMcpError('FILE_TOO_LARGE', 'The PDF is larger than the 60 MB limit.');
        }
        return {
          url,
          status: response.status,
          contentType: response.headers.get('content-type') ?? '',
          body,
        };
      }
      throw new IeeeMcpError('UPSTREAM_ERROR', 'The proxy redirected too many times.');
    } finally {
      if (updates.length) await this.persist(session.savedAt, updates);
    }
  }

  /** Save cookies the proxy rotated, without overwriting a newer sign-in; report failures loudly. */
  private async persist(savedAt: string, updates: Cookie[]): Promise<void> {
    try {
      const saved = await this.sessions.mergeCookies(savedAt, updates);
      if (!saved) debug('session changed during the request; refreshed cookies were not merged');
      this.saveFailure = undefined;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.saveFailure = `Refreshed proxy cookies could not be saved (${reason}).`;
      console.error(`[ieee-mcp] ${this.saveFailure}`);
    }
  }
}
