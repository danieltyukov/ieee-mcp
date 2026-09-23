export interface Cookie {
  name: string;
  value: string;
  /** Leading dot allowed; matched per RFC 6265 section 5.1.3. */
  domain: string;
  path: string;
  /** Unix seconds, -1 for session cookies. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/** Whether a cookie set for `domain` is sent to `host`. */
export function domainMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  const d = domain.toLowerCase().replace(/^\./, '');
  return h === d || h.endsWith(`.${d}`);
}

export function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (!cookiePath || cookiePath === '/') return true;
  if (requestPath === cookiePath) return true;
  return requestPath.startsWith(cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`);
}

function live(cookie: Cookie, nowSeconds: number): boolean {
  return cookie.expires <= 0 || cookie.expires > nowSeconds;
}

export function cookieHeader(cookies: Cookie[], url: URL, nowSeconds = Date.now() / 1000): string {
  return cookies
    .filter(
      (c) =>
        live(c, nowSeconds) &&
        domainMatches(url.hostname, c.domain) &&
        pathMatches(url.pathname, c.path) &&
        (!c.secure || url.protocol === 'https:'),
    )
    .sort((a, b) => b.path.length - a.path.length)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/** Parse one Set-Cookie header received from `url`. Returns undefined for malformed headers. */
export function parseSetCookie(header: string, url: URL, nowSeconds = Date.now() / 1000): Cookie | undefined {
  const [pair, ...attributes] = header.split(';');
  const eq = pair?.indexOf('=') ?? -1;
  if (!pair || eq <= 0) return undefined;
  const cookie: Cookie = {
    name: pair.slice(0, eq).trim(),
    value: pair.slice(eq + 1).trim(),
    domain: url.hostname,
    path: '/',
    expires: -1,
    httpOnly: false,
    secure: false,
  };
  let maxAge: number | undefined;
  for (const attribute of attributes) {
    const [rawKey, ...rest] = attribute.split('=');
    const key = rawKey?.trim().toLowerCase();
    const value = rest.join('=').trim();
    if (key === 'domain' && value) {
      // A server may only set cookies for its own domain or a parent of it.
      if (!domainMatches(url.hostname, value)) return undefined;
      cookie.domain = `.${value.replace(/^\./, '')}`;
    } else if (key === 'path' && value.startsWith('/')) cookie.path = value;
    else if (key === 'expires') {
      const time = Date.parse(value);
      if (!Number.isNaN(time)) cookie.expires = Math.floor(time / 1000);
    } else if (key === 'max-age') {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) maxAge = seconds;
    } else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'samesite') {
      const normalized = value.toLowerCase();
      if (normalized === 'strict') cookie.sameSite = 'Strict';
      else if (normalized === 'lax') cookie.sameSite = 'Lax';
      else if (normalized === 'none') cookie.sameSite = 'None';
    }
  }
  // Max-Age wins over Expires; zero or less means delete, so pin it to a moment long past.
  if (maxAge !== undefined) cookie.expires = maxAge <= 0 ? 1 : Math.floor(nowSeconds + maxAge);
  return cookie;
}

/** Apply updates to a jar: same name, domain and path replace; expired updates delete. */
export function mergeCookies(jar: Cookie[], updates: Cookie[], nowSeconds = Date.now() / 1000): Cookie[] {
  const key = (c: Cookie): string => `${c.domain.replace(/^\./, '').toLowerCase()}|${c.path}|${c.name}`;
  const merged = new Map(jar.map((c) => [key(c), c]));
  for (const update of updates) {
    if (live(update, nowSeconds)) merged.set(key(update), update);
    else merged.delete(key(update));
  }
  return [...merged.values()].filter((c) => live(c, nowSeconds));
}
