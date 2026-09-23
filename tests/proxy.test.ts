import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { isSignedInUrl, proxyCookies, proxySuffix, findBrowser } from '../src/proxy/browser.js';
import { AuthRequired, embeddedPdfUrl, isPdf, ProxyClient, type RenewResult } from '../src/proxy/client.js';
import type { Cookie } from '../src/proxy/cookies.js';
import { SessionStore, UsageStore, type ProxySession } from '../src/proxy/session.js';
import { fixtureBytes, mockFetch, testConfig, textResponse, type Route } from './helpers.js';

const ORIGIN = 'https://ieeexplore-ieee-org.tudelft.idm.oclc.org';
const pdf = fixtureBytes('sample.pdf');

const ezproxy: Cookie = {
  name: 'ezproxy',
  value: 'session-1',
  domain: '.tudelft.idm.oclc.org',
  path: '/',
  expires: -1,
  httpOnly: true,
  secure: true,
};

async function setup(
  routes: Route[],
  options: { signedIn?: boolean; limit?: string; renew?: () => Promise<RenewResult> } = {},
) {
  const config = testConfig({
    IEEE_PROXY_URL: `${ORIGIN}/Xplore/home.jsp`,
    IEEE_MCP_PROXY_DAILY_LIMIT: options.limit ?? '40',
  });
  const sessions = new SessionStore(config.sessionFile);
  const usage = new UsageStore(config.stateFile);
  if (options.signedIn !== false) {
    await sessions.save({
      origin: ORIGIN,
      cookies: [ezproxy],
      userAgent: 'Mozilla/5.0 Test',
      savedAt: '2026-09-23T10:00:00Z',
    });
  }
  const fetch = mockFetch(routes);
  const sleeps: number[] = [];
  let now = Date.UTC(2026, 8, 23, 12);
  const client = new ProxyClient(config, sessions, usage, {
    fetch,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    ...(options.renew ? { renew: options.renew } : {}),
  });
  return { client, fetch, sessions, usage, sleeps, config, advance: (ms: number) => (now += ms) };
}

const pdfResponse = () => new Response(pdf, { status: 200, headers: { 'content-type': 'application/pdf' } });
const redirect = (location: string, cookie?: string) =>
  new Response(null, { status: 302, headers: { location, ...(cookie ? { 'set-cookie': cookie } : {}) } });

describe('proxy helpers', () => {
  it('derives the shared suffix of proxied hosts', () => {
    expect(proxySuffix('ieeexplore-ieee-org.tudelft.idm.oclc.org')).toBe('tudelft.idm.oclc.org');
    expect(proxySuffix('ieeexplore.ieee.org.proxy.example.edu')).toBe('ieee.org.proxy.example.edu');
  });

  it('recognises the signed-in page', () => {
    const host = 'ieeexplore-ieee-org.tudelft.idm.oclc.org';
    expect(isSignedInUrl(`${ORIGIN}/Xplore/home.jsp`, host)).toBe(true);
    expect(isSignedInUrl('https://login.tudelft.idm.oclc.org/login?qurl=x', host)).toBe(false);
    expect(isSignedInUrl('https://login.microsoftonline.com/common/oauth2', host)).toBe(false);
    expect(isSignedInUrl(`${ORIGIN}/login?url=x`, host)).toBe(false);
  });

  it('keeps proxy cookies and drops identity provider cookies', () => {
    const cookies = proxyCookies(
      [
        ezproxy,
        { ...ezproxy, name: 'ESTSAUTH', domain: '.login.microsoftonline.com' },
        { ...ezproxy, name: 'site', domain: 'ieeexplore-ieee-org.tudelft.idm.oclc.org' },
      ],
      'ieeexplore-ieee-org.tudelft.idm.oclc.org',
    );
    expect(cookies.map((c) => c.name)).toEqual(['ezproxy', 'site']);
  });

  it('detects PDFs and stamp frames', () => {
    expect(isPdf(pdf)).toBe(true);
    expect(isPdf(new TextEncoder().encode('<html>'))).toBe(false);
    const frame = embeddedPdfUrl(
      '<iframe src="/stampPDF/getPDF.jsp?tp=&amp;arnumber=1"></iframe>',
      new URL(ORIGIN),
    );
    expect(frame?.toString()).toBe(`${ORIGIN}/stampPDF/getPDF.jsp?tp=&arnumber=1`);
    expect(embeddedPdfUrl('<iframe src="/ads"></iframe>', new URL(ORIGIN))).toBeUndefined();
  });

  it('reports a missing configured browser', () => {
    expect(findBrowser('/nonexistent/chrome')).toBeUndefined();
  });
});

describe('ProxyClient.fetchPdf', () => {
  it('downloads through redirects with cookies and saves refreshed cookies', async () => {
    const { client, fetch, sessions } = await setup([
      {
        match: '/stampPDF/getPDF.jsp',
        times: 1,
        respond: () =>
          redirect(
            `${ORIGIN}/ielx7/5/771073.pdf`,
            'ezproxyn=fresh; Domain=tudelft.idm.oclc.org; Path=/; Secure',
          ),
      },
      { match: '/ielx7/5/771073.pdf', respond: pdfResponse },
    ]);
    const bytes = await client.fetchPdf('771073');
    expect(isPdf(bytes)).toBe(true);
    const second = fetch.calls[1]!.init!.headers as Record<string, string>;
    expect(second.Cookie).toContain('ezproxy=session-1');
    expect(second.Cookie).toContain('ezproxyn=fresh');
    expect(second['User-Agent']).toBe('Mozilla/5.0 Test');
    expect(fetch.calls[0]!.init!.redirect).toBe('manual');
    expect((await sessions.load())!.cookies.map((c) => c.name).sort()).toEqual(['ezproxy', 'ezproxyn']);
  });

  it('follows the stamp page frame', async () => {
    const { client } = await setup([
      {
        match: 'getPDF.jsp?tp=&arnumber=9',
        times: 1,
        respond: () =>
          textResponse(
            '<html><iframe src="/stampPDF/getPDF.jsp?tp=&amp;arnumber=9&amp;inner=1"></iframe></html>',
          ),
      },
      { match: 'inner=1', respond: pdfResponse },
    ]);
    expect(isPdf(await client.fetchPdf('9'))).toBe(true);
  });

  it('treats a login redirect as an expired session and renews once', async () => {
    let renewals = 0;
    const { client, sessions } = await setup(
      [
        {
          match: 'getPDF.jsp',
          times: 1,
          respond: () => redirect('https://login.tudelft.idm.oclc.org/login?qurl=x'),
        },
        { match: 'getPDF.jsp', respond: pdfResponse },
      ],
      {
        renew: async () => {
          renewals++;
          await sessions.save({
            origin: ORIGIN,
            cookies: [{ ...ezproxy, value: 'renewed' }],
            savedAt: 'now',
          });
          return { ok: true };
        },
      },
    );
    expect(isPdf(await client.fetchPdf('771073'))).toBe(true);
    expect(renewals).toBe(1);
  });

  it('asks for sign-in when renewal fails', async () => {
    const { client } = await setup(
      [{ match: 'getPDF.jsp', respond: () => redirect('https://login.microsoftonline.com/saml') }],
      { renew: async () => ({ ok: false, reason: 'No Chrome was found.' }) },
    );
    const error = await client.fetchPdf('771073').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthRequired);
    expect((error as Error).message).toContain('Silent renewal failed: No Chrome was found.');
  });

  it('asks for sign-in when there is no session', async () => {
    const { client, fetch } = await setup([], { signedIn: false });
    await expect(client.fetchPdf('771073')).rejects.toBeInstanceOf(AuthRequired);
    expect(fetch.calls).toHaveLength(0);
  });

  it('reports a non-licensed paper', async () => {
    const { client } = await setup([
      { match: 'getPDF.jsp', respond: () => textResponse('<html>Purchase this article</html>') },
    ]);
    await expect(client.fetchPdf('1')).rejects.toMatchObject({ code: 'NO_FULL_TEXT' });
  });

  it('spaces downloads and enforces the daily cap', async () => {
    const { client, sleeps, usage } = await setup([{ match: 'getPDF.jsp', respond: pdfResponse }], {
      limit: '2',
    });
    await client.fetchPdf('1');
    await client.fetchPdf('2');
    expect(sleeps).toEqual([10_000]);
    await expect(client.fetchPdf('3')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect((await usage.load())!.count).toBe(2);
  });
});

describe('ProxyClient.status', () => {
  it('checks the session live', async () => {
    const { client } = await setup([
      { match: '/Xplore/home.jsp', respond: () => textResponse('<html>home</html>') },
    ]);
    expect(await client.status(true)).toMatchObject({
      configured: true,
      signedIn: true,
      valid: true,
      downloadsToday: 0,
    });
  });

  it('reports an expired session', async () => {
    const { client } = await setup([
      { match: '/Xplore/home.jsp', respond: () => redirect('https://login.tudelft.idm.oclc.org/login') },
    ]);
    expect((await client.status(true)).valid).toBe(false);
  });

  it('ignores a session saved for another proxy', async () => {
    const { client, sessions } = await setup([]);
    await sessions.save({
      origin: 'https://other.example.edu',
      cookies: [],
      savedAt: 'x',
    } satisfies ProxySession);
    expect((await client.status(false)).signedIn).toBe(false);
  });
});

describe('ProxyClient hardening', () => {
  it('shares the daily cap between server processes', async () => {
    const { client, config, sessions, usage } = await setup([{ match: 'getPDF.jsp', respond: pdfResponse }], {
      limit: '2',
    });
    const fetch = mockFetch([{ match: 'getPDF.jsp', respond: pdfResponse }]);
    const other = new ProxyClient(config, sessions, usage, { fetch, sleep: async () => undefined });
    const results = await Promise.allSettled([
      client.fetchPdf('1'),
      other.fetchPdf('2'),
      other.fetchPdf('3'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await usage.load())!.count).toBe(2);
  });

  it('fails closed when the usage file is damaged', async () => {
    const { client, config, fetch } = await setup([{ match: 'getPDF.jsp', respond: pdfResponse }]);
    await writeFile(config.stateFile, '{ not json');
    await expect(client.fetchPdf('1')).rejects.toThrow(/damaged/);
    expect(fetch.calls).toHaveLength(0);
  });

  it('does not overwrite a newer sign-in with stale cookies', async () => {
    const { client, sessions } = await setup([
      {
        match: 'getPDF.jsp',
        respond: async () => {
          await sessions.save({
            origin: ORIGIN,
            cookies: [{ ...ezproxy, value: 'fresh-login' }],
            savedAt: 'newer',
          });
          return new Response(pdf, {
            status: 200,
            headers: {
              'content-type': 'application/pdf',
              'set-cookie': 'ezproxy=rotated; Domain=tudelft.idm.oclc.org; Path=/',
            },
          });
        },
      },
    ]);
    await client.fetchPdf('1');
    const saved = (await sessions.load())!;
    expect(saved.savedAt).toBe('newer');
    expect(saved.cookies[0]!.value).toBe('fresh-login');
  });

  it('refuses insecure hops and off-proxy frames without renewing', async () => {
    let renewals = 0;
    const renew = async (): Promise<RenewResult> => {
      renewals++;
      return { ok: true };
    };
    const insecure = await setup(
      [
        {
          match: 'getPDF.jsp',
          respond: () => redirect('http://ieeexplore-ieee-org.tudelft.idm.oclc.org/x.pdf'),
        },
      ],
      { renew },
    );
    await expect(insecure.client.fetchPdf('1')).rejects.toThrow(/insecure/);
    const offProxy = await setup(
      [
        {
          match: 'getPDF.jsp',
          respond: () =>
            textResponse(
              '<iframe src="https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?arnumber=1"></iframe>',
            ),
        },
      ],
      { renew },
    );
    await expect(offProxy.client.fetchPdf('1')).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect(renewals).toBe(0);
  });

  it('recognises a block page', async () => {
    const { client } = await setup([
      {
        match: 'getPDF.jsp',
        respond: () =>
          textResponse('<html><title>Request Rejected</title>Please complete the CAPTCHA</html>'),
      },
    ]);
    await expect(client.fetchPdf('1')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('reports an unreachable proxy in the status check instead of failing', async () => {
    const { client } = await setup([
      {
        match: '/Xplore/home.jsp',
        respond: () => {
          throw new TypeError('fetch failed');
        },
      },
    ]);
    const status = await client.status(true);
    expect(status.valid).toBeUndefined();
    expect(status.checkError).toMatch(/connection/);
  });
});
