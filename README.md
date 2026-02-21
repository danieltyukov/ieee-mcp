# IEEE Xplore MCP Server

MCP server that wraps the [IEEE Xplore API](https://developer.ieee.org/), letting you search and retrieve academic papers from Claude Code.

## Setup

1. Get a free API key at https://developer.ieee.org
2. Install and build:

```bash
npm install
npm run build
```

3. Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "ieee-xplore": {
      "command": "node",
      "args": ["/home/danieltyukov/workspace/personal/ieee-mcp/dist/index.js"],
      "env": {
        "IEEE_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `IEEE_API_KEY` | Yes | API key from developer.ieee.org |
| `IEEE_AUTH_TOKEN` | No | Auth token for paywalled full-text access |

## Tools

| Tool | Description |
|---|---|
| `search_papers` | Full-text search with Boolean operators and filters (author, year, content type, etc.) |
| `get_paper_details` | Get verbose metadata for a paper by article number or DOI |
| `get_paper_citations` | Get citation counts (papers + patents) for a paper |
| `get_full_text` | Retrieve full text (Open Access or with auth token) |
| `search_by_author` | Search papers by author name |
| `search_by_publication` | Search papers within a journal or conference |

## Rate Limits

The free IEEE API tier allows ~200 calls/day with up to 200 results per call.
