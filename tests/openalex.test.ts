import { describe, expect, it } from 'vitest';
import { HttpClient } from '../src/http.js';
import {
  cleanTitle,
  isIeee,
  mapWork,
  matchAuthors,
  OpenAlexClient,
  rebuildAbstract,
  type OaWork,
} from '../src/sources/openalex.js';
import type { SearchQuery } from '../src/types.js';
import { fixtureJson, jsonResponse, mockFetch, noSleep, textResponse } from './helpers.js';

const work = fixtureJson<OaWork>('openalex-work.json');
const authors = fixtureJson<{ results: Parameters<typeof matchAuthors>[1] }>('openalex-authors.json');
const base: SearchQuery = { sort: 'relevance', limit: 10, page: 1 };

function client(routes: Parameters<typeof mockFetch>[0], apiKey?: string) {
  const fetch = mockFetch(routes);
  return {
    fetch,
    openalex: new OpenAlexClient(
      new HttpClient({ fetch, timeoutMs: 1000, sleep: noSleep, maxRetryWaitMs: 0 }),
      apiKey,
      'me@example.org',
    ),
  };
}

describe('rebuildAbstract', () => {
  it('restores word order', () => {
    expect(rebuildAbstract({ world: [1], hello: [0], again: [3], ',': [2] })).toBe('hello world , again');
    expect(rebuildAbstract(null)).toBeUndefined();
  });
});

describe('cleanTitle', () => {
  it('turns TeX fragments into plain text', () => {
    expect(cleanTitle('A Sensor With a FoM of 0.65 pJ $^{\\circ}$ C $^{2}$')).toBe(
      'A Sensor With a FoM of 0.65 pJ°C^2',
    );
    expect(cleanTitle('A 5 $\\mu$W Oscillator at 1 k$\\Omega$')).toBe('A 5 µW Oscillator at 1 kΩ');
    expect(cleanTitle('V$_{DD}$ Scaling')).toBe('V_DD Scaling');
    expect(cleanTitle('Plain   title ')).toBe('Plain title');
    expect(
      cleanTitle(
        'A CMOS smart temperature sensor with a 3/spl sigma/ inaccuracy of /spl plusmn/0.5/spl deg/C',
      ),
    ).toBe('A CMOS smart temperature sensor with a 3σ inaccuracy of ±0.5°C');
    expect(cleanTitle('A 2 $\\mu\\hbox{W}$ 100 nV/rtHz Amplifier')).toBe('A 2 µW 100 nV/rtHz Amplifier');
    expect(cleanTitle('A 0.13 pJ \\cdot K2 Resolution FoM')).toBe('A 0.13 pJ · K2 Resolution FoM');
  });
});

describe('mapWork', () => {
  it('maps a recorded OpenAlex work', () => {
    const paper = mapWork(work);
    expect(paper).toMatchObject({
      source: 'openalex',
      title: 'Toward unique identifiers',
      doi: '10.1109/5.771073',
      openAlexId: 'W2156186462',
      venue: 'Proceedings of the IEEE',
      publisher: 'Institute of Electrical and Electronics Engineers',
      year: 1999,
      volume: '87',
      issue: '7',
      pages: '1208-1227',
      isOpenAccess: true,
      contentType: 'journal article',
    });
    expect(paper.authors[0]).toEqual({
      name: 'Norman Paskin',
      affiliations: ['International DOI Foundation, Kidlington, UK'],
    });
    expect(paper.abstract).toMatch(/\w+ \w+/);
    expect(paper.citedBy).toBeGreaterThan(0);
    expect(isIeee(work)).toBe(true);
  });

  it('keeps repository landing pages without a PDF link, but never IEEE or doi.org pages', () => {
    const paper = mapWork({
      ...work,
      best_oa_location: { is_oa: true, pdf_url: null, landing_page_url: 'http://resolver.tudelft.nl/uuid:1' },
      locations: [
        { is_oa: true, pdf_url: null, landing_page_url: 'http://resolver.tudelft.nl/uuid:1' },
        { is_oa: true, pdf_url: null, landing_page_url: 'https://doi.org/10.1109/x.1' },
        { is_oa: true, pdf_url: null, landing_page_url: 'https://ieeexplore.ieee.org/document/1' },
        { is_oa: false, pdf_url: null, landing_page_url: 'https://closed.example.org/1' },
      ],
    });
    expect(paper.oaPdfUrls).toEqual([]);
    expect(paper.oaLandingUrls).toEqual(['http://resolver.tudelft.nl/uuid:1']);
  });

  it('puts repository PDFs before publisher PDFs', () => {
    const paper = mapWork({
      ...work,
      best_oa_location: { is_oa: true, pdf_url: 'https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=1' },
      locations: [
        { is_oa: true, pdf_url: 'https://arxiv.org/pdf/2101.00001' },
        { is_oa: false, pdf_url: 'https://closed' },
      ],
    });
    expect(paper.oaPdfUrls).toEqual([
      'https://arxiv.org/pdf/2101.00001',
      'https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=1',
    ]);
  });
});

describe('matchAuthors', () => {
  it('keeps every profile carrying all name tokens', () => {
    const matched = matchAuthors('Kofi Makinwa', authors.results);
    expect(matched[0]!.display_name).toBe('Kofi A. A. Makinwa');
    expect(matched.length).toBeGreaterThan(1);
  });

  it('falls back to the top hit when nothing matches exactly', () => {
    expect(matchAuthors('Zebulon Q', authors.results)).toHaveLength(1);
  });
});

describe('OpenAlexClient.plan', () => {
  it('builds keyword filters restricted to IEEE', async () => {
    const { openalex } = client([
      { match: '/authors?', respond: () => jsonResponse(authors) },
      {
        match: '/sources?',
        respond: () =>
          jsonResponse({ results: [{ id: 'https://openalex.org/S1', display_name: 'IEEE JSSC' }] }),
      },
    ]);
    const { params, notices } = await openalex.plan({
      ...base,
      query: '"delta sigma" AND temperature',
      title: 'sensor, low power',
      author: 'Kofi Makinwa',
      affiliation: 'Delft',
      venue: 'Journal of Solid-State Circuits',
      yearFrom: 2015,
      yearTo: 2024,
      contentType: 'conference',
      openAccessOnly: true,
      sort: 'newest',
    });
    const filter = params.get('filter')!;
    // Sorted by date, so the query must match title or abstract rather than anywhere in the full text.
    expect(params.get('search')).toBeNull();
    expect(filter).toContain('title_and_abstract.search:"delta sigma" AND temperature');
    expect(filter).toContain('primary_location.source.host_organization:P4310319808');
    expect(filter).toContain('title.search:sensor low power');
    expect(filter).toContain('raw_affiliation_strings.search:Delft');
    expect(filter).toContain('from_publication_date:2015-01-01');
    expect(filter).toContain('to_publication_date:2024-12-31');
    expect(filter).not.toContain('type');
    expect(filter).toContain('open_access.is_oa:true');
    expect(filter).toMatch(/authorships\.author\.id:A5029302924\|/);
    expect(filter).toContain('primary_location.source.id:S1');
    expect(params.get('sort')).toBe('publication_date:desc');
    expect(notices.join(' ')).toMatch(/Kofi A\. A\. Makinwa.*Delft University of Technology/);
    expect(notices.join(' ')).toMatch(/cannot reliably tell IEEE conference items apart/);
  });

  it('ranks by relevance with the full search, and sorts by citations on title and abstract only', async () => {
    const { openalex } = client([]);
    const relevance = await openalex.plan({ ...base, query: 'chopper stabilized amplifier' });
    expect(relevance.params.get('search')).toBe('chopper stabilized amplifier');
    expect(relevance.params.get('filter')).not.toContain('title_and_abstract');
    const cited = await openalex.plan({ ...base, query: 'chopper stabilized amplifier', sort: 'citations' });
    expect(cited.params.get('search')).toBeNull();
    expect(cited.params.get('filter')).toContain('title_and_abstract.search:chopper stabilized amplifier');
    expect(cited.params.get('sort')).toBe('cited_by_count:desc');
    expect(cited.notices.join(' ')).toMatch(/title or abstract/);
  });

  it('sorts filter-only queries by citations', async () => {
    const { openalex } = client([]);
    const { params } = await openalex.plan({ ...base, title: 'identifiers' });
    expect(params.get('sort')).toBe('cited_by_count:desc');
    expect(params.get('search')).toBeNull();
  });

  it('reports filters OpenAlex cannot apply', async () => {
    const { openalex } = client([]);
    const { notices } = await openalex.plan({ ...base, query: 'x', contentType: 'early_access' });
    expect(notices.join(' ')).toMatch(/early access .*set IEEE_API_KEY/);
    const books = await openalex.plan({ ...base, query: 'x', contentType: 'book' });
    expect(books.params.get('filter')).toContain('type:book|book-chapter');
  });

  it('plans semantic search with supported filters only', async () => {
    const { openalex } = client([]);
    const { params, notices } = await openalex.plan({
      ...base,
      query: 'a very small temperature sensor',
      semantic: true,
      yearFrom: 2018,
      title: 'ignored',
      contentType: 'standard',
    });
    expect(params.get('search.semantic')).toBe('a very small temperature sensor');
    expect(params.get('filter')).toBe('publication_year:>2017,type:standard');
    expect(params.get('per_page')).toBe('50');
    expect(notices.join(' ')).toMatch(/does not support title/);
  });

  it('fails clearly when the venue is unknown', async () => {
    const { openalex } = client([{ match: '/sources?', respond: () => jsonResponse({ results: [] }) }]);
    await expect(openalex.plan({ ...base, venue: 'Nonexistent Journal' })).rejects.toThrow(
      /No IEEE publication/,
    );
  });
});

describe('OpenAlexClient.search', () => {
  it('returns mapped papers and the total', async () => {
    const { openalex, fetch } = client(
      [{ match: '/works?', respond: () => jsonResponse({ meta: { count: 42 }, results: [work] }) }],
      'OA-KEY',
    );
    const page = await openalex.search({ ...base, query: 'identifiers' });
    expect(page.total).toBe(42);
    expect(page.papers[0]!.title).toBe('Toward unique identifiers');
    expect(fetch.calls[0]!.url).toContain('api_key=OA-KEY');
    expect(fetch.calls[0]!.url).not.toContain('mailto=');
  });

  it('keeps only IEEE works from semantic results', async () => {
    const other: OaWork = {
      ...work,
      id: 'https://openalex.org/W1',
      primary_location: { source: { host_organization: 'https://openalex.org/P999' } },
    };
    const { openalex, fetch } = client([
      { match: 'search.semantic', respond: () => jsonResponse({ results: [other, work] }) },
    ]);
    const page = await openalex.search({ ...base, query: 'unique identifiers for content', semantic: true });
    expect(page.total).toBeUndefined();
    expect(page.papers.map((p) => p.openAlexId)).toEqual(['W2156186462']);
    expect(page.hasMore).toBe(false);
    expect(fetch.calls[0]!.url).toContain('mailto=me%40example.org');
  });

  it('explains anonymous rate limits', async () => {
    const { openalex } = client([
      { match: '/works?', respond: () => textResponse('busy', 429, { 'retry-after': '36' }) },
    ]);
    await expect(openalex.search({ ...base, query: 'x' })).rejects.toThrow(/OPENALEX_API_KEY/);
  });

  it('passes on OpenAlex query errors', async () => {
    const { openalex } = client([
      {
        match: '/works?',
        respond: () => jsonResponse({ error: 'Invalid query', message: 'Unbalanced parentheses' }, 400),
      },
    ]);
    await expect(openalex.search({ ...base, query: '(x' })).rejects.toThrow(/Unbalanced parentheses/);
  });
});

describe('OpenAlexClient.work and works', () => {
  it('returns undefined for unknown DOIs and keeps order for batches', async () => {
    const second: OaWork = { ...work, id: 'https://openalex.org/W2' };
    const { openalex } = client([
      { match: '/works/doi%3A10.1109%2Fmissing', respond: () => textResponse('not found', 404) },
      { match: 'ids.openalex', respond: () => jsonResponse({ results: [work, second] }) },
    ]);
    expect(await openalex.work({ doi: '10.1109/missing' })).toBeUndefined();
    const papers = await openalex.works(['W2', 'W404', 'W2156186462']);
    expect(papers.map((p) => p.openAlexId)).toEqual(['W2', 'W2156186462']);
  });
});
