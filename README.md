<p align="center">
  <img src="assets/logo.svg" alt="ieee-xplore-mcp" width="340">
</p>

<p align="center">Search, cite and read IEEE Xplore papers from your AI assistant.<br>No IEEE API key needed. Paywalled full text through your university library.</p>

<p align="center">
  <a href="https://github.com/danieltyukov/ieee-mcp/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/danieltyukov/ieee-mcp/ci.yml?branch=master&label=CI" alt="CI status"></a>
  <a href="https://github.com/danieltyukov/ieee-mcp/releases"><img src="https://img.shields.io/github/v/release/danieltyukov/ieee-mcp" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node 20 or newer">
</p>

## What it does

ieee-xplore-mcp is an [MCP](https://modelcontextprotocol.io) server that runs on your machine and lets Claude Code, Claude Desktop, Cursor, VS Code, Codex or any other MCP client work with IEEE literature:

- search IEEE journals, conferences, standards and books with boolean queries, author, venue, affiliation and year filters, or by meaning (semantic search)
- get full metadata: authors with affiliations, venue, identifiers, citation counts, open-access status, abstract
- follow the citation graph: papers citing a paper, its reference list, related papers
- read the full text of a paper, from an open-access copy or through your institution's proxy, and save the PDF
- produce BibTeX, RIS, CSL-JSON or formatted IEEE, APA, Chicago, Harvard and MLA references

Things you can ask once it is connected:

- Find the most cited IEEE papers on chopper-stabilised amplifiers since 2018.
- What has Kofi Makinwa published in JSSC in the last three years?
- Read the second result and summarise its architecture section.
- Which recent papers cite this one, and what did they improve?
- Give me BibTeX for these five DOIs.

## Quick start

```sh
npm install -g https://github.com/danieltyukov/ieee-mcp/releases/latest/download/ieee-xplore-mcp.tgz
claude mcp add ieee-xplore -s user -- ieee-xplore-mcp
```

That is enough to search, follow citations, cite and read open-access papers. Add a free [OpenAlex key](https://openalex.org/settings/api) for reliable search and your library's proxy for paywalled full text (see [Configure](#configure) and [Institutional access](#institutional-access)).

## Install

Requires Node 20 or newer.

```sh
npm install -g https://github.com/danieltyukov/ieee-mcp/releases/latest/download/ieee-xplore-mcp.tgz
ieee-xplore-mcp status
```

From source:

```sh
git clone https://github.com/danieltyukov/ieee-mcp.git
cd ieee-mcp && npm ci && npm run build && npm link
```

## Configure

Everything is optional; with no configuration the server searches OpenAlex and reads open-access papers.

| Variable                     | Purpose                                                                                                                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENALEX_API_KEY`           | Recommended. Free key from [openalex.org/settings/api](https://openalex.org/settings/api). Without it OpenAlex rate-limits searches heavily.                                                        |
| `IEEE_PROXY_URL`             | Your library's proxied IEEE Xplore address, for paywalled full text. Open IEEE Xplore through your library's website and copy the address, e.g. `https://ieeexplore-ieee-org.tudelft.idm.oclc.org`. |
| `IEEE_API_KEY`               | Optional [IEEE Xplore API](https://developer.ieee.org) key. Adds IEEE-native search filters (conference vs journal, early access, index terms) and patent citation counts.                          |
| `IEEE_MCP_EMAIL`             | Contact address sent to OpenAlex and doi.org, as they ask of API clients.                                                                                                                           |
| `IEEE_MCP_PROXY_DAILY_LIMIT` | Maximum PDFs fetched through the proxy per day. Default 40.                                                                                                                                         |
| `IEEE_MCP_DOWNLOAD_DIR`      | Where `download_pdf` saves files. Default `~/Downloads/ieee-papers`.                                                                                                                                |
| `IEEE_MCP_HOME`              | Data directory for the session, cache and browser profile. Default `~/.ieee-mcp`.                                                                                                                   |
| `IEEE_MCP_BROWSER`           | Browser executable for sign-in, if auto-detection picks the wrong one.                                                                                                                              |
| `IEEE_MCP_DEBUG`             | Set to `1` to log requests to stderr. Keys are redacted.                                                                                                                                            |

## Connect a client

Claude Code, available in every project:

```sh
claude mcp add ieee-xplore -s user \
  -e OPENALEX_API_KEY=your-key \
  -e IEEE_PROXY_URL=https://ieeexplore-ieee-org.tudelft.idm.oclc.org \
  -- ieee-xplore-mcp
```

Claude Desktop, Cursor and most other clients take the same JSON block (`claude_desktop_config.json`, `~/.cursor/mcp.json`, ...):

```json
{
  "mcpServers": {
    "ieee-xplore": {
      "command": "ieee-xplore-mcp",
      "env": {
        "OPENALEX_API_KEY": "your-key",
        "IEEE_PROXY_URL": "https://ieeexplore-ieee-org.tudelft.idm.oclc.org"
      }
    }
  }
}
```

VS Code, Codex and troubleshooting are covered in [docs/clients.md](docs/clients.md).

## Institutional access

If your university subscribes to IEEE Xplore through a proxy (EZproxy or OCLC), the server can read paywalled papers the way you would in a browser:

1. Set `IEEE_PROXY_URL` as above.
2. Run `ieee-xplore-mcp login`. A browser window opens on your library's sign-in page. Sign in as usual, including MFA. The window closes once IEEE Xplore loads.
3. `read_paper` and `download_pdf` now fetch PDFs through the proxy. When the proxy session expires, the server renews it silently from the saved browser profile; if your university asks for a password again, tools report `AUTH_REQUIRED` and you run `login` once more (or ask the assistant to use the `sign_in` tool).

Your library licence allows personal use and forbids systematic downloading. The server fetches one paper per request, spaces proxy downloads at least 10 seconds apart, caps them per day, and caches every paper so rereading costs nothing. It has no bulk download tool. Please keep it that way; excessive downloading can get your whole institution blocked.

## Tools

| Tool                 | What it does                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| `search_papers`      | Keyword, boolean or semantic search with author, venue, affiliation, year, type and OA filters. |
| `get_paper`          | Full metadata and abstract for a DOI, IEEE article number, Xplore URL or OpenAlex id.           |
| `get_citing_papers`  | Papers that cite a paper, sortable by citations or date.                                        |
| `get_references`     | A paper's reference list.                                                                       |
| `get_related_papers` | Closely related papers.                                                                         |
| `read_paper`         | Full text in chunks, from an open-access copy or the institutional proxy.                       |
| `download_pdf`       | Save one paper's PDF to disk.                                                                   |
| `cite_paper`         | BibTeX, RIS, CSL-JSON or formatted references for up to 50 papers.                              |
| `status`             | Which keys and access paths are configured and working.                                         |
| `sign_in`            | Open the proxy sign-in window.                                                                  |

There is also a `literature_review` prompt that walks the assistant through a structured survey of a topic. Input fields for every tool are listed in [docs/tools.md](docs/tools.md).

## Where the data comes from

| Source                                                         | Used for                                                                                 |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [OpenAlex](https://openalex.org), restricted to IEEE           | Search, metadata, abstracts, citations, references, related work, open-access locations. |
| [IEEE Xplore API](https://developer.ieee.org), if a key is set | Search with IEEE's own filters, IEEE index terms, patent citations.                      |
| doi.org                                                        | IEEE article numbers for DOIs, and citation formatting.                                  |
| Your institution's proxy                                       | PDFs of paywalled papers.                                                                |

Only documented public APIs are used for metadata; the server does not scrape IEEE Xplore pages. Every search result says which source answered. When the IEEE key is rejected (IEEE deactivates idle keys with `403 Developer Inactive`) or its daily quota is used up, the server switches to OpenAlex for the rest of the session and tells you.

Known limits without an IEEE key:

- OpenAlex files most IEEE conference proceedings as journals, so the conference/journal filter is only available with an IEEE key. Use `venue` to target a specific conference or journal.
- A bare IEEE article number can only be turned into metadata with an IEEE key. DOIs, Xplore URLs with a DOI, and OpenAlex ids work without one, and `read_paper` accepts article numbers either way.
- OpenAlex occasionally attaches another work's abstract or PDF to a record. Open-access PDFs are checked against the paper's title before use, and `get_paper` flags abstracts that do not match the title.

## Privacy

Everything runs locally; there is no hosted service. The proxy session cookies and the browser profile live under `~/.ieee-mcp` with owner-only permissions and never reach the model. Your password and MFA are only ever typed into your university's own sign-in page; decline if the sign-in window offers to save the password, since that profile is protected only by file permissions. `download_pdf` writes only inside your home directory, never into hidden folders, and never overwrites a file. `ieee-xplore-mcp logout` removes the session and profile; `ieee-xplore-mcp cache clear` removes cached papers.

## Upgrading from 1.x

2.0 is a rewrite. Tool names changed (`search_by_author` and `search_by_publication` are now filters of `search_papers`; `get_paper_details` is `get_paper`; `get_paper_citations` is `get_citing_papers`; `get_full_text` is `read_paper`), `IEEE_API_KEY` is optional, and `IEEE_AUTH_TOKEN` is replaced by institutional proxy access. See [CHANGELOG.md](CHANGELOG.md).

## Development

```sh
npm ci
npm run check          # typecheck, lint, tests, build
npm run dev -- status  # run the CLI from source
npm run test:live      # talk to the real services
```

Unit tests use recorded fixtures and a mocked `fetch`, so they run offline. The design is described in [docs/design.md](docs/design.md). Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Security issues go through [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE). Not affiliated with IEEE, OpenAlex or any university.
