import { describe, expect, it, vi } from 'vitest';
import type { IeeeMcpError } from '../src/errors.js';
import { HttpClient, HttpError, parseRetryAfter, redactUrl, TtlCache, upstreamError } from '../src/http.js';
import { jsonResponse, mockFetch, textResponse } from './helpers.js';

describe('redactUrl', () => {
  it('hides keys and contact addresses', () => {
    expect(redactUrl('https://x/api?apikey=secret&q=1&api_key=k&mailto=me@x.org')).toBe(
      'https://x/api?apikey=***&q=1&api_key=***&mailto=***',
    );
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates', () => {
    expect(parseRetryAfter('36')).toBe(36);
    expect(parseRetryAfter(null)).toBeUndefined();
    const future = new Date(Date.now() + 10_000).toUTCString();
    expect(parseRetryAfter(future)).toBeGreaterThanOrEqual(8);
  });
});

describe('TtlCache', () => {
  it('expires and evicts', () => {
    vi.useFakeTimers();
    try {
      const cache = new TtlCache<number>(1000, 2);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('c')).toBe(3);
      vi.advanceTimersByTime(1001);
      expect(cache.get('c')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('HttpClient', () => {
  it('retries rate limits using Retry-After and caches successes', async () => {
    const sleeps: number[] = [];
    const fetch = mockFetch([
      { match: '/thing', times: 1, respond: () => textResponse('slow down', 429, { 'retry-after': '2' }) },
      { match: '/thing', respond: () => jsonResponse({ ok: true }) },
    ]);
    const http = new HttpClient({ fetch, timeoutMs: 1000, sleep: async (ms) => void sleeps.push(ms) });
    expect(await http.getJson('https://api.example.org/thing', { cacheTtlMs: 60_000 })).toEqual({ ok: true });
    expect(await http.getJson('https://api.example.org/thing', { cacheTtlMs: 60_000 })).toEqual({ ok: true });
    expect(sleeps).toEqual([2000]);
    expect(fetch.calls).toHaveLength(2);
  });

  it('gives up when the wait would exceed the budget', async () => {
    const fetch = mockFetch([
      { match: '/thing', respond: () => textResponse('busy', 429, { 'retry-after': '36' }) },
    ]);
    const http = new HttpClient({
      fetch,
      timeoutMs: 1000,
      maxRetryWaitMs: 5000,
      sleep: async () => undefined,
    });
    const error = await http.getText('https://api.example.org/thing').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).retryAfterSeconds).toBe(36);
  });

  it('does not cache a body that failed to arrive', async () => {
    let calls = 0;
    const http = new HttpClient({
      fetch: async () => {
        calls++;
        if (calls === 1) {
          const body = new ReadableStream({
            start(controller) {
              controller.error(new TypeError('terminated'));
            },
          });
          return new Response(body, { status: 200 });
        }
        return textResponse('fine');
      },
      timeoutMs: 1000,
    });
    await expect(http.getText('https://api.example.org/body', { cacheTtlMs: 60_000 })).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
    });
    expect(await http.getText('https://api.example.org/body', { cacheTtlMs: 60_000 })).toBe('fine');
  });

  it('maps network failures without leaking URLs', async () => {
    const http = new HttpClient({
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
      timeoutMs: 1000,
    });
    await expect(http.getText('https://api.example.org/x?apikey=secret')).rejects.toThrow(
      /Could not reach api\.example\.org\.[^?]*$/,
    );
  });

  it('sends an identifying user agent with the contact address', async () => {
    const fetch = mockFetch([{ match: '/ua', respond: () => textResponse('ok') }]);
    // Only APIs that ask for a contact address receive it.
    const http = new HttpClient({ fetch, timeoutMs: 1000, email: 'me@example.org' });
    await http.getText('https://api.example.org/ua', { contact: true });
    await http.getText('https://api.example.org/ua2');
    const headers = fetch.calls[0]!.init!.headers as Record<string, string>;
    expect(headers['User-Agent']).toMatch(/^ieee-xplore-mcp\/.+mailto:me@example\.org\)$/);
    const plain = fetch.calls[1]!.init!.headers as Record<string, string>;
    expect(plain['User-Agent']).not.toContain('mailto');
  });
});

describe('upstreamError', () => {
  it('maps status codes to stable codes', () => {
    expect((upstreamError('X', new HttpError(404, '')) as IeeeMcpError).code).toBe('NOT_FOUND');
    expect((upstreamError('X', new HttpError(429, '', 5)) as IeeeMcpError).message).toMatch(/in 5 s/);
    expect((upstreamError('X', new HttpError(503, '')) as IeeeMcpError).code).toBe('UPSTREAM_ERROR');
    const other = new Error('x');
    expect(upstreamError('X', other)).toBe(other);
  });
});
