import { accessSync, constants, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../config.js';
import { describeError, IeeeMcpError } from '../errors.js';
import { debug } from '../http.js';
import { domainMatches, type Cookie } from './cookies.js';
import type { ProxySession, SessionStore } from './session.js';

export interface BrowserInfo {
  name: string;
  executablePath: string;
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): BrowserInfo[] {
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((r): r is string =>
      Boolean(r),
    );
    return roots.flatMap((root) => [
      { name: 'Google Chrome', executablePath: join(root, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      {
        name: 'Microsoft Edge',
        executablePath: join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      },
      {
        name: 'Brave',
        executablePath: join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      },
      { name: 'Chromium', executablePath: join(root, 'Chromium', 'Application', 'chrome.exe') },
    ]);
  }
  if (platform === 'darwin') {
    const apps = [
      ['Google Chrome', 'Google Chrome.app/Contents/MacOS/Google Chrome'],
      ['Microsoft Edge', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      ['Brave', 'Brave Browser.app/Contents/MacOS/Brave Browser'],
      ['Chromium', 'Chromium.app/Contents/MacOS/Chromium'],
    ] as const;
    return apps.flatMap(([name, path]) => [
      { name, executablePath: join('/Applications', path) },
      { name, executablePath: join(homedir(), 'Applications', path) },
    ]);
  }
  const names = [
    ['Google Chrome', 'google-chrome'],
    ['Google Chrome', 'google-chrome-stable'],
    ['Chromium', 'chromium'],
    ['Chromium', 'chromium-browser'],
    ['Microsoft Edge', 'microsoft-edge'],
    ['Microsoft Edge', 'microsoft-edge-stable'],
    ['Brave', 'brave-browser'],
    ['Brave', 'brave'],
  ] as const;
  const dirs = [
    '/usr/bin',
    '/usr/local/bin',
    '/snap/bin',
    '/opt/google/chrome',
    join(homedir(), '.local/bin'),
  ];
  return [
    ...names.flatMap(([name, bin]) => dirs.map((dir) => ({ name, executablePath: join(dir, bin) }))),
    { name: 'Google Chrome', executablePath: '/opt/google/chrome/chrome' },
  ];
}

/** Chromium downloaded with "npx playwright-core install chromium". */
function playwrightChromium(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): BrowserInfo | undefined {
  const cache =
    env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== '0'
      ? env.PLAYWRIGHT_BROWSERS_PATH
      : platform === 'win32'
        ? join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'ms-playwright')
        : platform === 'darwin'
          ? join(homedir(), 'Library', 'Caches', 'ms-playwright')
          : join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'ms-playwright');
  let entries: string[];
  try {
    entries = readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name));
  } catch {
    return undefined;
  }
  for (const entry of entries.sort().reverse()) {
    const dir = join(cache, entry);
    const paths =
      platform === 'win32'
        ? [join(dir, 'chrome-win', 'chrome.exe'), join(dir, 'chrome-win64', 'chrome.exe')]
        : platform === 'darwin'
          ? [
              join(dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
              join(dir, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
            ]
          : [join(dir, 'chrome-linux', 'chrome'), join(dir, 'chrome-linux64', 'chrome')];
    for (const path of paths)
      if (executable(path)) return { name: 'Playwright Chromium', executablePath: path };
  }
  return undefined;
}

export function findBrowser(
  browserPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): BrowserInfo | undefined {
  if (browserPath)
    return executable(browserPath) ? { name: 'Configured browser', executablePath: browserPath } : undefined;
  for (const candidate of candidates(platform, env))
    if (executable(candidate.executablePath)) return candidate;
  return playwrightChromium(platform, env);
}

/** The part of the proxy host shared by all proxied hosts and the proxy's own login host. */
export function proxySuffix(proxyHost: string): string {
  const labels = proxyHost.split('.');
  return labels.length > 2 ? labels.slice(1).join('.') : proxyHost;
}

/** The proxied Xplore host, reached after sign-in, as opposed to a login or identity provider page. */
export function isSignedInUrl(url: string, proxyHost: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase() === proxyHost.toLowerCase() && !/\/login\b/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

/** Keep cookies the proxy (or its sibling hosts) would receive; drop identity provider cookies. */
export function proxyCookies(cookies: Cookie[], proxyHost: string): Cookie[] {
  const suffix = proxySuffix(proxyHost);
  return cookies.filter((cookie) => {
    const domain = cookie.domain.replace(/^\./, '').toLowerCase();
    return domainMatches(proxyHost, domain) || domain === suffix || domain.endsWith(`.${suffix}`);
  });
}

let queue: Promise<unknown> = Promise.resolve();
/** Interactive sign-ins queued or running; a silent renewal must not wait behind one. */
let interactiveCount = 0;

export interface SignInOptions {
  headless: boolean;
  timeoutMs: number;
  log?: (message: string) => void;
}

/**
 * Open the dedicated browser profile on the proxied Xplore home page and wait until the
 * institution's sign-in lands there. Headless runs reuse the profile's identity provider
 * session to renew an expired proxy session without user interaction.
 */
export async function signIn(
  config: Config,
  store: SessionStore,
  options: SignInOptions,
): Promise<ProxySession> {
  const origin = config.proxyOrigin;
  if (!origin) {
    throw new IeeeMcpError(
      'NOT_CONFIGURED',
      "Set IEEE_PROXY_URL to your institution's proxied IEEE Xplore address first.",
    );
  }
  if (interactiveCount > 0 && options.headless) {
    throw new IeeeMcpError('LOGIN_IN_PROGRESS', 'A sign-in window is open. Finish it first.');
  }
  const run = async (): Promise<ProxySession> => {
    const browser = findBrowser(config.browserPath);
    if (!browser) {
      throw new IeeeMcpError(
        'BROWSER_NOT_FOUND',
        'No Chrome, Edge, Chromium or Brave was found. Install one, set IEEE_MCP_BROWSER, or run "npx playwright-core install chromium".',
      );
    }
    const { chromium } = await import('playwright-core');
    const saved = options.headless ? await store.load().catch(() => undefined) : undefined;
    let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>;
    try {
      context = await chromium.launchPersistentContext(config.profileDir, {
        executablePath: browser.executablePath,
        headless: options.headless,
        ...(saved?.userAgent ? { userAgent: saved.userAgent } : {}),
        viewport: options.headless ? { width: 1280, height: 900 } : null,
        ignoreDefaultArgs: ['--enable-automation'],
        args: ['--no-first-run', '--no-default-browser-check', '--disable-sync', '--password-store=basic'],
        acceptDownloads: false,
      });
    } catch (error) {
      const first = describeError(error).split('\n')[0]!.slice(0, 200);
      throw new IeeeMcpError(
        'BROWSER_FAILED',
        /already in use|ProcessSingleton|SingletonLock/i.test(first)
          ? 'The sign-in browser profile is in use by another window. Close the other ieee-xplore-mcp sign-in first.'
          : `Could not start ${browser.name}: ${first}`,
      );
    }
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      const host = new URL(origin).hostname;
      options.log?.(
        `Opening ${origin} in ${browser.name}. Sign in with your institution there (${Math.round(options.timeoutMs / 60_000)} minutes).`,
      );
      try {
        await page.goto(`${origin}/Xplore/home.jsp`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      } catch (error) {
        // DNS or connection failures will not fix themselves while the window waits; report them now.
        const net = /net::(ERR_[A-Z_]+)/.exec(describeError(error))?.[1];
        if (net) {
          throw new IeeeMcpError(
            'UPSTREAM_ERROR',
            `Could not open ${origin} (${net}). Check IEEE_PROXY_URL and the network connection (VPN).`,
          );
        }
        debug(`initial navigation: ${describeError(error)}`);
      }
      const deadline = Date.now() + options.timeoutMs;
      while (!isSignedInUrl(page.url(), host)) {
        if (page.isClosed()) throw new IeeeMcpError('LOGIN_CANCELLED', 'The sign-in window was closed.');
        if (Date.now() > deadline) {
          throw new IeeeMcpError(
            'LOGIN_TIMEOUT',
            options.headless
              ? 'The proxy session could not be renewed silently. Run "ieee-xplore-mcp login".'
              : 'Sign-in did not finish in time. Run "ieee-xplore-mcp login" again.',
          );
        }
        await page.waitForTimeout(1000).catch(() => undefined);
      }
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      const cookies = proxyCookies((await context.cookies()) as Cookie[], host);
      if (!cookies.length) {
        throw new IeeeMcpError(
          'AUTH_REQUIRED',
          'The proxy did not set a session cookie. Try signing in again.',
        );
      }
      const userAgent = String(await page.evaluate('navigator.userAgent')).replace(
        'HeadlessChrome',
        'Chrome',
      );
      const session: ProxySession = {
        origin,
        cookies,
        userAgent: saved?.userAgent ?? userAgent,
        savedAt: new Date().toISOString(),
      };
      await store.save(session);
      options.log?.('Signed in. The proxy session is saved.');
      return session;
    } finally {
      await context.close().catch(() => undefined);
    }
  };
  if (!options.headless) interactiveCount++;
  const next = queue.then(run, run).finally(() => {
    if (!options.headless) interactiveCount--;
  });
  queue = next.catch(() => undefined);
  return next;
}
