import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractPdf, tidy } from '../src/fulltext/extract.js';
import { cacheKey, chunk, citationPdfUrl, FullText, titleMatches } from '../src/fulltext/fetcher.js';
import { HttpClient } from '../src/http.js';
import type { Config } from '../src/config.js';
import { ProxyClient } from '../src/proxy/client.js';
import { SessionStore, UsageStore } from '../src/proxy/session.js';
import { fixtureBytes, mockFetch, testConfig, textResponse, type Route } from './helpers.js';

const pdf = fixtureBytes('sample.pdf');
const pdfResponse = () => new Response(pdf, { status: 200, headers: { 'content-type': 'application/pdf' } });

function setup(routes: Route[], env: Record<string, string> = {}) {
  const config = testConfig(env);
  const fetch = mockFetch(routes);
  const http = new HttpClient({ fetch, timeoutMs: 1000 });
  const proxy = new ProxyClient(
    config,
    new SessionStore(config.sessionFile),
    new UsageStore(config.stateFile),
    {
      fetch,
      sleep: async () => undefined,
    },
  );
  return { config, fetch, fulltext: new FullText(config, http, proxy) };
}

describe('extractPdf', () => {
  it('extracts text page by page in a worker', async () => {
    const result = await extractPdf(pdf);
    expect(result.pages).toBe(2);
    expect(result.text).toContain('[Page 1]');
    expect(result.text).toContain('A Fixture Paper on Sigma-Delta Modulators');
    expect(result.text).toContain('[Page 2]');
    // Hyphenation across lines is joined and the licence footer removed.
    expect(result.text).toContain('modulator is described');
    expect(result.text).not.toContain('Authorized licensed use');
  });

  it('fails cleanly on damaged input', async () => {
    await expect(extractPdf(new TextEncoder().encode('%PDF-1.4 broken'))).rejects.toMatchObject({
      code: 'DOCUMENT_PARSE_FAILED',
    });
  });
});

describe('tidy', () => {
  it('only joins lower-case hyphenation', () => {
    expect(tidy('sigma-\ndelta and CMOS-\nMEMS')).toBe('sigmadelta and CMOS-\nMEMS');
    expect(tidy('dumb  and   intelligent')).toBe('dumb and intelligent');
  });
});

describe('chunk', () => {
  it('cuts at a line break in the last fifth of the chunk', () => {
    expect(chunk('abcdefghij\nklmnop', 0, 12)).toEqual({ text: 'abcdefghij\n', next: 11 });
  });

  it('cuts hard when the only line break is early', () => {
    expect(chunk('ab\ncdefghijklmnopq', 0, 14)).toEqual({ text: 'ab\ncdefghijklm', next: 14 });
  });

  it('returns the rest without a next offset', () => {
    expect(chunk('line one\nline two\n', 9, 100)).toEqual({ text: 'line two\n' });
    expect(chunk('short', 99, 10)).toEqual({ text: '' });
  });
});

describe('titleMatches', () => {
  const text = '[Page 1]\nA Fixture Paper on Sigma-Delta Modulators\nAbstract: ...';
  it('accepts the right document', () => {
    expect(titleMatches('A Fixture Paper on Sigma-Delta Modulators', text)).toBe(true);
    expect(titleMatches('Fixture paper: sigma–delta modulators revisited', text)).toBe(true);
  });

  it('rejects a different document', () => {
    expect(titleMatches('Toward unique identifiers', text)).toBe(false);
  });
});

describe('cacheKey', () => {
  it('prefers the article number and sanitises DOIs', () => {
    expect(cacheKey({ articleNumber: '771073', doi: '10.1109/5.771073', oaPdfUrls: [] })).toBe('ieee-771073');
    expect(cacheKey({ doi: '10.1109/a/b<c>', oaPdfUrls: [] })).toBe('doi-10.1109_a_b_c_');
    expect(() => cacheKey({ oaPdfUrls: [] })).toThrow(/neither/);
  });
});

describe('FullText', () => {
  it('downloads an open-access copy, skipping links that are not PDFs', async () => {
    const { fulltext, config } = setup([
      { match: 'repo.example.edu', respond: () => textResponse('<html>landing page</html>') },
      { match: 'arxiv.org', respond: pdfResponse },
    ]);
    const file = await fulltext.pdf({
      articleNumber: '1',
      oaPdfUrls: ['https://repo.example.edu/paper', 'https://arxiv.org/pdf/1'],
    });
    expect(file.origin).toBe('open-access');
    expect(file.url).toBe('https://arxiv.org/pdf/1');
    expect(existsSync(join(config.cacheDir, 'ieee-1.pdf'))).toBe(true);
  });

  it('rejects open-access copies that are a different paper', async () => {
    const { fulltext, config } = setup([{ match: 'arxiv.org', respond: pdfResponse }]);
    await expect(
      fulltext.pdf({
        articleNumber: '5',
        title: 'Toward unique identifiers',
        oaPdfUrls: ['https://arxiv.org/pdf/5'],
      }),
    ).rejects.toThrow(/different documents/);
    expect(existsSync(join(config.cacheDir, 'ieee-5.pdf'))).toBe(false);
  });

  it('keeps the text extracted during verification', async () => {
    const { fulltext } = setup([{ match: 'arxiv.org', respond: pdfResponse }]);
    const text = await fulltext.text({
      articleNumber: '6',
      title: 'A Fixture Paper on Sigma-Delta Modulators',
      oaPdfUrls: ['https://arxiv.org/pdf/6'],
    });
    expect(text.origin).toBe('open-access');
    expect(text.url).toBe('https://arxiv.org/pdf/6');
    expect(text.pages).toBe(2);
  });

  it('serves the cache without network access', async () => {
    const { fulltext, config, fetch } = setup([]);
    await mkdir(config.cacheDir, { recursive: true });
    await writeFile(join(config.cacheDir, 'ieee-2.pdf'), pdf);
    const text = await fulltext.text({ articleNumber: '2', oaPdfUrls: ['https://arxiv.org/pdf/2'] });
    expect(text.origin).toBe('cache');
    expect(text.text).toContain('Sigma-Delta');
    expect(fetch.calls).toHaveLength(0);
    // Extracted text is cached too.
    expect((await fulltext.text({ articleNumber: '2', oaPdfUrls: [] })).origin).toBe('cache');
  });

  it('explains how to get paywalled text without a proxy', async () => {
    const { fulltext } = setup([]);
    await expect(fulltext.pdf({ articleNumber: '3', oaPdfUrls: [] })).rejects.toThrow(/IEEE_PROXY_URL/);
  });

  it('asks for sign-in when the proxy has no session', async () => {
    const { fulltext } = setup([], { IEEE_PROXY_URL: 'https://ieeexplore-ieee-org.tudelft.idm.oclc.org' });
    await expect(fulltext.pdf({ articleNumber: '4', oaPdfUrls: [] })).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
  });

  it('needs an article number for the proxy', async () => {
    const { fulltext } = setup([], { IEEE_PROXY_URL: 'https://ieeexplore-ieee-org.tudelft.idm.oclc.org' });
    await expect(fulltext.pdf({ doi: '10.1109/x', oaPdfUrls: [] })).rejects.toThrow(/no IEEE article number/);
  });
});

describe('citationPdfUrl', () => {
  it('reads the Google Scholar meta tag in either attribute order and resolves it', () => {
    const base = new URL('https://repository.tudelft.nl/record/uuid:1');
    expect(citationPdfUrl('<meta name="citation_pdf_url" content="/file/F_1" />', base)).toBe(
      'https://repository.tudelft.nl/file/F_1',
    );
    expect(citationPdfUrl("<meta content='https://x.org/a.pdf' name='citation_pdf_url'>", base)).toBe(
      'https://x.org/a.pdf',
    );
    expect(citationPdfUrl('<meta name="citation_title" content="x">', base)).toBeUndefined();
    expect(
      citationPdfUrl('<meta name="citation_pdf_url" content="javascript:alert(1)">', base),
    ).toBeUndefined();
  });
});

describe('FullText landing pages', () => {
  const landing = () =>
    new Response('<html><head><meta name="citation_pdf_url" content="/file/F_1"></head></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });

  it('follows a repository landing page to its PDF before using the proxy', async () => {
    const { fulltext, fetch } = setup(
      [
        { match: 'repository.example.edu/record', respond: landing },
        { match: 'repository.example.edu/file/F_1', respond: pdfResponse },
      ],
      { IEEE_PROXY_URL: 'https://ieeexplore-ieee-org.tudelft.idm.oclc.org' },
    );
    const file = await fulltext.pdf({
      articleNumber: '12',
      title: 'A Fixture Paper on Sigma-Delta Modulators',
      oaPdfUrls: [],
      oaLandingUrls: ['https://repository.example.edu/record/1'],
    });
    expect(file.origin).toBe('open-access');
    expect(file.url).toBe('https://repository.example.edu/file/F_1');
    expect(fetch.calls.map((c) => new URL(c.url).host)).not.toContain(
      'ieeexplore-ieee-org.tudelft.idm.oclc.org',
    );
  });

  it('reports landing pages without a PDF link among the tried copies', async () => {
    const { fulltext } = setup([
      { match: 'repository.example.edu/record', respond: () => textResponse('<html>no meta</html>') },
    ]);
    await expect(
      fulltext.pdf({
        articleNumber: '13',
        oaPdfUrls: [],
        oaLandingUrls: ['https://repository.example.edu/record/2'],
      }),
    ).rejects.toThrow(/repository\.example\.edu: no PDF link on the page/);
  });
});

describe('FullText hardening', () => {
  it('skips invalid links and explains every failed copy', async () => {
    const { fulltext } = setup([{ match: 'repo.example.edu', respond: () => textResponse('gone', 500) }]);
    const error = await fulltext
      .pdf({ articleNumber: '7', oaPdfUrls: ['www.example.org/paper.pdf', 'https://repo.example.edu/p.pdf'] })
      .catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/an invalid link; repo\.example\.edu: HTTP 500/);
  });

  it('rethrows unexpected errors instead of moving on to the proxy', async () => {
    const config = testConfig({ IEEE_PROXY_URL: 'https://ieeexplore-ieee-org.tudelft.idm.oclc.org' });
    const http = {
      getBytes: async () => {
        throw new TypeError('bug');
      },
    } as unknown as HttpClient;
    const proxy = new ProxyClient(
      config,
      new SessionStore(config.sessionFile),
      new UsageStore(config.stateFile),
    );
    const fulltext = new FullText(config, http, proxy);
    await expect(
      fulltext.pdf({ articleNumber: '8', oaPdfUrls: ['https://arxiv.org/pdf/8'] }),
    ).rejects.toThrow('bug');
  });

  it('returns a good copy even when the cache cannot be written', async () => {
    const base = testConfig();
    await writeFile(join(base.home, 'not-a-dir'), 'x');
    const config: Config = { ...base, cacheDir: join(base.home, 'not-a-dir', 'cache') };
    const fetch = mockFetch([{ match: 'arxiv.org', respond: pdfResponse }]);
    const proxy = new ProxyClient(
      config,
      new SessionStore(config.sessionFile),
      new UsageStore(config.stateFile),
    );
    const fulltext = new FullText(config, new HttpClient({ fetch, timeoutMs: 1000 }), proxy);
    const text = await fulltext.text({ articleNumber: '9', oaPdfUrls: ['https://arxiv.org/pdf/9'] });
    expect(text.pages).toBe(2);
    expect(text.warnings.join(' ')).toMatch(/cache could not be written/);
  });

  it('shares one download between concurrent requests for the same paper', async () => {
    const { fulltext, fetch } = setup([{ match: 'arxiv.org', respond: pdfResponse }]);
    const ref = { articleNumber: '10', oaPdfUrls: ['https://arxiv.org/pdf/10'] };
    await Promise.all([fulltext.pdf(ref), fulltext.text(ref)]);
    expect(fetch.calls).toHaveLength(1);
  });

  it('remembers where cached text came from', async () => {
    const { fulltext } = setup([{ match: 'arxiv.org', respond: pdfResponse }]);
    const ref = { articleNumber: '11', oaPdfUrls: ['https://arxiv.org/pdf/11'] };
    await fulltext.text(ref);
    const again = await fulltext.text(ref);
    expect(again).toMatchObject({ origin: 'cache', source: 'open-access', url: 'https://arxiv.org/pdf/11' });
  });
});
