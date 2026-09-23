# Tools

Generated from `src/tools.ts` by `npm run docs:tools`. Every `id` accepts a DOI, an IEEE article number, an IEEE Xplore URL (proxied ones too) or an OpenAlex id.

## search_papers

**Search IEEE papers** (read-only, uses the network)

Search IEEE Xplore content (journals, conferences, standards, books). `query` accepts keywords or a boolean query with AND, OR, NOT and "quoted phrases". Filters narrow by title, author, affiliation, venue, years, content type and open access. Set semantic=true to find conceptually related papers from a natural-language description; it ranks by meaning across all publishers and keeps the IEEE ones, so a page may hold only a few results (use page=2 or a keyword search for more). Returns identifiers you can pass to the other tools.

| Parameter          | Type                                                                              | Required | Default       | Description                                                                 |
| ------------------ | --------------------------------------------------------------------------------- | -------- | ------------- | --------------------------------------------------------------------------- |
| `query`            | string                                                                            | no       |               | Keywords or boolean query, e.g. "delta-sigma" AND (temperature OR thermal). |
| `title`            | string                                                                            | no       |               | Words that must appear in the title.                                        |
| `author`           | string                                                                            | no       |               | Author name, e.g. "Kofi Makinwa".                                           |
| `affiliation`      | string                                                                            | no       |               | Author affiliation, e.g. "Delft University of Technology".                  |
| `venue`            | string                                                                            | no       |               | Journal or conference name, e.g. "IEEE Journal of Solid-State Circuits".    |
| `keywords`         | string                                                                            | no       |               | Index terms or keywords.                                                    |
| `year_from`        | integer (1800-2100)                                                               | no       |               | Earliest publication year.                                                  |
| `year_to`          | integer (1800-2100)                                                               | no       |               | Latest publication year.                                                    |
| `content_type`     | `journal`, `conference`, `magazine`, `book`, `standard`, `early_access`, `course` | no       |               | Restrict to one content type.                                               |
| `open_access_only` | boolean                                                                           | no       |               | Only open-access papers.                                                    |
| `semantic`         | boolean                                                                           | no       | `false`       | Embedding search on OpenAlex for conceptual matches; needs `query`.         |
| `sort`             | `relevance`, `citations`, `newest`, `oldest`                                      | no       | `"relevance"` | Result order. "citations" sorts by citation count.                          |
| `limit`            | integer (1-50)                                                                    | no       | `10`          | Results per page (1-50).                                                    |
| `page`             | integer (1-500)                                                                   | no       | `1`           | Page number, starting at 1.                                                 |

## get_paper

**Get paper details** (read-only, uses the network)

Full metadata for one paper: authors with affiliations, venue, date, identifiers, citation counts, open-access status, keywords, links and the abstract.

| Parameter | Type   | Required | Default | Description                                                                                            |
| --------- | ------ | -------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `id`      | string | yes      |         | DOI (10.1109/...), IEEE article number, IEEE Xplore URL (proxied URLs work too) or OpenAlex id (W...). |

## get_citing_papers

**Papers citing a paper** (read-only, uses the network)

Papers that cite the given paper (forward citations), from OpenAlex. Sorted by citation count unless asked otherwise.

| Parameter   | Type                                         | Required | Default       | Description                                                                                            |
| ----------- | -------------------------------------------- | -------- | ------------- | ------------------------------------------------------------------------------------------------------ |
| `id`        | string                                       | yes      |               | DOI (10.1109/...), IEEE article number, IEEE Xplore URL (proxied URLs work too) or OpenAlex id (W...). |
| `ieee_only` | boolean                                      | no       | `false`       | Only citing papers published by IEEE.                                                                  |
| `sort`      | `relevance`, `citations`, `newest`, `oldest` | no       | `"citations"` | Result order. "citations" sorts by citation count.                                                     |
| `limit`     | integer (1-50)                               | no       | `10`          | Results per page (1-50).                                                                               |
| `page`      | integer (1-500)                              | no       | `1`           | Page number, starting at 1.                                                                            |

## get_references

**References of a paper** (read-only, uses the network)

The reference list of a paper (backward citations), from OpenAlex, in stored order.

| Parameter | Type            | Required | Default | Description                                                                                            |
| --------- | --------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `id`      | string          | yes      |         | DOI (10.1109/...), IEEE article number, IEEE Xplore URL (proxied URLs work too) or OpenAlex id (W...). |
| `limit`   | integer (1-100) | no       | `25`    | Results per page (1-100).                                                                              |
| `page`    | integer (1-500) | no       | `1`     | Page number, starting at 1.                                                                            |

## get_related_papers

**Related papers** (read-only, uses the network)

Papers OpenAlex considers closely related to the given one (shared concepts and citations).

| Parameter   | Type           | Required | Default | Description                                                                                            |
| ----------- | -------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `id`        | string         | yes      |         | DOI (10.1109/...), IEEE article number, IEEE Xplore URL (proxied URLs work too) or OpenAlex id (W...). |
| `ieee_only` | boolean        | no       | `false` | Only related papers published by IEEE.                                                                 |
| `limit`     | integer (1-50) | no       | `10`    | Results per page (1-50).                                                                               |

## read_paper

**Read full text** (read-only, uses the network)

Full text of a paper, from an open-access copy or through the configured institutional proxy. Long papers come in chunks: pass the returned next offset to continue. Text is cached, so rereading is free.

| Parameter   | Type                         | Required | Default | Description                                                                                            |
| ----------- | ---------------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `id`        | string                       | yes      |         | DOI (10.1109/...), IEEE article number, IEEE Xplore URL (proxied URLs work too) or OpenAlex id (W...). |
| `offset`    | integer (0-9007199254740991) | no       | `0`     | Character offset to start from (0 for the beginning).                                                  |
| `max_chars` | integer (2000-100000)        | no       | `30000` | Maximum characters to return.                                                                          |

## download_pdf

**Save PDF** (writes, uses the network)

Save the PDF of one paper to disk (open-access copy or institutional proxy) and return the file path. One paper per call; bulk downloading is against publisher licences.

| Parameter   | Type   | Required | Default | Description                                                                                                                                                  |
| ----------- | ------ | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`        | string | yes      |         | DOI (10.1109/...), IEEE article number, IEEE Xplore URL (proxied URLs work too) or OpenAlex id (W...).                                                       |
| `directory` | string | no       |         | Absolute directory inside your home folder to save into. Defaults to IEEE_MCP_DOWNLOAD_DIR or ~/Downloads/ieee-papers. Existing files are never overwritten. |

## cite_paper

**Format citations** (read-only, uses the network)

Citations for one or more papers, via DOI content negotiation: BibTeX, RIS, CSL-JSON, or formatted IEEE, APA, Chicago, Harvard or MLA references.

| Parameter | Type                                                                    | Required | Default    | Description                                               |
| --------- | ----------------------------------------------------------------------- | -------- | ---------- | --------------------------------------------------------- |
| `ids`     | array of string                                                         | yes      |            | Paper ids (DOI, IEEE article number or URL, OpenAlex id). |
| `format`  | `bibtex`, `ris`, `csl-json`, `ieee`, `apa`, `chicago`, `harvard`, `mla` | no       | `"bibtex"` | Citation format.                                          |

## status

**Configuration status** (read-only, uses the network)

Which data sources and access paths are configured: IEEE API key, OpenAlex key, institutional proxy sign-in and today's proxy downloads. check=true also verifies the IEEE key and proxy session live.

| Parameter | Type    | Required | Default | Description                                               |
| --------- | ------- | -------- | ------- | --------------------------------------------------------- |
| `check`   | boolean | no       | `false` | Verify the IEEE key and proxy session with live requests. |

## sign_in

**Sign in to institutional proxy** (writes, uses the network)

Open a browser window on this computer for the user to sign in to their institution's proxy (IEEE_PROXY_URL). Only use when the user asks to sign in, or after read_paper reported AUTH_REQUIRED and the user agrees. Waits until sign-in finishes.

No parameters.
