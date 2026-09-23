import { IeeeMcpError } from '../errors.js';
import { HttpError, upstreamError, type HttpClient } from '../http.js';
import type { ContentType, Paper, SearchPage, SearchQuery } from '../types.js';

export const IEEE_API = 'https://ieeexploreapi.ieee.org/api/v1/search/articles';

interface IeeeAuthor {
  full_name?: string;
  affiliation?: string;
  author_order?: number;
}

export interface IeeeArticle {
  article_number?: string | number;
  doi?: string;
  title?: string;
  abstract?: string;
  publication_title?: string;
  publication_year?: string | number;
  publication_date?: string;
  content_type?: string;
  publisher?: string;
  volume?: string;
  issue?: string | number;
  start_page?: string;
  end_page?: string;
  citing_paper_count?: number;
  citing_patent_count?: number;
  access_type?: string;
  is_open_access?: boolean;
  authors?: { authors?: IeeeAuthor[] };
  index_terms?: Record<string, { terms?: string[] } | undefined>;
  conference_location?: string;
  conference_dates?: string;
}

interface IeeeResponse {
  total_records?: number;
  articles?: IeeeArticle[];
}

const CONTENT_TYPE: Record<ContentType, string> = {
  journal: 'Journals',
  conference: 'Conferences',
  magazine: 'Magazines',
  book: 'Books',
  standard: 'Standards',
  early_access: 'Early Access',
  course: 'Courses',
};

/**
 * An account-level failure: the key is wrong, deactivated or out of quota. The library stops
 * using the IEEE API when it sees one and answers from OpenAlex instead.
 */
export class IeeeAccountError extends IeeeMcpError {
  constructor(
    readonly reason: string,
    readonly quota: boolean,
  ) {
    super(
      'IEEE_KEY_INVALID',
      quota
        ? `The IEEE API daily quota is used up (${reason}).`
        : `The IEEE API rejected the key (${reason}). Reactivate it at https://developer.ieee.org or remove IEEE_API_KEY.`,
    );
  }
}

const GATEWAY_REASONS: [RegExp, string, boolean][] = [
  [/developer inactive/i, 'Developer Inactive', false],
  [/account inactive/i, 'Account Inactive', false],
  [/over queries per day|per day limit/i, 'daily query limit reached', true],
  [/over (queries per second|qps|rate)/i, 'rate limit reached', true],
  [/not authorized|invalid|unknown key/i, 'key not authorised', false],
];

/**
 * IEEE's gateway answers account problems with a short body such as "<h1>Developer Inactive</h1>".
 * Only known phrases are passed on, so nothing from the body (which could echo the key) reaches
 * the user verbatim.
 */
export function classifyIeeeFailure(error: HttpError): IeeeAccountError | undefined {
  if (error.status !== 401 && error.status !== 403) return undefined;
  for (const [pattern, reason, quota] of GATEWAY_REASONS) {
    if (pattern.test(error.body)) return new IeeeAccountError(reason, quota);
  }
  return new IeeeAccountError(`HTTP ${error.status}`, false);
}

function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const result = String(value).trim();
  return result ? result : undefined;
}

export function mapIeeeArticle(article: IeeeArticle): Paper {
  const authors = [...(article.authors?.authors ?? [])]
    .sort((a, b) => (a.author_order ?? 0) - (b.author_order ?? 0))
    .filter((a) => a.full_name)
    .map((a) => ({ name: a.full_name!, affiliations: a.affiliation ? [a.affiliation] : [] }));
  const keywords = new Set<string>();
  for (const group of ['author_terms', 'ieee_terms']) {
    for (const term of article.index_terms?.[group]?.terms ?? []) keywords.add(term);
  }
  const start = text(article.start_page);
  const end = text(article.end_page);
  const year = Number(article.publication_year);
  const paper: Paper = {
    source: 'ieee',
    title: text(article.title) ?? 'Untitled',
    authors,
    keywords: [...keywords].slice(0, 12),
    oaPdfUrls: [],
  };
  const optional: Partial<Paper> = {
    doi: text(article.doi)?.toLowerCase(),
    articleNumber: /^\d{1,12}$/.test(text(article.article_number) ?? '')
      ? text(article.article_number)
      : undefined,
    abstract: text(article.abstract),
    venue: text(article.publication_title),
    publisher: text(article.publisher),
    contentType: text(article.content_type),
    year: Number.isFinite(year) && year > 0 ? year : undefined,
    date: text(article.publication_date),
    volume: text(article.volume),
    issue: text(article.issue),
    pages: start && end ? `${start}-${end}` : start,
    citedBy: article.citing_paper_count,
    patentCitations: article.citing_patent_count,
    isOpenAccess:
      article.is_open_access ?? (article.access_type ? /open/i.test(article.access_type) : undefined),
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) (paper as unknown as Record<string, unknown>)[key] = value;
  }
  if (article.conference_location || article.conference_dates) {
    paper.conference = {
      ...(article.conference_location ? { location: article.conference_location } : {}),
      ...(article.conference_dates ? { dates: article.conference_dates } : {}),
    };
  }
  return paper;
}

/** Whether the IEEE API can serve this query. It cannot sort by citations or do semantic search. */
export function ieeeSupports(query: SearchQuery): boolean {
  return query.sort !== 'citations' && !query.semantic;
}

export function buildIeeeParams(query: SearchQuery): URLSearchParams {
  const params = new URLSearchParams();
  const set = (key: string, value: string | number | undefined): void => {
    if (value !== undefined && value !== '') params.set(key, String(value));
  };
  set('querytext', query.query);
  set('article_title', query.title);
  set('author', query.author);
  set('affiliation', query.affiliation);
  set('publication_title', query.venue);
  set('index_terms', query.keywords);
  set('start_year', query.yearFrom);
  set('end_year', query.yearTo);
  if (query.contentType) set('content_type', CONTENT_TYPE[query.contentType]);
  if (query.openAccessOnly) set('open_access', 'True');
  if (query.sort === 'newest' || query.sort === 'oldest') {
    set('sort_field', 'publication_year');
    set('sort_order', query.sort === 'newest' ? 'desc' : 'asc');
  }
  set('max_records', query.limit);
  set('start_record', (query.page - 1) * query.limit + 1);
  return params;
}

export class IeeeClient {
  constructor(
    private readonly http: HttpClient,
    private readonly apiKey: string,
  ) {}

  private async request(params: URLSearchParams): Promise<IeeeResponse> {
    params.set('apikey', this.apiKey);
    params.set('format', 'json');
    try {
      return await this.http.getJson<IeeeResponse>(`${IEEE_API}?${params.toString()}`, {
        cacheTtlMs: 10 * 60_000,
      });
    } catch (error) {
      if (error instanceof HttpError)
        throw classifyIeeeFailure(error) ?? upstreamError('The IEEE API', error);
      throw error;
    }
  }

  async search(query: SearchQuery): Promise<SearchPage> {
    const response = await this.request(buildIeeeParams(query));
    return {
      source: 'ieee',
      total: response.total_records ?? 0,
      page: query.page,
      limit: query.limit,
      papers: (response.articles ?? []).map(mapIeeeArticle),
    };
  }

  async get(id: { articleNumber: string } | { doi: string }): Promise<Paper | undefined> {
    const params = new URLSearchParams({ max_records: '1' });
    if ('articleNumber' in id) params.set('article_number', id.articleNumber);
    else params.set('doi', id.doi);
    const response = await this.request(params);
    const article = response.articles?.[0];
    return article ? mapIeeeArticle(article) : undefined;
  }

  /** A cheap request that tells whether the key works. */
  async verify(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await this.request(new URLSearchParams({ querytext: 'ieee', max_records: '1' }));
      return { ok: true };
    } catch (error) {
      if (error instanceof IeeeMcpError) return { ok: false, reason: error.message };
      throw error;
    }
  }
}
