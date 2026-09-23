import { IeeeMcpError } from './errors.js';

export type PaperId =
  { kind: 'doi'; doi: string } | { kind: 'ieee'; articleNumber: string } | { kind: 'openalex'; id: string };

const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/;

/** Lower-case a DOI and strip resolver prefixes. Returns undefined if it is not a DOI. */
export function normalizeDoi(value: string): string | undefined {
  let text = value.trim();
  text = text.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
  try {
    text = decodeURIComponent(text);
  } catch {
    // keep the raw text; a stray % is not worth failing over
  }
  text = text.replace(/[.,;]+$/, '');
  return DOI_PATTERN.test(text) ? text.toLowerCase() : undefined;
}

function articleNumberFromUrl(url: URL): string | undefined {
  const fromQuery = url.searchParams.get('arnumber') ?? url.searchParams.get('arNumber');
  if (fromQuery && /^\d+$/.test(fromQuery)) return fromQuery;
  const match = /\/document\/(\d+)/.exec(url.pathname);
  return match?.[1];
}

/**
 * Parse anything a user or model might pass as a paper reference: a DOI in any common
 * spelling, an IEEE article number, an Xplore URL (also through a proxy), or an OpenAlex id.
 */
export function parsePaperId(input: string): PaperId {
  const text = input.trim();
  if (!text) throw new IeeeMcpError('INVALID_ARGUMENT', 'A paper id is required.');

  const doi = normalizeDoi(text);
  if (doi) return { kind: 'doi', doi };

  if (/^\d{3,12}$/.test(text)) return { kind: 'ieee', articleNumber: text };

  const openAlex = /^(?:https?:\/\/(?:api\.)?openalex\.org\/(?:works\/)?)?(W\d+)$/i.exec(text);
  if (openAlex?.[1]) return { kind: 'openalex', id: openAlex[1].toUpperCase() };

  if (/^https?:\/\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new IeeeMcpError('INVALID_ARGUMENT', `"${text.slice(0, 200)}" is not a valid URL.`);
    }
    const host = url.hostname.toLowerCase();
    if (host.includes('ieeexplore') || host.includes('ieee-org') || host.includes('ieee.org')) {
      const articleNumber = articleNumberFromUrl(url);
      if (articleNumber) return { kind: 'ieee', articleNumber };
    }
    // Some proxies rewrite DOI links too (doi-org.proxy.edu/10.1109/...).
    const proxiedDoi = normalizeDoi(url.pathname.replace(/^\//, ''));
    if (proxiedDoi && host.includes('doi')) return { kind: 'doi', doi: proxiedDoi };
  }

  throw new IeeeMcpError(
    'INVALID_ARGUMENT',
    `Could not read "${text.slice(0, 200)}" as a paper id. Use a DOI (10.1109/...), an IEEE article number, an IEEE Xplore URL or an OpenAlex id (W...).`,
  );
}

export function describeId(id: PaperId): string {
  switch (id.kind) {
    case 'doi':
      return `DOI ${id.doi}`;
    case 'ieee':
      return `IEEE article ${id.articleNumber}`;
    case 'openalex':
      return `OpenAlex ${id.id}`;
  }
}
