# Design

This document describes how ieee-xplore-mcp 2.x is put together and why. It is written for
contributors; user-facing setup lives in the [README](../README.md).

## Goals

- Search and read IEEE Xplore literature from any MCP client (Claude Code, Claude Desktop,
  Cursor, VS Code, Codex, ...).
- Work out of the box without an IEEE API key. IEEE keys are slow to obtain and are
  deactivated after inactivity (`403 Developer Inactive`), which made 1.x unusable for most
  people.
- Read full text of paywalled papers through the user's own institutional access (an EZproxy
  such as `ieeexplore-ieee-org.tudelft.idm.oclc.org`), one paper at a time, on request.
- Use only documented public APIs for metadata. The server never scrapes Xplore pages or
  calls the undocumented JSON endpoints behind the Xplore web app.

## Non-goals

- Bulk downloading. Institutional licences forbid systematic downloading; the server has no
  batch PDF tool and rate-limits proxy downloads.
- Hosting a shared service. Every user runs the server locally with their own keys and their
  own sign-in.

## Data sources

| Source                                                                                                     | Used for                                                                                                           | Auth                                       |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| [IEEE Xplore API](https://developer.ieee.org)                                                              | Search with IEEE-native filters, article numbers, IEEE index terms                                                 | `IEEE_API_KEY` (optional)                  |
| [OpenAlex](https://openalex.org)                                                                           | Search (keyword and semantic), metadata, abstracts, citing works, references, related works, open-access locations | `OPENALEX_API_KEY` (optional, recommended) |
| [doi.org handle API](https://www.doi.org/the-identifier/resources/factsheets/doi-resolution-documentation) | DOI to IEEE article number (the DOI's registered URL is the Xplore document URL)                                   | none                                       |
| DOI content negotiation                                                                                    | BibTeX, RIS and formatted citations (IEEE, APA, ...)                                                               | none                                       |
| Institutional proxy                                                                                        | PDF of one paper (`/stampPDF/getPDF.jsp?arnumber=N`)                                                               | browser sign-in                            |

OpenAlex results are restricted to IEEE with `primary_location.source.host_organization:P4310319808`.

### Backend selection

`search_papers` uses the IEEE API when a key is configured and healthy, otherwise OpenAlex.
When IEEE answers with an account error (inactive key, daily quota exceeded) the backend is
marked unavailable for the rest of the process (quota errors until the next UTC day) and the
same request is retried on OpenAlex. The response says which source answered and why a
fallback happened, so the model and user are never misled about coverage.

Citation graph tools (`get_citing_papers`, `get_references`, `get_related_papers`) always use
OpenAlex; the IEEE API has no equivalent.

## Identifiers

Every tool that takes a paper accepts any of:

- a DOI (`10.1109/5.771073`, `doi:10.1109/...`, `https://doi.org/10.1109/...`)
- an IEEE article number (`771073`) or any Xplore URL, including proxied ones
  (`https://ieeexplore-ieee-org.tudelft.idm.oclc.org/document/771073`)
- an OpenAlex work id (`W2156186462` or `https://openalex.org/W2156186462`)

`src/ids.ts` parses these into a tagged `PaperId`. Resolution to a full record:

1. DOI or OpenAlex id: OpenAlex singleton lookup (free of charge on OpenAlex), then the DOI
   handle API for the article number.
2. Article number: IEEE API when available. Without a key there is no documented public
   mapping from article number to DOI, so metadata tools ask for the DOI instead. Full text
   still works, since the proxy only needs the article number.

## Full text

`read_paper` and `download_pdf` obtain a PDF in this order and stop at the first success:

1. Cache (`~/.ieee-mcp/cache`), keyed by article number or DOI.
2. Open-access copies listed by OpenAlex (`best_oa_location`, then other `locations` with a
   `pdf_url`), preferring repositories such as arXiv.
3. The institutional proxy, if configured and signed in.

Text is extracted with pdf.js in a worker thread with a time limit and network access
disabled, cached next to the PDF, and returned in chunks (`offset`, `max_chars`) so a long
paper can be read in several calls without truncation.

### Institutional proxy

- `IEEE_PROXY_URL` is any URL on the proxied Xplore host; only its origin is kept.
- `ieee-xplore-mcp login` opens a real browser window (system Chrome, Edge, Chromium or Brave
  through `playwright-core`) with a dedicated profile in `~/.ieee-mcp/profile`. The user signs
  in with their institution. When the window reaches the proxied Xplore host, cookies that
  domain-match the proxy host (RFC 6265) and the browser's user agent are saved to
  `~/.ieee-mcp/session.json` with owner-only permissions.
- Requests use `fetch` with those cookies and follow redirects manually, applying cookies per
  host. A redirect to a login page means the session expired; the server then tries one silent
  renewal in a headless window with the same profile (institution SSO sessions usually outlive
  proxy sessions) before reporting `AUTH_REQUIRED`.
- Downloads are serialised, spaced at least 10 seconds apart, and capped per day
  (`IEEE_MCP_PROXY_DAILY_LIMIT`, default 40). Cached papers do not count.

## Layout

```
src/
  cli.ts            command line entry (serve, login, logout, status, tools)
  config.ts         environment parsing
  errors.ts         IeeeMcpError with stable codes
  ids.ts            identifier parsing
  types.ts          Paper, SearchQuery, SearchPage
  http.ts           fetch wrapper: timeouts, retries, JSON, TTL cache
  sources/
    ieee.ts         IEEE Xplore API client
    openalex.ts     OpenAlex client
    doi.ts          handle API and citation formatting
  library.ts        backend selection, fallback, id resolution
  fulltext/
    pdf-worker.js   pdf.js extraction (worker thread)
    extract.ts      worker wrapper
    fetcher.ts      OA and proxy PDF retrieval, cache, rate limiting
  proxy/
    cookies.ts      cookie matching
    session.ts      session file
    browser.ts      browser discovery and sign-in
  format.ts         model-facing text rendering
  tools.ts          MCP tool definitions
  server.ts         McpServer assembly
```

## Output

Tools return compact Markdown meant for a language model: one block per paper with
identifiers first, so follow-up calls can reuse them. Errors are returned as tool errors with a
stable code (`NOT_FOUND`, `AUTH_REQUIRED`, `RATE_LIMITED`, ...) and a message that says what
to do next. Upstream response bodies and cookies never appear in errors.

## Testing

- Unit tests run against recorded fixtures with an injected `fetch`; no network.
- `tests/server.test.ts` drives the real MCP server over an in-memory transport.
- `npm run test:live` (sets `IEEE_MCP_LIVE=1`) exercises OpenAlex, doi.org and, when
  configured, the IEEE API and the proxy.
