import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { IeeeMcpError } from './errors.js';

export interface Config {
  /** Data directory, default ~/.ieee-mcp */
  home: string;
  profileDir: string;
  sessionFile: string;
  stateFile: string;
  cacheDir: string;
  downloadDir: string;
  ieeeApiKey: string | undefined;
  openAlexApiKey: string | undefined;
  /** Contact address sent to OpenAlex and Crossref so they can reach the operator. */
  email: string | undefined;
  /** Origin of the proxied Xplore host, e.g. https://ieeexplore-ieee-org.tudelft.idm.oclc.org */
  proxyOrigin: string | undefined;
  browserPath: string | undefined;
  proxyDailyLimit: number;
  proxyMinIntervalMs: number;
  timeoutMs: number;
  loginTimeoutMs: number;
  silentLoginTimeoutMs: number;
  maxPdfBytes: number;
}

/** Keep only the origin of a proxied Xplore URL. Accepts a bare host as well. */
export function parseProxyUrl(value: string): string {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new IeeeMcpError(
      'INVALID_ARGUMENT',
      'IEEE_PROXY_URL must be a URL such as https://ieeexplore-ieee-org.your-proxy.edu',
    );
  }
  if (url.protocol !== 'https:') {
    throw new IeeeMcpError('INVALID_ARGUMENT', 'IEEE_PROXY_URL must use https.');
  }
  if (url.username || url.password) {
    throw new IeeeMcpError('INVALID_ARGUMENT', 'IEEE_PROXY_URL must not contain credentials.');
  }
  return url.origin;
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new IeeeMcpError('INVALID_ARGUMENT', `${name} must be a non-negative integer.`);
  }
  return parsed;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = resolve(env.IEEE_MCP_HOME ?? join(homedir(), '.ieee-mcp'));
  const proxy = optional(env.IEEE_PROXY_URL);
  return {
    home,
    profileDir: join(home, 'profile'),
    sessionFile: join(home, 'session.json'),
    stateFile: join(home, 'state.json'),
    cacheDir: join(home, 'cache'),
    downloadDir: resolve(env.IEEE_MCP_DOWNLOAD_DIR ?? join(homedir(), 'Downloads', 'ieee-papers')),
    ieeeApiKey: optional(env.IEEE_API_KEY),
    openAlexApiKey: optional(env.OPENALEX_API_KEY),
    email: optional(env.IEEE_MCP_EMAIL),
    proxyOrigin: proxy ? parseProxyUrl(proxy) : undefined,
    browserPath: optional(env.IEEE_MCP_BROWSER),
    proxyDailyLimit: positiveInt(env.IEEE_MCP_PROXY_DAILY_LIMIT, 40, 'IEEE_MCP_PROXY_DAILY_LIMIT'),
    proxyMinIntervalMs: 10_000,
    timeoutMs: 30_000,
    loginTimeoutMs: 10 * 60_000,
    silentLoginTimeoutMs: 45_000,
    maxPdfBytes: 60 * 1024 * 1024,
  };
}

export const SERVER_NAME = 'ieee-xplore';
