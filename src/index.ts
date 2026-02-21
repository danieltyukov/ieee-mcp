#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ── Constants ──────────────────────────────────────────────────────────────────

const API_BASE = "https://ieeexploreapi.ieee.org/api/v1/search/articles";
const DOC_BASE = "https://ieeexploreapi.ieee.org/api/v1/search/document";

const IEEE_API_KEY = process.env.IEEE_API_KEY;
const IEEE_AUTH_TOKEN = process.env.IEEE_AUTH_TOKEN;

const MAX_TEXT_LENGTH = 50_000;

// ── Types ──────────────────────────────────────────────────────────────────────

interface IEEEAuthor {
  authorUrl?: string;
  id?: number;
  full_name?: string;
  affiliation?: string;
}

interface IEEEArticle {
  article_number?: string;
  doi?: string;
  title?: string;
  abstract?: string;
  publication_title?: string;
  publication_year?: string;
  publication_date?: string;
  content_type?: string;
  start_page?: string;
  end_page?: string;
  citing_paper_count?: number;
  citing_patent_count?: number;
  is_open_access?: boolean;
  html_url?: string;
  pdf_url?: string;
  authors?: { authors: IEEEAuthor[] };
  index_terms?: Record<string, { terms: string[] }>;
  isbn?: string;
  issn?: string;
  publisher?: string;
  conference_location?: string;
  conference_dates?: string;
  full_text?: string;
}

interface IEEESearchResponse {
  total_records?: number;
  articles?: IEEEArticle[];
}

// ── API Client ─────────────────────────────────────────────────────────────────

async function ieeeRequest(
  params: Record<string, string | number | boolean | undefined>
): Promise<IEEESearchResponse> {
  const url = new URL(API_BASE);
  url.searchParams.set("apikey", IEEE_API_KEY!);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  console.error(`[ieee-mcp] GET ${url.pathname}?${url.searchParams.toString().replace(IEEE_API_KEY!, "***")}`);

  const res = await fetch(url.toString());

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new Error(`IEEE API auth error (${res.status}): Check your IEEE_API_KEY. ${body}`);
    }
    if (res.status === 429) {
      throw new Error(
        `IEEE API rate limit exceeded (429). The free tier allows ~200 calls/day. ${body}`
      );
    }
    throw new Error(`IEEE API error ${res.status}: ${body}`);
  }

  return (await res.json()) as IEEESearchResponse;
}

async function ieeeFullTextRequest(articleNumber: string): Promise<string> {
  const url = new URL(`${DOC_BASE}/${articleNumber}`);
  url.searchParams.set("apikey", IEEE_API_KEY!);

  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (IEEE_AUTH_TOKEN) {
    headers["Authorization"] = `Bearer ${IEEE_AUTH_TOKEN}`;
  }

  console.error(`[ieee-mcp] GET full-text for article ${articleNumber}`);

  const res = await fetch(url.toString(), { headers });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      if (!IEEE_AUTH_TOKEN) {
        throw new Error(
          `Full text not available: this article may be paywalled. Set IEEE_AUTH_TOKEN env var for institutional access. (${res.status})`
        );
      }
      throw new Error(`IEEE full-text auth error (${res.status}): ${body}`);
    }
    if (res.status === 404) {
      throw new Error(`Article ${articleNumber} not found.`);
    }
    throw new Error(`IEEE API error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as IEEEArticle;

  if (!data.full_text) {
    throw new Error(
      `No full text available for article ${articleNumber}. It may be paywalled (set IEEE_AUTH_TOKEN for institutional access) or not available via API.`
    );
  }

  let text = data.full_text;
  if (text.length > MAX_TEXT_LENGTH) {
    text = text.substring(0, MAX_TEXT_LENGTH) + `\n\n--- TRUNCATED at ${MAX_TEXT_LENGTH} characters ---`;
  }

  return text;
}

// ── Formatters ─────────────────────────────────────────────────────────────────

function formatArticle(article: IEEEArticle, verbose = false): string {
  const lines: string[] = [];

  lines.push(`**${article.title ?? "Untitled"}**`);

  const authors = article.authors?.authors;
  if (authors?.length) {
    const names = authors.map((a) => a.full_name).filter(Boolean);
    lines.push(`Authors: ${names.join(", ")}`);
    if (verbose) {
      for (const a of authors) {
        if (a.affiliation) {
          lines.push(`  - ${a.full_name}: ${a.affiliation}`);
        }
      }
    }
  }

  if (article.publication_title) {
    lines.push(`Publication: ${article.publication_title}`);
  }
  if (article.publication_year) {
    lines.push(`Year: ${article.publication_year}`);
  }
  if (article.content_type) {
    lines.push(`Type: ${article.content_type}`);
  }
  if (article.doi) {
    lines.push(`DOI: ${article.doi}`);
  }
  if (article.article_number) {
    lines.push(`Article #: ${article.article_number}`);
  }

  if (article.start_page && article.end_page) {
    lines.push(`Pages: ${article.start_page}-${article.end_page}`);
  }

  if (article.is_open_access) {
    lines.push(`Open Access: Yes`);
  }

  if (article.citing_paper_count !== undefined) {
    lines.push(`Citations: ${article.citing_paper_count} papers, ${article.citing_patent_count ?? 0} patents`);
  }

  if (article.abstract) {
    lines.push(`\nAbstract: ${article.abstract}`);
  }

  if (verbose && article.index_terms) {
    const allTerms: string[] = [];
    for (const [category, data] of Object.entries(article.index_terms)) {
      if (data?.terms?.length) {
        allTerms.push(`${category}: ${data.terms.join(", ")}`);
      }
    }
    if (allTerms.length) {
      lines.push(`\nKeywords:\n  ${allTerms.join("\n  ")}`);
    }
  }

  if (article.html_url) {
    lines.push(`URL: ${article.html_url}`);
  }
  if (article.pdf_url) {
    lines.push(`PDF: ${article.pdf_url}`);
  }

  return lines.join("\n");
}

function formatSearchResults(response: IEEESearchResponse, startRecord: number): string {
  const total = response.total_records ?? 0;
  const articles = response.articles ?? [];

  if (articles.length === 0) {
    return `No results found. (Total: ${total})`;
  }

  const lines: string[] = [];
  lines.push(`Found ${total} results (showing ${startRecord}-${startRecord + articles.length - 1}):\n`);

  for (let i = 0; i < articles.length; i++) {
    lines.push(`[${startRecord + i}] ${formatArticle(articles[i])}`);
    if (i < articles.length - 1) {
      lines.push("\n---\n");
    }
  }

  if (startRecord + articles.length < total) {
    lines.push(
      `\n---\nMore results available. Use start_record=${startRecord + articles.length} to see next page.`
    );
  }

  return lines.join("\n");
}

// ── MCP Server ─────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "ieee-xplore",
  version: "1.0.0",
});

// Tool 1: search_papers
server.registerTool(
  "search_papers",
  {
    description:
      "Search IEEE Xplore for papers. Supports full-text search with Boolean operators (AND, OR, NOT) and multiple filters. Returns metadata, abstracts, and links.",
    inputSchema: {
      querytext: z
        .string()
        .optional()
        .describe("Full-text search query. Supports AND, OR, NOT operators."),
      author: z.string().optional().describe("Filter by author name"),
      article_title: z.string().optional().describe("Search within article titles"),
      abstract: z.string().optional().describe("Search within abstracts"),
      affiliation: z.string().optional().describe("Filter by author affiliation"),
      index_terms: z.string().optional().describe("Search by index terms / keywords"),
      doi: z.string().optional().describe("Search by DOI"),
      publication_title: z.string().optional().describe("Filter by publication / journal / conference name"),
      publication_year: z.string().optional().describe("Filter by publication year (e.g. '2023')"),
      start_year: z.string().optional().describe("Start of year range (e.g. '2020')"),
      end_year: z.string().optional().describe("End of year range (e.g. '2024')"),
      content_type: z
        .string()
        .optional()
        .describe("Filter by content type: Conferences, Journals, Early Access, Standards, Books, Courses"),
      open_access: z.boolean().optional().describe("Filter for open access articles only"),
      max_records: z
        .number()
        .min(1)
        .max(200)
        .optional()
        .describe("Number of results to return (default 25, max 200)"),
      start_record: z.number().min(1).optional().describe("Starting record number for pagination (default 1)"),
      sort_field: z
        .string()
        .optional()
        .describe("Sort by: article_title, article_number, author, publication_title, publication_year"),
      sort_order: z.enum(["asc", "desc"]).optional().describe("Sort order: asc or desc"),
    },
  },
  async (args) => {
    const params: Record<string, string | number | boolean | undefined> = {};

    if (args.querytext) params.querytext = args.querytext;
    if (args.author) params.author = args.author;
    if (args.article_title) params.article_title = args.article_title;
    if (args.abstract) params.abstract = args.abstract;
    if (args.affiliation) params.affiliation = args.affiliation;
    if (args.index_terms) params.index_terms = args.index_terms;
    if (args.doi) params.doi = args.doi;
    if (args.publication_title) params.publication_title = args.publication_title;
    if (args.publication_year) params.publication_year = args.publication_year;
    if (args.start_year) params.start_year = args.start_year;
    if (args.end_year) params.end_year = args.end_year;
    if (args.content_type) params.content_type = args.content_type;
    if (args.open_access) params.open_access = true;
    if (args.max_records) params.max_records = args.max_records;
    if (args.start_record) params.start_record = args.start_record;
    if (args.sort_field) params.sort_field = args.sort_field;
    if (args.sort_order) params.sort_order = args.sort_order;

    try {
      const response = await ieeeRequest(params);
      const startRecord = args.start_record ?? 1;
      return {
        content: [{ type: "text" as const, text: formatSearchResults(response, startRecord) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 2: get_paper_details
server.registerTool(
  "get_paper_details",
  {
    description:
      "Get detailed metadata for a single IEEE paper by article number or DOI. Returns full author affiliations, abstract, keywords, citation counts, and URLs.",
    inputSchema: {
      article_number: z.string().optional().describe("IEEE article number"),
      doi: z.string().optional().describe("DOI of the paper"),
    },
  },
  async (args) => {
    if (!args.article_number && !args.doi) {
      return {
        content: [{ type: "text" as const, text: "Error: Provide either article_number or doi." }],
        isError: true,
      };
    }

    const params: Record<string, string | number | boolean | undefined> = {
      max_records: 1,
    };
    if (args.article_number) params.article_number = args.article_number;
    if (args.doi) params.doi = args.doi;

    try {
      const response = await ieeeRequest(params);
      const articles = response.articles ?? [];

      if (articles.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No paper found for ${args.article_number ? `article #${args.article_number}` : `DOI ${args.doi}`}.`,
            },
          ],
        };
      }

      return {
        content: [{ type: "text" as const, text: formatArticle(articles[0], true) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 3: get_paper_citations
server.registerTool(
  "get_paper_citations",
  {
    description: "Get citation counts (papers and patents) for an IEEE paper.",
    inputSchema: {
      article_number: z.string().optional().describe("IEEE article number"),
      doi: z.string().optional().describe("DOI of the paper"),
    },
  },
  async (args) => {
    if (!args.article_number && !args.doi) {
      return {
        content: [{ type: "text" as const, text: "Error: Provide either article_number or doi." }],
        isError: true,
      };
    }

    const params: Record<string, string | number | boolean | undefined> = {
      max_records: 1,
    };
    if (args.article_number) params.article_number = args.article_number;
    if (args.doi) params.doi = args.doi;

    try {
      const response = await ieeeRequest(params);
      const articles = response.articles ?? [];

      if (articles.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No paper found for ${args.article_number ? `article #${args.article_number}` : `DOI ${args.doi}`}.`,
            },
          ],
        };
      }

      const article = articles[0];
      const lines = [
        `**${article.title ?? "Untitled"}**`,
        `Citing papers: ${article.citing_paper_count ?? 0}`,
        `Citing patents: ${article.citing_patent_count ?? 0}`,
      ];

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 4: get_full_text
server.registerTool(
  "get_full_text",
  {
    description:
      "Retrieve the full text of an IEEE paper by article number. Works for Open Access articles. For paywalled articles, set IEEE_AUTH_TOKEN env var. Output is truncated at ~50K characters.",
    inputSchema: {
      article_number: z.string().describe("IEEE article number"),
    },
  },
  async (args) => {
    try {
      const text = await ieeeFullTextRequest(args.article_number);
      return {
        content: [{ type: "text" as const, text }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 5: search_by_author
server.registerTool(
  "search_by_author",
  {
    description:
      "Search IEEE Xplore for papers by a specific author. Convenience wrapper around search_papers with author as the primary filter.",
    inputSchema: {
      author: z.string().describe("Author name to search for"),
      start_year: z.string().optional().describe("Start of year range"),
      end_year: z.string().optional().describe("End of year range"),
      content_type: z
        .string()
        .optional()
        .describe("Filter by content type: Conferences, Journals, Early Access, Standards, Books, Courses"),
      publication_title: z.string().optional().describe("Filter by publication / journal / conference name"),
      max_records: z.number().min(1).max(200).optional().describe("Number of results (default 25, max 200)"),
      start_record: z.number().min(1).optional().describe("Starting record for pagination"),
    },
  },
  async (args) => {
    const params: Record<string, string | number | boolean | undefined> = {
      author: args.author,
    };

    if (args.start_year) params.start_year = args.start_year;
    if (args.end_year) params.end_year = args.end_year;
    if (args.content_type) params.content_type = args.content_type;
    if (args.publication_title) params.publication_title = args.publication_title;
    if (args.max_records) params.max_records = args.max_records;
    if (args.start_record) params.start_record = args.start_record;

    try {
      const response = await ieeeRequest(params);
      const startRecord = args.start_record ?? 1;
      return {
        content: [{ type: "text" as const, text: formatSearchResults(response, startRecord) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 6: search_by_publication
server.registerTool(
  "search_by_publication",
  {
    description:
      "Search IEEE Xplore for papers in a specific publication (journal/conference). Convenience wrapper around search_papers with publication_title as the primary filter.",
    inputSchema: {
      publication_title: z.string().describe("Publication, journal, or conference name"),
      querytext: z.string().optional().describe("Additional search query within the publication"),
      start_year: z.string().optional().describe("Start of year range"),
      end_year: z.string().optional().describe("End of year range"),
      max_records: z.number().min(1).max(200).optional().describe("Number of results (default 25, max 200)"),
      start_record: z.number().min(1).optional().describe("Starting record for pagination"),
      sort_field: z.string().optional().describe("Sort by: article_title, publication_year, etc."),
      sort_order: z.enum(["asc", "desc"]).optional().describe("Sort order: asc or desc"),
    },
  },
  async (args) => {
    const params: Record<string, string | number | boolean | undefined> = {
      publication_title: args.publication_title,
    };

    if (args.querytext) params.querytext = args.querytext;
    if (args.start_year) params.start_year = args.start_year;
    if (args.end_year) params.end_year = args.end_year;
    if (args.max_records) params.max_records = args.max_records;
    if (args.start_record) params.start_record = args.start_record;
    if (args.sort_field) params.sort_field = args.sort_field;
    if (args.sort_order) params.sort_order = args.sort_order;

    try {
      const response = await ieeeRequest(params);
      const startRecord = args.start_record ?? 1;
      return {
        content: [{ type: "text" as const, text: formatSearchResults(response, startRecord) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  if (!IEEE_API_KEY) {
    console.error(
      "[ieee-mcp] ERROR: IEEE_API_KEY environment variable is required.\n" +
        "Register at https://developer.ieee.org to get a free API key."
    );
    process.exit(1);
  }

  console.error("[ieee-mcp] Starting IEEE Xplore MCP server...");
  if (IEEE_AUTH_TOKEN) {
    console.error("[ieee-mcp] IEEE_AUTH_TOKEN set - paywalled full-text access enabled.");
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[ieee-mcp] Server running on stdio.");
}

main().catch((error) => {
  console.error("[ieee-mcp] Fatal error:", error);
  process.exit(1);
});
