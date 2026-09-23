import { describe, expect, it } from 'vitest';
import { HttpClient } from '../src/http.js';
import { Library, mergePapers } from '../src/library.js';
import { DoiClient } from '../src/sources/doi.js';
import { IeeeClient, mapIeeeArticle, type IeeeArticle } from '../src/sources/ieee.js';
import { mapWork, OpenAlexClient, type OaWork } from '../src/sources/openalex.js';
import type { SearchQuery } from '../src/types.js';
import { fixtureJson, jsonResponse, mockFetch, noSleep, textResponse, type Route } from './helpers.js';

const work = fixtureJson<OaWork>('openalex-work.json');
const ieeeFixture = fixtureJson<{ total_records: number; articles: IeeeArticle[] }>('ieee-search.json');
const handle = fixtureJson('handle.json');
const base: SearchQuery = { sort: 'relevance', limit: 10, page: 1 };

const openAlexList: Route = {
  match: 'api.openalex.org/works?',
  respond: () => jsonResponse({ meta: { count: 1 }, results: [work] }),
};
const openAlexWork: Route = { match: 'api.openalex.org/works/', respond: () => jsonResponse(work) };
const handleRoute: Route = { match: 'doi.org/api/handles/', respond: () => jsonResponse(handle) };

function library(routes: Route[], options: { ieeeKey?: string; now?: () => number } = {}) {
  const fetch = mockFetch(routes);
  const http = new HttpClient({ fetch, timeoutMs: 1000, sleep: noSleep, maxRetryWaitMs: 0 });
  const lib = new Library(
    new OpenAlexClient(http, 'oa', undefined),
    new DoiClient(http),
    options.ieeeKey ? new IeeeClient(http, options.ieeeKey) : undefined,
    options.now,
  );
  return { fetch, lib };
}

const ieeeCalls = (fetch: ReturnType<typeof mockFetch>) =>
  fetch.calls.filter((c) => c.url.includes('ieeexploreapi')).length;

describe('Library.search', () => {
  it('uses OpenAlex without an IEEE key', async () => {
    const { lib } = library([openAlexList]);
    const page = await lib.search({ ...base, query: 'identifiers' });
    expect(page.source).toBe('openalex');
    expect(page.notice).toBeUndefined();
  });

  it('prefers the IEEE API when the key works', async () => {
    const { lib } = library([{ match: 'ieeexploreapi', respond: () => jsonResponse(ieeeFixture) }], {
      ieeeKey: 'k',
    });
    const page = await lib.search({ ...base, query: 'identifiers' });
    expect(page.source).toBe('ieee');
    expect(page.total).toBe(1284);
  });

  it('falls back to OpenAlex on an inactive key and stops asking IEEE', async () => {
    const { lib, fetch } = library(
      [
        { match: 'ieeexploreapi', respond: () => textResponse('<h1>Developer Inactive</h1>', 403) },
        openAlexList,
      ],
      { ieeeKey: 'k' },
    );
    const first = await lib.search({ ...base, query: 'one' });
    expect(first.source).toBe('openalex');
    expect(first.notice).toMatch(/IEEE API unavailable \(Developer Inactive\)/);
    await lib.search({ ...base, query: 'two' });
    expect(ieeeCalls(fetch)).toBe(1);
    expect(lib.ieeeStatus()).toEqual({ configured: true, active: false, reason: 'Developer Inactive' });
  });

  it('retries IEEE after the daily quota resets', async () => {
    let now = Date.UTC(2026, 8, 23, 22, 0);
    const { lib, fetch } = library(
      [
        {
          match: 'ieeexploreapi',
          times: 1,
          respond: () => textResponse('<h1>Account Over Queries Per Day Limit</h1>', 403),
        },
        { match: 'ieeexploreapi', respond: () => jsonResponse(ieeeFixture) },
        openAlexList,
      ],
      { ieeeKey: 'k', now: () => now },
    );
    expect((await lib.search({ ...base, query: 'a' })).source).toBe('openalex');
    expect((await lib.search({ ...base, query: 'b' })).source).toBe('openalex');
    now = Date.UTC(2026, 8, 24, 0, 1);
    expect((await lib.search({ ...base, query: 'c' })).source).toBe('ieee');
    expect(ieeeCalls(fetch)).toBe(2);
  });

  it('falls back on a transient IEEE failure without disabling it', async () => {
    const { lib } = library(
      [{ match: 'ieeexploreapi', respond: () => textResponse('down', 503) }, openAlexList],
      { ieeeKey: 'k' },
    );
    const page = await lib.search({ ...base, query: 'x' });
    expect(page.source).toBe('openalex');
    expect(page.notice).toMatch(/IEEE API failed/);
    expect(lib.ieeeStatus().active).toBe(true);
  });

  it('routes citation sorting to OpenAlex and says so', async () => {
    const { lib, fetch } = library([openAlexList], { ieeeKey: 'k' });
    const page = await lib.search({ ...base, query: 'x', sort: 'citations' });
    expect(page.source).toBe('openalex');
    expect(page.notice).toMatch(/Sorting by citations runs on OpenAlex/);
    expect(ieeeCalls(fetch)).toBe(0);
  });

  it('rejects empty searches', async () => {
    const { lib } = library([]);
    await expect(lib.search(base)).rejects.toThrow(/at least one of/);
    await expect(lib.search({ ...base, author: 'x', semantic: true })).rejects.toThrow(/needs a query/);
  });
});

describe('Library.resolve', () => {
  it('resolves a DOI through OpenAlex and adds the article number from the handle', async () => {
    const { lib } = library([openAlexWork, handleRoute]);
    const { paper, work: record } = await lib.resolve('https://doi.org/10.1109/5.771073');
    expect(paper.articleNumber).toBe('771073');
    expect(paper.openAlexId).toBe('W2156186462');
    expect(record?.referenced_works?.length).toBeGreaterThan(0);
  });

  it('merges IEEE metadata when a key works', async () => {
    const { lib } = library(
      [
        openAlexWork,
        {
          match: 'ieeexploreapi',
          respond: () => jsonResponse({ total_records: 1, articles: [ieeeFixture.articles[0]] }),
        },
      ],
      { ieeeKey: 'k' },
    );
    const { paper } = await lib.resolve('10.1109/5.771073');
    expect(paper.source).toBe('ieee');
    expect(paper.articleNumber).toBe('771073');
    expect(paper.patentCitations).toBe(4);
    expect(paper.openAlexId).toBe('W2156186462');
  });

  it('asks for a DOI when an article number cannot be resolved', async () => {
    const { lib } = library([]);
    await expect(lib.resolve('771073')).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });

  it('reports unknown papers', async () => {
    const { lib } = library([{ match: 'api.openalex.org/works/', respond: () => textResponse('', 404) }]);
    await expect(lib.resolve('10.1109/nothing.here')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('citation graph', () => {
  it('pages through references in stored order', async () => {
    const refs = work.referenced_works!.map((url) => url.slice(url.lastIndexOf('/') + 1));
    const { lib, fetch } = library([
      openAlexWork,
      handleRoute,
      {
        match: 'ids.openalex',
        respond: (url) => {
          const ids = new URLSearchParams(url.search).get('filter')!.replace('ids.openalex:', '').split('|');
          return jsonResponse({ results: ids.map((id) => ({ ...work, id: `https://openalex.org/${id}` })) });
        },
      },
    ]);
    const { page } = await lib.references('10.1109/5.771073', { limit: 5, page: 2 });
    expect(page.total).toBe(refs.length);
    expect(page.papers.map((p) => p.openAlexId)).toEqual(refs.slice(5, 10));
    expect(fetch.calls.some((c) => c.url.includes('ids.openalex'))).toBe(true);
  });

  it('filters citing works to IEEE on request', async () => {
    const { lib, fetch } = library([openAlexWork, handleRoute, openAlexList]);
    await lib.citing('W2156186462', { sort: 'citations', limit: 5, page: 1, ieeeOnly: true });
    const call = fetch.calls.find((c) => c.url.includes('cites'))!;
    expect(decodeURIComponent(call.url)).toContain(
      'cites:W2156186462,primary_location.source.host_organization:P4310319808',
    );
  });
});

describe('Library.cite', () => {
  it('reports failures per paper', async () => {
    const { lib } = library([
      {
        match: 'doi.org/10.1109/5.771073',
        respond: () => textResponse('@article{Paskin_1999, title={Toward unique identifiers}}'),
      },
    ]);
    const results = await lib.cite(['10.1109/5.771073', '771073'], 'bibtex');
    expect(results[0]!.citation).toMatch(/^@article\{Paskin_1999/);
    expect(results[1]!.error).toMatch(/IEEE_API_KEY/);
  });
});

describe('mergePapers', () => {
  it('keeps IEEE fields and fills gaps from OpenAlex', () => {
    const ieee = mapIeeeArticle({ ...ieeeFixture.articles[0]!, abstract: undefined });
    const merged = mergePapers(ieee, mapWork(work));
    expect(merged.source).toBe('ieee');
    expect(merged.citedBy).toBe(118);
    expect(merged.abstract).toBeDefined();
    expect(merged.openAlexId).toBe('W2156186462');
  });

  it('keeps the OpenAlex author list when IEEE has none', () => {
    const ieee = mapIeeeArticle({ ...ieeeFixture.articles[0]!, authors: { authors: [] } });
    expect(mergePapers(ieee, mapWork(work)).authors[0]!.name).toBe('Norman Paskin');
  });
});

describe('Library transient failures', () => {
  it('keeps the paper and warns when the article number lookup fails', async () => {
    const { lib } = library([
      openAlexWork,
      { match: 'doi.org/api/handles/', respond: () => textResponse('down', 503) },
    ]);
    const resolved = await lib.resolve('10.1109/5.771073');
    expect(resolved.paper.articleNumber).toBeUndefined();
    expect(resolved.warnings.join(' ')).toMatch(/could not be looked up at doi\.org/);
  });

  it('reports an IEEE timeout instead of NOT_FOUND', async () => {
    const { lib } = library(
      [
        { match: 'api.openalex.org/works/', respond: () => textResponse('', 404) },
        { match: 'ieeexploreapi', respond: () => textResponse('down', 503) },
      ],
      { ieeeKey: 'k' },
    );
    await expect(lib.resolve('10.1109/x.1')).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });

  it('says OpenAlex is unreachable rather than that it has no data', async () => {
    const { lib } = library(
      [
        {
          match: 'ieeexploreapi',
          respond: () => jsonResponse({ total_records: 1, articles: [ieeeFixture.articles[0]] }),
        },
        { match: 'api.openalex.org/works/', respond: () => textResponse('busy', 429) },
      ],
      { ieeeKey: 'k' },
    );
    await expect(lib.citing('771073', { sort: 'citations', limit: 5, page: 1 })).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
      message: expect.stringMatching(/OpenAlex could not be reached/),
    });
  });
});
