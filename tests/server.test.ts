import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createContext } from '../src/context.js';
import { createServer } from '../src/server.js';
import { checkDownloadDirectory, slug } from '../src/tools.js';
import type { OaWork } from '../src/sources/openalex.js';
import {
  fixtureBytes,
  fixtureJson,
  jsonResponse,
  mockFetch,
  testConfig,
  textResponse,
  type Route,
} from './helpers.js';

const work = fixtureJson<OaWork>('openalex-work.json');
const handle = fixtureJson('handle.json');

let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function connect(routes: Route[], env: Record<string, string> = {}) {
  const config = testConfig(env);
  const fetch = mockFetch(routes);
  const ctx = createContext(config, {
    fetch,
    sleep: async () => undefined,
    signIn: async () => {
      throw new Error('sign-in must not run in tests');
    },
  });
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  return { client, fetch, config };
}

function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as { type: string; text: string }[]).map((c) => c.text).join('\n');
}

describe('MCP server', () => {
  it('lists the tools with annotations and the prompt', async () => {
    const { client } = await connect([]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      'search_papers',
      'get_paper',
      'get_citing_papers',
      'get_references',
      'get_related_papers',
      'read_paper',
      'download_pdf',
      'cite_paper',
      'status',
      'sign_in',
    ]);
    const search = tools.find((t) => t.name === 'search_papers')!;
    expect(search.annotations?.readOnlyHint).toBe(true);
    expect(search.inputSchema.properties).toHaveProperty('semantic');
    expect(tools.find((t) => t.name === 'sign_in')!.annotations?.readOnlyHint).toBe(false);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(['literature_review']);
    expect(client.getInstructions()).toMatch(/search_papers/);
  });

  it('searches through OpenAlex without keys', async () => {
    const { client } = await connect([
      {
        match: 'api.openalex.org/works?',
        respond: () => jsonResponse({ meta: { count: 1234 }, results: [work] }),
      },
    ]);
    const result = await client.callTool({
      name: 'search_papers',
      arguments: { query: 'unique identifiers' },
    });
    expect(result.isError).toBeFalsy();
    const output = text(result);
    expect(output).toMatch(/^IEEE papers: 1,234 total, showing 1-1 \(source: OpenAlex\)/);
    expect(output).toContain('[1] Toward unique identifiers (1999)');
    expect(output).toContain('DOI 10.1109/5.771073 | OpenAlex W2156186462');
    expect(output).toContain('More results: call again with page=2.');
  });

  it('returns stable error codes for bad input', async () => {
    const { client } = await connect([]);
    const empty = await client.callTool({ name: 'search_papers', arguments: {} });
    expect(empty.isError).toBe(true);
    expect(text(empty)).toMatch(/^INVALID_ARGUMENT: /);
    const badId = await client.callTool({ name: 'get_paper', arguments: { id: 'nonsense' } });
    expect(text(badId)).toMatch(/^INVALID_ARGUMENT: Could not read/);
  });

  it('shows paper details with the proxied link', async () => {
    const { client } = await connect(
      [
        { match: 'api.openalex.org/works/', respond: () => jsonResponse(work) },
        { match: 'doi.org/api/handles/', respond: () => jsonResponse(handle) },
      ],
      { IEEE_PROXY_URL: 'https://ieeexplore-ieee-org.tudelft.idm.oclc.org/Xplore/home.jsp' },
    );
    const output = text(await client.callTool({ name: 'get_paper', arguments: { id: '10.1109/5.771073' } }));
    expect(output).toMatch(/^# Toward unique identifiers/);
    expect(output).toContain('Identifiers: DOI 10.1109/5.771073 | IEEE 771073 | OpenAlex W2156186462');
    expect(output).toContain('https://ieeexplore.ieee.org/document/771073');
    expect(output).toContain(
      'https://ieeexplore-ieee-org.tudelft.idm.oclc.org/document/771073 (via your institution)',
    );
    expect(output).toContain('Abstract: ');
    // The recorded OpenAlex abstract for this DOI belongs to another paper.
    expect(output).toContain('may belong to a different record');
  });

  it('reads cached full text in chunks', async () => {
    const { client, config } = await connect([
      {
        match: 'api.openalex.org/works/',
        respond: () => jsonResponse({ ...work, best_oa_location: null, locations: [] }),
      },
      { match: 'doi.org/api/handles/', respond: () => jsonResponse(handle) },
    ]);
    await mkdir(config.cacheDir, { recursive: true });
    await writeFile(join(config.cacheDir, 'ieee-771073.pdf'), fixtureBytes('sample.pdf'));
    const first = text(
      await client.callTool({ name: 'read_paper', arguments: { id: '10.1109/5.771073', max_chars: 2000 } }),
    );
    expect(first).toContain('Full text of "Toward unique identifiers" (1999)');
    expect(first).toContain('Source: local cache. 2 pages');
    expect(first).toContain('A Fixture Paper on Sigma-Delta Modulators');
    expect(first).toContain('End of document.');
    const marker = /between the ([0-9a-f]{12}) markers/.exec(first)![1]!;
    expect(first).toContain(`<<<${marker}\n`);
    expect(first).toContain(`\n${marker}>>>\nEnd of document.`);
  });

  it('saves a PDF from the cache', async () => {
    const { client, config } = await connect([
      { match: 'api.openalex.org/works/', respond: () => jsonResponse(work) },
      { match: 'doi.org/api/handles/', respond: () => jsonResponse(handle) },
    ]);
    await mkdir(config.cacheDir, { recursive: true });
    await writeFile(join(config.cacheDir, 'ieee-771073.pdf'), fixtureBytes('sample.pdf'));
    const output = text(await client.callTool({ name: 'download_pdf', arguments: { id: 'W2156186462' } }));
    expect(output).toContain(
      `Path: ${join(config.downloadDir, 'IEEE-771073-Toward-unique-identifiers.pdf')}`,
    );
    const relative = await client.callTool({
      name: 'download_pdf',
      arguments: { id: 'W2156186462', directory: 'relative/dir' },
    });
    expect(text(relative)).toMatch(/^INVALID_ARGUMENT: directory must be an absolute path/);
    // Saving again reuses the identical file instead of overwriting or duplicating it.
    const again = text(await client.callTool({ name: 'download_pdf', arguments: { id: 'W2156186462' } }));
    expect(again).toMatch(/^Already saved/);
  });

  it('formats BibTeX for several papers', async () => {
    const { client } = await connect([
      {
        match: 'doi.org/10.1109/5.771073',
        respond: () => textResponse(' @article{Paskin_1999, title={Toward unique identifiers}} '),
      },
      { match: 'doi.org/10.1109/missing', respond: () => textResponse('not found', 404) },
    ]);
    const output = text(
      await client.callTool({
        name: 'cite_paper',
        arguments: { ids: ['10.1109/5.771073', '10.1109/missing'] },
      }),
    );
    expect(output).toBe(
      '@article{Paskin_1999, title={Toward unique identifiers}}\n\n% 10.1109/missing: No bibtex citation is registered for 10.1109/missing.',
    );
  });

  it('reports status without network access', async () => {
    const { client, fetch } = await connect([], { IEEE_API_KEY: 'k' });
    const output = text(await client.callTool({ name: 'status', arguments: {} }));
    expect(output).toContain('IEEE API: key set');
    expect(output).toContain('OpenAlex: no API key');
    expect(output).toContain('Institutional proxy: not configured');
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('checkDownloadDirectory', () => {
  // resolve() makes these absolute on every platform (a drive letter is added on Windows).
  const home = resolve('/home/u');
  const downloads = join(home, 'Downloads', 'ieee-papers');
  it('allows folders in the home directory', () => {
    expect(checkDownloadDirectory(join(home, 'thesis', 'refs'), downloads, home)).toBe(
      join(home, 'thesis', 'refs'),
    );
    expect(checkDownloadDirectory(home, downloads, home)).toBe(home);
  });

  it('rejects hidden folders, other places and relative paths', () => {
    expect(() => checkDownloadDirectory(join(home, '.ssh'), downloads, home)).toThrow(/hidden/);
    expect(() => checkDownloadDirectory(join(home, 'docs', '.config', 'x'), downloads, home)).toThrow(
      /hidden/,
    );
    expect(() => checkDownloadDirectory(resolve('/etc'), downloads, home)).toThrow(/home directory/);
    expect(() => checkDownloadDirectory(`${home}/../other`, downloads, home)).toThrow(/home directory/);
    expect(() => checkDownloadDirectory('refs', downloads, home)).toThrow(/absolute/);
  });
});

describe('slug', () => {
  it('keeps decimals and cuts long titles at a word', () => {
    expect(slug('A Resistor-Based Temperature Sensor With a 0.13 pJ · K2 Resolution FoM')).toBe(
      'A-Resistor-Based-Temperature-Sensor-With-a-0.13-pJ-K2-Resolution-FoM',
    );
    expect(slug('Über Größe: a study.').length).toBeLessThanOrEqual(80);
    expect(slug('Über Größe: a study.')).toBe('Uber-Grosse-a-study');
    expect(slug('word '.repeat(40)).length).toBeLessThanOrEqual(80);
  });
});
