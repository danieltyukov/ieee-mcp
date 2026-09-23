# Connecting clients

The server speaks MCP over stdio. Every client needs the command (`ieee-xplore-mcp` after a global install) and, optionally, the environment variables from the [README](../README.md#configure).

If your client cannot find `ieee-xplore-mcp` (common for desktop apps started outside a shell, or with nvm), use absolute paths instead: `"command": "/path/to/node"` and `"args": ["/path/to/ieee-xplore-mcp/dist/cli.js"]`. `npm root -g` prints where global packages live and `which node` prints the node binary.

## Claude Code

```sh
claude mcp add ieee-xplore -s user \
  -e OPENALEX_API_KEY=your-key \
  -e IEEE_PROXY_URL=https://ieeexplore-ieee-org.tudelft.idm.oclc.org \
  -- ieee-xplore-mcp
```

`-s user` makes it available in every project. Check it with `claude mcp list`.

## Claude Desktop

Edit `claude_desktop_config.json` (Settings, Developer, Edit Config) and restart the app:

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

## Cursor

Same block in `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project).

## VS Code

`.vscode/mcp.json` in a workspace, or the user-level MCP configuration:

```json
{
  "servers": {
    "ieee-xplore": {
      "type": "stdio",
      "command": "ieee-xplore-mcp",
      "env": { "OPENALEX_API_KEY": "your-key" }
    }
  }
}
```

## Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.ieee-xplore]
command = "ieee-xplore-mcp"
env = { OPENALEX_API_KEY = "your-key", IEEE_PROXY_URL = "https://ieeexplore-ieee-org.tudelft.idm.oclc.org" }
```

## Troubleshooting

- `ieee-xplore-mcp status --check` shows which keys work and whether the proxy session is valid.
- `IEEE_MCP_DEBUG=1` logs every request to stderr, with keys redacted. Most clients show stderr in their MCP log.
- `RATE_LIMITED` from OpenAlex: set `OPENALEX_API_KEY`. Anonymous searches are throttled when OpenAlex is busy.
- `AUTH_REQUIRED`: run `ieee-xplore-mcp login`. The sign-in needs Chrome, Edge, Chromium or Brave; point `IEEE_MCP_BROWSER` at one if it is not found, or run `npx playwright-core install chromium`.
- `NO_FULL_TEXT` through the proxy: your library does not license that title. The error includes the proxied link so you can check in a browser.
- `IEEE_KEY_INVALID`: IEEE deactivates keys that go unused. Reactivate it at developer.ieee.org or remove `IEEE_API_KEY`; everything else keeps working.

## Finding your proxy URL

Open IEEE Xplore from your library's website (the database list or the library search), sign in if asked, and copy the address of the Xplore page. The host looks like one of these:

- `ieeexplore-ieee-org.<institution>.idm.oclc.org` (OCLC hosted EZproxy)
- `ieeexplore-ieee-org.<proxy host>` (EZproxy with hyphenated host names)
- `ieeexplore.ieee.org.<proxy host>` (EZproxy with dotted host names)

Any address on that host works as `IEEE_PROXY_URL`; only the `https://host` part is used. Universities that give access by IP range alone (on campus or over VPN) have no proxy URL; there, open-access papers work and paywalled full text needs the proxy route.
