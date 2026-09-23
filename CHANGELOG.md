# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.0] - 2026-09-23

A rewrite. 1.x depended entirely on an IEEE API key, which IEEE deactivates when idle (`403 Developer Inactive`), so every tool failed for most users.

### Added

- Works without any key: search, metadata, abstracts and the citation graph come from OpenAlex restricted to IEEE publications, article numbers from the doi.org handle API, citations from DOI content negotiation.
- Automatic fallback from the IEEE API to OpenAlex when the key is rejected or its daily quota is used up, with a notice in the result.
- Full text through the user's institutional proxy (EZproxy, OCLC): one-time browser sign-in with `ieee-xplore-mcp login`, silent renewal from the saved profile, PDFs fetched one at a time, spaced out and capped per day.
- Full text from open-access copies, checked against the paper's title before use, with text extracted by pdf.js in a worker and returned in chunks.
- New tools: `get_references`, `get_related_papers`, `download_pdf`, `cite_paper` (BibTeX, RIS, CSL-JSON, IEEE, APA, Chicago, Harvard, MLA), `status` and `sign_in`, plus a `literature_review` prompt.
- Semantic search (`semantic: true`), boolean queries, author matching over OpenAlex profiles, venue and affiliation filters, sorting by citations or date.
- Every tool accepts a DOI, an IEEE article number, any Xplore URL (proxied ones too) or an OpenAlex id.
- CLI commands `login`, `logout`, `status --check`, `tools` and `cache clear`.
- Test suite with recorded fixtures and an in-memory MCP server test, live tests, CI on Linux, macOS and Windows, and a release workflow.

### Changed

- `search_by_author` and `search_by_publication` are now the `author` and `venue` filters of `search_papers`.
- `get_paper_details` is `get_paper`; `get_paper_citations` is `get_citing_papers`; `get_full_text` is `read_paper`.
- `IEEE_API_KEY` is optional.

### Removed

- `IEEE_AUTH_TOKEN`. Paywalled full text now goes through the institutional proxy.

## [1.0.0] - 2026-02-21

- First release: six tools over the IEEE Xplore API.
