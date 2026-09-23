import { IeeeMcpError } from '../errors.js';
import { HttpError, upstreamError, type HttpClient } from '../http.js';
import type { ContentType, Paper, SearchPage, SearchQuery, SortOrder } from '../types.js';

export const OPENALEX_API = 'https://api.openalex.org';
/** OpenAlex publisher id of the Institute of Electrical and Electronics Engineers. */
export const IEEE_PUBLISHER = 'P4310319808';
const IEEE_FILTER = `primary_location.source.host_organization:${IEEE_PUBLISHER}`;

const WORK_FIELDS = [
  'id',
  'doi',
  'display_name',
  'publication_year',
  'publication_date',
  'type',
  'primary_location',
  'best_oa_location',
  'locations',
  'open_access',
  'authorships',
  'biblio',
  'cited_by_count',
  'referenced_works_count',
  'keywords',
  'abstract_inverted_index',
  'is_retracted',
].join(',');

interface OaSource {
  id?: string;
  display_name?: string;
  type?: string;
  host_organization?: string;
  host_organization_name?: string;
}

interface OaLocation {
  is_oa?: boolean;
  /** Crossref work type, e.g. journal-article or proceedings-article. */
  raw_type?: string | null;
  landing_page_url?: string | null;
  pdf_url?: string | null;
  source?: OaSource | null;
}

export interface OaWork {
  id: string;
  doi?: string | null;
  display_name?: string | null;
  publication_year?: number | null;
  publication_date?: string | null;
  type?: string | null;
  primary_location?: OaLocation | null;
  best_oa_location?: OaLocation | null;
  locations?: OaLocation[];
  open_access?: { is_oa?: boolean; oa_status?: string; oa_url?: string | null };
  authorships?: {
    author?: { id?: string; display_name?: string; orcid?: string | null };
    raw_author_name?: string;
    raw_affiliation_strings?: string[];
    institutions?: { display_name?: string }[];
  }[];
  biblio?: {
    volume?: string | null;
    issue?: string | null;
    first_page?: string | null;
    last_page?: string | null;
  };
  cited_by_count?: number;
  referenced_works_count?: number;
  referenced_works?: string[];
  related_works?: string[];
  keywords?: { display_name?: string }[];
  abstract_inverted_index?: Record<string, number[]> | null;
  is_retracted?: boolean;
}

interface OaList<T> {
  meta?: { count?: number; page?: number; per_page?: number };
  results?: T[];
}

interface OaAuthor {
  id: string;
  display_name?: string;
  display_name_alternatives?: string[];
  works_count?: number;
  last_known_institutions?: { display_name?: string }[];
}

interface OaSourceHit {
  id: string;
  display_name?: string;
  works_count?: number;
}

export function shortId(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  return url.slice(url.lastIndexOf('/') + 1);
}

/** OpenAlex ships abstracts as an inverted index; rebuild the running text. */
export function rebuildAbstract(index: Record<string, number[]> | null | undefined): string | undefined {
  if (!index) return undefined;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) words[position] = word;
  }
  const text = words
    .filter((word) => word !== undefined)
    .join(' ')
    .trim();
  return text || undefined;
}

function oaPdfUrls(work: OaWork): string[] {
  const candidates: OaLocation[] = [];
  if (work.best_oa_location) candidates.push(work.best_oa_location);
  for (const location of work.locations ?? []) if (location.is_oa) candidates.push(location);
  const urls = new Set<string>();
  for (const location of candidates) if (location.pdf_url) urls.add(location.pdf_url);
  // Repositories such as arXiv serve PDFs to scripts; publisher sites often do not. Try them first.
  return [...urls].sort((a, b) => Number(/ieee\.org/i.test(a)) - Number(/ieee\.org/i.test(b)));
}

/**
 * Open-access landing pages that list no PDF, typically institutional repositories. Publisher and
 * resolver pages are left out: the Xplore page is not scraped, and doi.org leads there.
 */
function oaLandingUrls(work: OaWork): string[] {
  const urls = new Set<string>();
  for (const location of [work.best_oa_location, ...(work.locations ?? [])]) {
    if (!location?.is_oa || location.pdf_url || !location.landing_page_url) continue;
    let host: string;
    try {
      host = new URL(location.landing_page_url).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (host === 'doi.org' || host.endsWith('.doi.org') || host === 'ieee.org' || host.endsWith('.ieee.org'))
      continue;
    urls.add(location.landing_page_url);
  }
  return [...urls];
}

const TYPE_LABEL: Record<string, string> = {
  'journal-article': 'journal article',
  'proceedings-article': 'conference paper',
  'book-chapter': 'book chapter',
  'posted-content': 'preprint',
};

const TEX_SYMBOLS: Record<string, string> = {
  circ: '°',
  mu: 'µ',
  Omega: 'Ω',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  Delta: 'Δ',
  delta: 'δ',
  Sigma: 'Σ',
  sigma: 'σ',
  lambda: 'λ',
  pi: 'π',
  times: '×',
  cdot: '·',
  pm: '±',
  plusmn: '±',
  deg: '°',
};

/** Crossref titles of IEEE papers carry TeX fragments such as "0.65 pJ $^{\circ}$ C $^{2}$". */
export function cleanTitle(title: string): string {
  return (
    title
      .replace(/\s*\$\s*\^\{\\circ\}\s*\$\s*/g, '°')
      // Crossref's legacy IEEE encoding of symbols, e.g. "3/spl sigma/" and "/spl plusmn/0.5".
      .replace(/\/spl\s*([A-Za-z]+)\//g, (match, name: string) => TEX_SYMBOLS[name] ?? match)
      .replace(/\\([A-Za-z]+)/g, (match, name: string) => TEX_SYMBOLS[name] ?? match)
      // After the symbols, so "\mu\hbox{W}" becomes "µW" rather than an unknown "\muW".
      .replace(/\\(?:hbox|mbox|text|textrm|mathrm)\{([^}]*)\}/g, '$1')
      .replace(/\s*\$\s*\^\{([^}$]*)\}\s*\$/g, '^$1')
      .replace(/\$\s*_\{([^}$]*)\}\s*\$/g, '_$1')
      .replace(/\$([^$]{1,40})\$/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function contentLabel(work: OaWork): string | undefined {
  const raw = work.primary_location?.raw_type ?? undefined;
  if (raw) return TYPE_LABEL[raw] ?? raw;
  return work.type ?? undefined;
}

export function mapWork(work: OaWork): Paper {
  const source = work.primary_location?.source ?? undefined;
  const first = work.biblio?.first_page ?? undefined;
  const last = work.biblio?.last_page ?? undefined;
  const paper: Paper = {
    source: 'openalex',
    title: cleanTitle(work.display_name ?? '') || 'Untitled',
    openAlexId: shortId(work.id)!,
    authors: (work.authorships ?? []).map((authorship) => {
      const affiliations = authorship.raw_affiliation_strings?.length
        ? authorship.raw_affiliation_strings
        : (authorship.institutions ?? []).map((i) => i.display_name).filter((n): n is string => Boolean(n));
      const orcid = shortId(authorship.author?.orcid);
      return {
        name: authorship.author?.display_name || authorship.raw_author_name || 'Unknown',
        affiliations: [...new Set(affiliations)],
        ...(orcid ? { orcid } : {}),
      };
    }),
    keywords: (work.keywords ?? [])
      .map((k) => k.display_name)
      .filter((k): k is string => Boolean(k))
      .slice(0, 8),
    oaPdfUrls: oaPdfUrls(work),
    oaLandingUrls: oaLandingUrls(work),
  };
  const doi = work.doi?.replace(/^https?:\/\/doi\.org\//i, '').toLowerCase();
  const optional: Partial<Paper> = {
    doi: doi || undefined,
    abstract: rebuildAbstract(work.abstract_inverted_index),
    venue: source?.display_name || undefined,
    publisher: source?.host_organization_name || undefined,
    contentType: contentLabel(work),
    year: work.publication_year ?? undefined,
    date: work.publication_date ?? undefined,
    volume: work.biblio?.volume ?? undefined,
    issue: work.biblio?.issue ?? undefined,
    pages: first && last && first !== last ? `${first}-${last}` : first,
    citedBy: work.cited_by_count,
    referencesCount: work.referenced_works_count,
    isOpenAccess: work.open_access?.is_oa,
    isRetracted: work.is_retracted || undefined,
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) (paper as unknown as Record<string, unknown>)[key] = value;
  }
  return paper;
}

/**
 * OpenAlex files nearly all IEEE proceedings under journal-type sources and its Crossref type
 * filter matches nothing, so only books and standards can be filtered reliably.
 */
const OPENALEX_TYPE: Partial<Record<ContentType, string>> = {
  book: 'book|book-chapter',
  standard: 'standard',
};

function contentTypeNotice(type: ContentType): string {
  return `OpenAlex cannot reliably tell IEEE ${type.replace('_', ' ')} items apart, so the content_type filter was ignored. Use venue to target a journal or conference, or set IEEE_API_KEY.`;
}

const SEMANTIC_BATCH = 50;

export function isIeee(work: OaWork): boolean {
  return shortId(work.primary_location?.source?.host_organization) === IEEE_PUBLISHER;
}

const SORT: Record<Exclude<SortOrder, 'relevance'>, string> = {
  citations: 'cited_by_count:desc',
  newest: 'publication_date:desc',
  oldest: 'publication_date:asc',
};

/** Characters that would change the meaning of a filter value. */
function filterValue(value: string): string {
  return value.replace(/[,|]/g, ' ').replace(/\s+/g, ' ').trim();
}

function fold(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Pick author profiles that carry every token of the requested name. OpenAlex often splits one person over several profiles. */
export function matchAuthors(name: string, candidates: OaAuthor[]): OaAuthor[] {
  const tokens = fold(name)
    .split(/[^a-z]+/)
    .filter((t) => t.length >= 2);
  const matches = candidates.filter((candidate) => {
    const names = [candidate.display_name ?? '', ...(candidate.display_name_alternatives ?? [])].map(fold);
    return tokens.every((token) => names.some((n) => n.includes(token)));
  });
  return (matches.length ? matches : candidates.slice(0, 1)).slice(0, 10);
}

export interface OpenAlexPlan {
  params: URLSearchParams;
  notices: string[];
}

export class OpenAlexClient {
  constructor(
    private readonly http: HttpClient,
    private readonly apiKey: string | undefined,
    private readonly email: string | undefined,
  ) {}

  private url(path: string, params: URLSearchParams): string {
    if (this.apiKey) params.set('api_key', this.apiKey);
    else if (this.email) params.set('mailto', this.email);
    return `${OPENALEX_API}${path}?${params.toString()}`;
  }

  private async get<T>(path: string, params: URLSearchParams, cacheTtlMs = 10 * 60_000): Promise<T> {
    try {
      return await this.http.getJson<T>(this.url(path, params), { cacheTtlMs, contact: true });
    } catch (error) {
      throw this.translate(error);
    }
  }

  private translate(error: unknown): unknown {
    if (!(error instanceof HttpError)) return error;
    if (error.status === 429 && !this.apiKey) {
      return new IeeeMcpError(
        'RATE_LIMITED',
        'OpenAlex limits searches without an API key. Set OPENALEX_API_KEY (free at https://openalex.org/settings/api) or try again in a minute.',
      );
    }
    if (error.status === 400) {
      let message = '';
      try {
        message = String((JSON.parse(error.body) as { message?: unknown }).message ?? '');
      } catch {
        // not JSON
      }
      return new IeeeMcpError(
        'INVALID_ARGUMENT',
        `OpenAlex rejected the query${message ? `: ${message.slice(0, 200)}` : ''}. Simplify the search terms.`,
      );
    }
    return upstreamError('OpenAlex', error);
  }

  /** Resolve an author name to OpenAlex profile ids, with a notice saying which profile matched. */
  private async authorFilter(name: string, notices: string[]): Promise<string | undefined> {
    const authors = await this.findAuthors(name);
    if (!authors.length) return undefined;
    const top = authors[0]!;
    const place = top.last_known_institutions?.[0]?.display_name;
    notices.push(
      `Author matched to OpenAlex profile "${top.display_name}"${place ? ` (${place})` : ''}${authors.length > 1 ? ` and ${authors.length - 1} split profile(s)` : ''}.`,
    );
    return `authorships.author.id:${authors.map((a) => shortId(a.id)).join('|')}`;
  }

  private async venueFilter(name: string, notices: string[]): Promise<string> {
    const sources = await this.findSources(name);
    if (!sources.length) {
      throw new IeeeMcpError('NOT_FOUND', `No IEEE publication matching "${name}" was found in OpenAlex.`);
    }
    const names = sources.slice(0, 3).map((s) => s.display_name);
    notices.push(
      `Venue matched to: ${names.join('; ')}${sources.length > 3 ? ` and ${sources.length - 3} more` : ''}.`,
    );
    return `primary_location.source.id:${sources.map((s) => shortId(s.id)).join('|')}`;
  }

  /** Translate a keyword search into OpenAlex parameters. Author and venue names are resolved to ids first. */
  async plan(query: SearchQuery): Promise<OpenAlexPlan> {
    if (query.semantic) return this.planSemantic(query);
    const notices: string[] = [];
    const filters = [IEEE_FILTER];
    if (query.title) filters.push(`title.search:${filterValue(query.title)}`);
    if (query.keywords) filters.push(`title_and_abstract.search:${filterValue(query.keywords)}`);
    if (query.affiliation) filters.push(`raw_affiliation_strings.search:${filterValue(query.affiliation)}`);
    if (query.yearFrom) filters.push(`from_publication_date:${query.yearFrom}-01-01`);
    if (query.yearTo) filters.push(`to_publication_date:${query.yearTo}-12-31`);
    if (query.openAccessOnly) filters.push('open_access.is_oa:true');
    if (query.contentType) {
      const type = OPENALEX_TYPE[query.contentType];
      if (type) filters.push(`type:${type}`);
      else notices.push(contentTypeNotice(query.contentType));
    }
    if (query.author) {
      filters.push(
        (await this.authorFilter(query.author, notices)) ??
          `raw_author_name.search:${filterValue(query.author)}`,
      );
    }
    if (query.venue) filters.push(await this.venueFilter(query.venue, notices));
    const params = new URLSearchParams();
    if (query.query) {
      // The full search also matches words anywhere in a paper's full text. That is fine when
      // results are ranked by relevance, but sorted by citations or date it floods the top with
      // well-cited papers that barely mention the terms, so match title and abstract instead.
      if (query.sort === 'relevance') params.set('search', query.query);
      else {
        filters.push(`title_and_abstract.search:${filterValue(query.query)}`);
        notices.push('Sorted results only count papers whose title or abstract matches the query.');
      }
    }
    params.set('filter', filters.join(','));
    if (query.sort !== 'relevance') params.set('sort', SORT[query.sort]);
    else if (!query.query) params.set('sort', SORT.citations);
    params.set('per_page', String(query.limit));
    params.set('page', String(query.page));
    params.set('select', WORK_FIELDS);
    return { params, notices };
  }

  /**
   * Semantic search accepts only a few filters and not the publisher one, so it over-fetches and
   * the caller keeps IEEE publications. Unsupported filters are reported, not silently dropped.
   */
  private async planSemantic(query: SearchQuery): Promise<OpenAlexPlan> {
    const notices: string[] = [];
    const filters: string[] = [];
    const ignored = [
      query.title ? 'title' : '',
      query.keywords ? 'keywords' : '',
      query.affiliation ? 'affiliation' : '',
      query.sort !== 'relevance' ? 'sort' : '',
    ].filter(Boolean);
    if (query.yearFrom && query.yearTo) filters.push(`publication_year:${query.yearFrom}-${query.yearTo}`);
    else if (query.yearFrom) filters.push(`publication_year:>${query.yearFrom - 1}`);
    else if (query.yearTo) filters.push(`publication_year:<${query.yearTo + 1}`);
    if (query.openAccessOnly) filters.push('open_access.is_oa:true');
    if (query.contentType) {
      const type = OPENALEX_TYPE[query.contentType];
      if (type) filters.push(`type:${type}`);
      else notices.push(contentTypeNotice(query.contentType));
    }
    if (query.author) {
      const author = await this.authorFilter(query.author, notices);
      if (author) filters.push(author);
      else ignored.push('author');
    }
    if (query.venue) filters.push(await this.venueFilter(query.venue, notices));
    if (ignored.length) notices.push(`Semantic search does not support ${ignored.join(', ')}; ignored.`);
    notices.push(
      `Ranked by meaning; IEEE publications kept from the top ${SEMANTIC_BATCH} matches of this page.`,
    );
    const params = new URLSearchParams();
    params.set('search.semantic', query.query ?? '');
    if (filters.length) params.set('filter', filters.join(','));
    params.set('per_page', String(SEMANTIC_BATCH));
    params.set('page', String(query.page));
    params.set('select', WORK_FIELDS);
    return { params, notices };
  }

  async search(query: SearchQuery): Promise<SearchPage> {
    const { params, notices } = await this.plan(query);
    const response = await this.get<OaList<OaWork>>('/works', params);
    const results = response.results ?? [];
    const base = { source: 'openalex' as const, page: query.page, limit: query.limit };
    const notice = notices.length ? { notice: notices.join(' ') } : {};
    if (query.semantic) {
      const ieee = results.filter((work) => isIeee(work)).slice(0, query.limit);
      return { ...base, papers: ieee.map(mapWork), hasMore: results.length === SEMANTIC_BATCH, ...notice };
    }
    return { ...base, total: response.meta?.count ?? 0, papers: results.map(mapWork), ...notice };
  }

  private async findAuthors(name: string): Promise<OaAuthor[]> {
    const params = new URLSearchParams({
      search: name,
      per_page: '10',
      select: 'id,display_name,display_name_alternatives,works_count,last_known_institutions',
    });
    const response = await this.get<OaList<OaAuthor>>('/authors', params, 60 * 60_000);
    return matchAuthors(name, response.results ?? []);
  }

  private async findSources(name: string): Promise<OaSourceHit[]> {
    const params = new URLSearchParams({
      search: name,
      filter: `host_organization:${IEEE_PUBLISHER}`,
      per_page: '25',
      select: 'id,display_name,works_count',
    });
    const response = await this.get<OaList<OaSourceHit>>('/sources', params, 60 * 60_000);
    return response.results ?? [];
  }

  /** Fetch one work by DOI or OpenAlex id. Singleton lookups are free on OpenAlex. */
  async work(id: { doi: string } | { openAlexId: string }): Promise<OaWork | undefined> {
    const key = 'doi' in id ? `doi:${id.doi}` : id.openAlexId;
    try {
      return await this.http.getJson<OaWork>(
        this.url(`/works/${encodeURIComponent(key)}`, new URLSearchParams()),
        { cacheTtlMs: 60 * 60_000, contact: true },
      );
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return undefined;
      throw this.translate(error);
    }
  }

  /** A page of works matching a filter, e.g. cites:W123 or related_to:W123. */
  async list(filter: string, options: { sort: SortOrder; limit: number; page: number }): Promise<SearchPage> {
    const params = new URLSearchParams({
      filter,
      per_page: String(options.limit),
      page: String(options.page),
      select: WORK_FIELDS,
    });
    if (options.sort !== 'relevance') params.set('sort', SORT[options.sort]);
    const response = await this.get<OaList<OaWork>>('/works', params);
    return {
      source: 'openalex',
      total: response.meta?.count ?? 0,
      page: options.page,
      limit: options.limit,
      papers: (response.results ?? []).map(mapWork),
    };
  }

  /** Works by OpenAlex id, in the order given. Unknown ids are skipped. */
  async works(ids: string[]): Promise<Paper[]> {
    if (!ids.length) return [];
    const params = new URLSearchParams({
      filter: `ids.openalex:${ids.join('|')}`,
      per_page: String(Math.min(ids.length, 100)),
      select: WORK_FIELDS,
    });
    const response = await this.get<OaList<OaWork>>('/works', params);
    const byId = new Map((response.results ?? []).map((work) => [shortId(work.id), mapWork(work)]));
    return ids.map((id) => byId.get(id)).filter((paper): paper is Paper => Boolean(paper));
  }
}
