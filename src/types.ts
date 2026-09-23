export type Source = 'ieee' | 'openalex';

export type ContentType =
  'journal' | 'conference' | 'magazine' | 'book' | 'standard' | 'early_access' | 'course';

export const CONTENT_TYPES: readonly ContentType[] = [
  'journal',
  'conference',
  'magazine',
  'book',
  'standard',
  'early_access',
  'course',
];

export interface Author {
  name: string;
  affiliations: string[];
  orcid?: string;
}

export interface Paper {
  source: Source;
  title: string;
  doi?: string;
  /** IEEE Xplore article number. */
  articleNumber?: string;
  /** OpenAlex work id such as W2156186462. */
  openAlexId?: string;
  authors: Author[];
  abstract?: string;
  venue?: string;
  publisher?: string;
  contentType?: string;
  year?: number;
  date?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  citedBy?: number;
  patentCitations?: number;
  referencesCount?: number;
  keywords: string[];
  isOpenAccess?: boolean;
  /** Directly downloadable open-access PDF locations, best first. */
  oaPdfUrls: string[];
  /** Open-access repository pages without a direct PDF link; their citation_pdf_url tag usually has one. */
  oaLandingUrls?: string[];
  isRetracted?: boolean;
  conference?: { location?: string; dates?: string };
}

export type SortOrder = 'relevance' | 'citations' | 'newest' | 'oldest';

export interface SearchQuery {
  query?: string;
  title?: string;
  author?: string;
  affiliation?: string;
  venue?: string;
  keywords?: string;
  yearFrom?: number;
  yearTo?: number;
  contentType?: ContentType;
  openAccessOnly?: boolean;
  sort: SortOrder;
  limit: number;
  page: number;
  /** OpenAlex only: embedding search for conceptual matches. */
  semantic?: boolean;
}

export interface SearchPage {
  source: Source;
  /** Undefined when the source cannot count matches (semantic search). */
  total?: number;
  /** Set when more results exist but the total is unknown. */
  hasMore?: boolean;
  page: number;
  limit: number;
  papers: Paper[];
  /** Why the answering source differs from the preferred one, if it does. */
  notice?: string;
}
