import { describe, expect, it } from 'vitest';
import { HttpClient, HttpError } from '../src/http.js';
import {
  buildIeeeParams,
  classifyIeeeFailure,
  IeeeAccountError,
  IeeeClient,
  ieeeSupports,
  mapIeeeArticle,
  type IeeeArticle,
} from '../src/sources/ieee.js';
import type { SearchQuery } from '../src/types.js';
import { fixtureJson, jsonResponse, mockFetch, noSleep, textResponse } from './helpers.js';

const base: SearchQuery = { sort: 'relevance', limit: 10, page: 1 };
const fixture = fixtureJson<{ total_records: number; articles: IeeeArticle[] }>('ieee-search.json');

describe('buildIeeeParams', () => {
  it('maps every filter to the IEEE parameter', () => {
    const params = buildIeeeParams({
      ...base,
      query: 'sigma delta',
      title: 'modulator',
      author: 'Makinwa',
      affiliation: 'Delft',
      venue: 'JSSC',
      keywords: 'ADC',
      yearFrom: 2018,
      yearTo: 2024,
      contentType: 'early_access',
      openAccessOnly: true,
      sort: 'newest',
      limit: 25,
      page: 3,
    });
    expect(Object.fromEntries(params)).toEqual({
      querytext: 'sigma delta',
      article_title: 'modulator',
      author: 'Makinwa',
      affiliation: 'Delft',
      publication_title: 'JSSC',
      index_terms: 'ADC',
      start_year: '2018',
      end_year: '2024',
      content_type: 'Early Access',
      open_access: 'True',
      sort_field: 'publication_year',
      sort_order: 'desc',
      max_records: '25',
      start_record: '51',
    });
  });

  it('leaves semantic search and citation sorting to OpenAlex', () => {
    expect(ieeeSupports(base)).toBe(true);
    expect(ieeeSupports({ ...base, sort: 'citations' })).toBe(false);
    expect(ieeeSupports({ ...base, semantic: true })).toBe(false);
  });
});

describe('mapIeeeArticle', () => {
  it('maps a journal article', () => {
    const paper = mapIeeeArticle(fixture.articles[0]!);
    expect(paper).toMatchObject({
      source: 'ieee',
      title: 'Toward unique identifiers',
      doi: '10.1109/5.771073',
      articleNumber: '771073',
      venue: 'Proceedings of the IEEE',
      year: 1999,
      volume: '87',
      issue: '7',
      pages: '1208-1227',
      citedBy: 118,
      patentCitations: 4,
      isOpenAccess: false,
      authors: [{ name: 'N. Paskin', affiliations: ['International DOI Foundation, Kidlington, UK'] }],
    });
    expect(paper.keywords).toEqual(['digital object identifier', 'Identity management systems', 'Internet']);
  });

  it('orders authors and reads conference details', () => {
    const paper = mapIeeeArticle(fixture.articles[1]!);
    expect(paper.authors.map((a) => a.name)).toEqual(['A. First', 'B. Second']);
    expect(paper.conference).toEqual({ location: 'San Francisco, CA, USA', dates: '16-20 Feb. 2020' });
    expect(paper.isOpenAccess).toBe(true);
    expect(paper.year).toBe(2020);
  });
});

describe('classifyIeeeFailure', () => {
  it('recognises an inactive key', () => {
    const error = classifyIeeeFailure(new HttpError(403, '<h1>Developer Inactive</h1>'))!;
    expect(error).toBeInstanceOf(IeeeAccountError);
    expect(error.reason).toBe('Developer Inactive');
    expect(error.quota).toBe(false);
    expect(error.code).toBe('IEEE_KEY_INVALID');
  });

  it('recognises an exhausted quota', () => {
    const error = classifyIeeeFailure(new HttpError(403, '<h1>Account Over Queries Per Day Limit</h1>'))!;
    expect(error.quota).toBe(true);
  });

  it('never repeats unknown gateway text', () => {
    const error = classifyIeeeFailure(new HttpError(403, 'Forbidden for key SECRET123'))!;
    expect(error.reason).toBe('HTTP 403');
    expect(error.message).not.toContain('SECRET123');
  });

  it('ignores other statuses', () => {
    expect(classifyIeeeFailure(new HttpError(500, 'oops'))).toBeUndefined();
  });
});

describe('IeeeClient', () => {
  it('searches and never puts the key in errors', async () => {
    const fetch = mockFetch([
      { match: 'querytext=first', respond: () => jsonResponse(fixture) },
      { match: 'querytext=second', respond: () => textResponse('<h1>Developer Inactive</h1>', 403) },
    ]);
    const client = new IeeeClient(new HttpClient({ fetch, timeoutMs: 1000, sleep: noSleep }), 'SECRET-KEY');
    const page = await client.search({ ...base, query: 'first' });
    expect(page.total).toBe(1284);
    expect(page.papers).toHaveLength(2);
    expect(fetch.calls[0]!.url).toContain('apikey=SECRET-KEY');
    const error = await client.search({ ...base, query: 'second' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IeeeAccountError);
    expect(String((error as Error).message)).not.toContain('SECRET-KEY');
  });

  it('verify reports a rejected key', async () => {
    const fetch = mockFetch([
      { match: 'ieeexploreapi', respond: () => textResponse('<h1>Developer Inactive</h1>', 403) },
    ]);
    const client = new IeeeClient(new HttpClient({ fetch, timeoutMs: 1000 }), 'k');
    expect(await client.verify()).toEqual({
      ok: false,
      reason: expect.stringContaining('Developer Inactive'),
    });
  });
});
