/**
 * Live checks against the real services. Run with `npm run test:live`.
 * OPENALEX_API_KEY makes search reliable; IEEE_API_KEY and a signed-in IEEE_PROXY_URL are
 * exercised when present.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createContext } from '../../src/context.js';

const config = loadConfig();
const ctx = createContext(config);
const DOI = '10.1109/5.771073';

describe('live: keyless sources', () => {
  it('resolves a DOI with OpenAlex and the handle API', async () => {
    const { paper, work } = await ctx.library.resolve(DOI);
    expect(paper.title).toBe('Toward unique identifiers');
    expect(paper.articleNumber).toBe('771073');
    expect(work?.referenced_works?.length).toBeGreaterThan(0);
  });

  it('formats BibTeX through DOI content negotiation', async () => {
    const [result] = await ctx.library.cite([DOI], 'bibtex');
    expect(result!.citation).toMatch(/^@article\{/);
  });

  it('lists citing papers', async () => {
    const { page } = await ctx.library.citing(DOI, { sort: 'citations', limit: 3, page: 1 });
    expect(page.papers.length).toBeGreaterThan(0);
  });
});

describe.runIf(config.openAlexApiKey)('live: OpenAlex search', () => {
  it('finds IEEE papers by keyword, author and venue', async () => {
    const page = await ctx.library.search({
      query: 'temperature sensor',
      author: 'Kofi Makinwa',
      sort: 'citations',
      limit: 5,
      page: 1,
    });
    expect(page.source).toBe('openalex');
    expect(page.papers.length).toBeGreaterThan(0);
  });

  it('runs semantic search', async () => {
    const page = await ctx.library.search({
      query: 'a very low power CMOS temperature sensor with high accuracy',
      semantic: true,
      sort: 'relevance',
      limit: 5,
      page: 1,
    });
    expect(page.papers.length).toBeGreaterThan(0);
  });
});

describe.runIf(config.ieeeApiKey)('live: IEEE API', () => {
  it('reports whether the key works', async () => {
    const result = await ctx.library.ieee!.verify();
    console.log('IEEE key:', result);
    expect(typeof result.ok).toBe('boolean');
  });
});

describe.runIf(config.proxyOrigin)('live: institutional proxy', () => {
  it('reports the session state', async () => {
    const status = await ctx.proxy.status(true);
    console.log('proxy:', status);
    expect(status.configured).toBe(true);
  });
});
