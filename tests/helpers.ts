import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config.js';
import type { FetchLike } from '../src/http.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');

export function fixtureText(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

export function fixtureBytes(name: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

export function fixtureJson<T = unknown>(name: string): T {
  return JSON.parse(fixtureText(name)) as T;
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function textResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain', ...headers } });
}

export interface Route {
  /** Matches when the URL (with query) contains this string, or the predicate returns true. */
  match: string | RegExp | ((url: URL) => boolean);
  respond: (url: URL, init?: RequestInit) => Response | Promise<Response>;
  /** Respond at most this many times, then fall through to later routes. */
  times?: number;
}

export interface MockFetch extends FetchLike {
  calls: { url: string; init?: RequestInit }[];
}

/** A fetch that answers from routes in order and fails loudly on anything unexpected. */
export function mockFetch(routes: Route[]): MockFetch {
  const used = new Map<Route, number>();
  const calls: MockFetch['calls'] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), ...(init ? { init } : {}) });
    for (const route of routes) {
      const count = used.get(route) ?? 0;
      if (route.times !== undefined && count >= route.times) continue;
      const hit =
        typeof route.match === 'string'
          ? url.toString().includes(route.match)
          : route.match instanceof RegExp
            ? route.match.test(url.toString())
            : route.match(url);
      if (!hit) continue;
      used.set(route, count + 1);
      return route.respond(url, init);
    }
    throw new Error(`Unexpected request in test: ${url.toString()}`);
  }) as MockFetch;
  fetch.calls = calls;
  return fetch;
}

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'ieee-mcp-test-'));
}

export function testConfig(env: Record<string, string> = {}): Config {
  const home = tempHome();
  return loadConfig({ IEEE_MCP_HOME: home, IEEE_MCP_DOWNLOAD_DIR: join(home, 'downloads'), ...env });
}

export const noSleep = async (): Promise<void> => undefined;
