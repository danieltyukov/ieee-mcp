import { IeeeMcpError } from './errors.js';
import { debug } from './http.js';
import { describeId, parsePaperId, type PaperId } from './ids.js';
import type { CitationFormat, DoiClient } from './sources/doi.js';
import { IeeeAccountError, ieeeSupports, type IeeeClient } from './sources/ieee.js';
import { IEEE_PUBLISHER, mapWork, shortId, type OaWork, type OpenAlexClient } from './sources/openalex.js';
import type { Paper, SearchPage, SearchQuery, SortOrder } from './types.js';

export interface Resolved {
  paper: Paper;
  /** The full OpenAlex record, when the paper is known there. */
  work?: OaWork;
  /** Lookups that failed for a transient reason; the paper is usable but incomplete. */
  warnings: string[];
}

export interface ListOptions {
  sort: SortOrder;
  limit: number;
  page: number;
  ieeeOnly?: boolean;
}

export interface CitationResult {
  input: string;
  citation?: string;
  error?: string;
}

interface Disabled {
  reason: string;
  /** Epoch ms after which the IEEE API is tried again; undefined means for the whole process. */
  until?: number;
}

function nextUtcMidnight(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

/** Fill fields the IEEE record lacks from the OpenAlex record of the same paper. */
export function mergePapers(ieee: Paper, openalex: Paper): Paper {
  const merged: Paper = { ...openalex, ...ieee };
  for (const key of Object.keys(openalex) as (keyof Paper)[]) {
    if (merged[key] === undefined) (merged as unknown as Record<string, unknown>)[key] = openalex[key];
  }
  if (!ieee.abstract && openalex.abstract) merged.abstract = openalex.abstract;
  if (!ieee.keywords.length) merged.keywords = openalex.keywords;
  if (!ieee.authors.length) merged.authors = openalex.authors;
  merged.oaPdfUrls = openalex.oaPdfUrls;
  merged.oaLandingUrls = openalex.oaLandingUrls ?? [];
  if (ieee.isOpenAccess === undefined) merged.isOpenAccess = openalex.isOpenAccess;
  merged.source = 'ieee';
  return merged;
}

export class Library {
  private disabled?: Disabled;

  constructor(
    readonly openalex: OpenAlexClient,
    readonly doi: DoiClient,
    readonly ieee?: IeeeClient,
    private readonly now: () => number = Date.now,
  ) {}

  /** The IEEE client, unless it is missing or was switched off after an account error. */
  private activeIeee(): IeeeClient | undefined {
    if (!this.ieee) return undefined;
    if (this.disabled) {
      if (this.disabled.until !== undefined && this.now() >= this.disabled.until) this.disabled = undefined;
      else return undefined;
    }
    return this.ieee;
  }

  private disable(error: IeeeAccountError): void {
    this.disabled = { reason: error.reason, ...(error.quota ? { until: nextUtcMidnight(this.now()) } : {}) };
    debug(`IEEE API disabled: ${error.reason}`);
  }

  ieeeStatus(): { configured: boolean; active: boolean; reason?: string } {
    const active = Boolean(this.activeIeee());
    return {
      configured: Boolean(this.ieee),
      active,
      ...(this.disabled ? { reason: this.disabled.reason } : {}),
    };
  }

  /**
   * Run an IEEE call. An account error switches the IEEE API off; a transient failure (timeout,
   * 5xx, rate limit) only skips it for this call. Either way the caller falls back to OpenAlex.
   */
  private async tryIeee<T>(
    task: (client: IeeeClient) => Promise<T>,
  ): Promise<{ value?: T; notice?: string; failure?: IeeeMcpError }> {
    const client = this.activeIeee();
    if (!client) return {};
    try {
      return { value: await task(client) };
    } catch (error) {
      if (error instanceof IeeeAccountError) {
        this.disable(error);
        return { notice: `IEEE API unavailable (${error.reason}); answered from OpenAlex.`, failure: error };
      }
      if (error instanceof IeeeMcpError && error.code !== 'NOT_FOUND' && error.code !== 'INVALID_ARGUMENT') {
        debug(`IEEE API call failed: ${error.message}`);
        return { notice: `IEEE API failed (${error.message}); answered from OpenAlex.`, failure: error };
      }
      throw error;
    }
  }

  async search(query: SearchQuery): Promise<SearchPage> {
    if (query.semantic && !query.query) {
      throw new IeeeMcpError('INVALID_ARGUMENT', 'Semantic search needs a query.');
    }
    if (
      !query.query &&
      !query.title &&
      !query.author &&
      !query.affiliation &&
      !query.venue &&
      !query.keywords
    ) {
      throw new IeeeMcpError(
        'INVALID_ARGUMENT',
        'Give at least one of query, title, author, affiliation, venue or keywords.',
      );
    }
    const notices: string[] = [];
    if (ieeeSupports(query)) {
      const attempt = await this.tryIeee((client) => client.search(query));
      if (attempt.value) return attempt.value;
      if (attempt.notice) notices.push(attempt.notice);
    } else if (this.activeIeee()) {
      notices.push(
        query.semantic ? 'Semantic search runs on OpenAlex.' : 'Sorting by citations runs on OpenAlex.',
      );
    }
    const page = await this.openalex.search(query);
    if (page.notice) notices.push(page.notice);
    return { ...page, ...(notices.length ? { notice: notices.join(' ') } : {}) };
  }

  /** Resolve any accepted id to a paper, combining IEEE and OpenAlex data where both exist. */
  async resolve(input: string | PaperId): Promise<Resolved> {
    const id = typeof input === 'string' ? parsePaperId(input) : input;
    if (id.kind === 'ieee') return this.resolveArticleNumber(id.articleNumber);

    const work = await this.openalex.work(id.kind === 'doi' ? { doi: id.doi } : { openAlexId: id.id });
    let paper = work ? mapWork(work) : undefined;
    const doi = paper?.doi ?? (id.kind === 'doi' ? id.doi : undefined);

    let ieeeFailure: IeeeMcpError | undefined;
    if (doi) {
      const ieee = await this.tryIeee((client) => client.get({ doi }));
      if (ieee.value) paper = paper ? mergePapers(ieee.value, paper) : ieee.value;
      ieeeFailure = ieee.failure;
    }
    if (!paper) {
      // Not finding a paper is only a verdict when every source actually answered.
      if (ieeeFailure && !(ieeeFailure instanceof IeeeAccountError)) throw ieeeFailure;
      throw new IeeeMcpError('NOT_FOUND', `No paper was found for ${describeId(id)}.`);
    }
    const warnings: string[] = [];
    if (!paper.articleNumber && paper.doi) {
      try {
        const number = await this.doi.articleNumber(paper.doi);
        if (number) paper.articleNumber = number;
      } catch (error) {
        const reason = error instanceof IeeeMcpError ? error.message : 'the lookup failed';
        debug(`handle lookup failed: ${reason}`);
        warnings.push(
          `The IEEE article number could not be looked up at doi.org (${reason}). Retry, or pass the article number.`,
        );
      }
    }
    return work ? { paper, work, warnings } : { paper, warnings };
  }

  private async resolveArticleNumber(articleNumber: string): Promise<Resolved> {
    const attempt = await this.tryIeee((client) => client.get({ articleNumber }));
    if (!attempt.value) {
      if (attempt.failure && !(attempt.failure instanceof IeeeAccountError)) throw attempt.failure;
      if (attempt.failure || !this.activeIeee()) {
        throw new IeeeMcpError(
          'NOT_CONFIGURED',
          `Looking up IEEE article ${articleNumber} by number needs a working IEEE_API_KEY. Pass the DOI instead (read_paper and download_pdf accept the article number as is).`,
        );
      }
      throw new IeeeMcpError('NOT_FOUND', `No IEEE paper has article number ${articleNumber}.`);
    }
    const ieee = attempt.value;
    ieee.articleNumber ??= articleNumber;
    if (!ieee.doi) return { paper: ieee, warnings: [] };
    try {
      const work = await this.openalex.work({ doi: ieee.doi });
      return work
        ? { paper: mergePapers(ieee, mapWork(work)), work, warnings: [] }
        : { paper: ieee, warnings: [] };
    } catch (error) {
      const reason = error instanceof IeeeMcpError ? error.message : 'the request failed';
      debug(`OpenAlex lookup failed: ${reason}`);
      return {
        paper: ieee,
        warnings: [
          `OpenAlex could not be reached (${reason}); citation data and open-access links are missing.`,
        ],
      };
    }
  }

  private async openAlexWork(input: string): Promise<{ paper: Paper; work: OaWork }> {
    const resolved = await this.resolve(input);
    if (!resolved.work) {
      if (resolved.warnings.length) throw new IeeeMcpError('UPSTREAM_ERROR', resolved.warnings.join(' '));
      throw new IeeeMcpError('NOT_FOUND', `OpenAlex has no citation data for "${resolved.paper.title}".`);
    }
    return { paper: resolved.paper, work: resolved.work };
  }

  async citing(input: string, options: ListOptions): Promise<{ paper: Paper; page: SearchPage }> {
    const { paper, work } = await this.openAlexWork(input);
    const filters = [`cites:${shortId(work.id)}`];
    if (options.ieeeOnly) filters.push(`primary_location.source.host_organization:${IEEE_PUBLISHER}`);
    return { paper, page: await this.openalex.list(filters.join(','), options) };
  }

  async related(input: string, options: ListOptions): Promise<{ paper: Paper; page: SearchPage }> {
    const { paper, work } = await this.openAlexWork(input);
    const filters = [`related_to:${shortId(work.id)}`];
    if (options.ieeeOnly) filters.push(`primary_location.source.host_organization:${IEEE_PUBLISHER}`);
    return { paper, page: await this.openalex.list(filters.join(','), options) };
  }

  /** The reference list in the order OpenAlex stores it, one page at a time. */
  async references(
    input: string,
    options: { limit: number; page: number },
  ): Promise<{ paper: Paper; page: SearchPage }> {
    const { paper, work } = await this.openAlexWork(input);
    const ids = (work.referenced_works ?? []).map((url) => shortId(url)!).filter(Boolean);
    const start = (options.page - 1) * options.limit;
    const papers = await this.openalex.works(ids.slice(start, start + options.limit));
    return {
      paper,
      page: { source: 'openalex', total: ids.length, page: options.page, limit: options.limit, papers },
    };
  }

  /** Citations for several papers. Failures are reported per paper instead of failing the batch. */
  async cite(inputs: string[], format: CitationFormat): Promise<CitationResult[]> {
    const results: CitationResult[] = [];
    for (const input of inputs) {
      try {
        const id = parsePaperId(input);
        const doi = id.kind === 'doi' ? id.doi : (await this.resolve(id)).paper.doi;
        if (!doi) throw new IeeeMcpError('NOT_FOUND', 'This paper has no DOI.');
        results.push({ input, citation: await this.doi.citation(doi, format) });
      } catch (error) {
        if (!(error instanceof IeeeMcpError)) console.error('[ieee-mcp] citation lookup failed:', error);
        results.push({ input, error: error instanceof IeeeMcpError ? error.message : 'Lookup failed.' });
      }
    }
    return results;
  }
}
