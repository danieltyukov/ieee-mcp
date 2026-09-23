import { IeeeMcpError } from '../errors.js';
import { HttpError, upstreamError, type HttpClient } from '../http.js';

export type CitationFormat = 'bibtex' | 'ris' | 'csl-json' | 'ieee' | 'apa' | 'chicago' | 'harvard' | 'mla';

export const CITATION_FORMATS: readonly CitationFormat[] = [
  'bibtex',
  'ris',
  'csl-json',
  'ieee',
  'apa',
  'chicago',
  'harvard',
  'mla',
];

const ACCEPT: Record<CitationFormat, string> = {
  bibtex: 'application/x-bibtex',
  ris: 'application/x-research-info-systems',
  'csl-json': 'application/vnd.citationstyles.csl+json',
  ieee: 'text/x-bibliography; style=ieee; locale=en-US',
  apa: 'text/x-bibliography; style=apa; locale=en-US',
  chicago: 'text/x-bibliography; style=chicago-author-date; locale=en-US',
  harvard: 'text/x-bibliography; style=harvard-cite-them-right; locale=en-GB',
  mla: 'text/x-bibliography; style=modern-language-association; locale=en-US',
};

interface HandleResponse {
  responseCode?: number;
  values?: { type?: string; data?: { value?: unknown } }[];
}

/** doi.org handle records and DOI content negotiation; both documented and keyless. */
export class DoiClient {
  constructor(private readonly http: HttpClient) {}

  /**
   * IEEE registers each DOI with its Xplore document URL, so the handle record carries the
   * article number without touching Xplore itself.
   */
  async articleNumber(doi: string): Promise<string | undefined> {
    if (!doi.startsWith('10.1109/')) return undefined;
    let response: HandleResponse;
    try {
      response = await this.http.getJson<HandleResponse>(
        `https://doi.org/api/handles/${encodeURI(doi)}?type=URL`,
        { cacheTtlMs: 24 * 60 * 60_000, contact: true },
      );
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return undefined;
      throw upstreamError('doi.org', error);
    }
    for (const value of response.values ?? []) {
      if (value.type !== 'URL' || typeof value.data?.value !== 'string') continue;
      const match = /ieeexplore\.ieee\.org\/(?:document\/|.*[?&]arnumber=)(\d+)/i.exec(value.data.value);
      if (match?.[1]) return match[1];
    }
    return undefined;
  }

  async citation(doi: string, format: CitationFormat): Promise<string> {
    try {
      const body = await this.http.getText(`https://doi.org/${encodeURI(doi)}`, {
        headers: { Accept: ACCEPT[format] },
        cacheTtlMs: 24 * 60 * 60_000,
        contact: true,
      });
      const trimmed = body.trim();
      if (!trimmed || /^<(!doctype|html)/i.test(trimmed)) {
        throw new IeeeMcpError('UPSTREAM_ERROR', `No ${format} citation is available for ${doi}.`);
      }
      return trimmed;
    } catch (error) {
      if (error instanceof HttpError && (error.status === 404 || error.status === 406)) {
        throw new IeeeMcpError('NOT_FOUND', `No ${format} citation is registered for ${doi}.`);
      }
      throw upstreamError('doi.org', error);
    }
  }
}
