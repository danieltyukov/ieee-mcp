# Contributing

Thanks for helping with ieee-xplore-mcp. This page covers the setup, how the code is organised, how to add a tool, and what to check before opening a pull request.

## Setup

You need Node 20 or newer (the project is developed on Node 22, see `.nvmrc`) and git.

```sh
git clone https://github.com/danieltyukov/ieee-mcp.git
cd ieee-mcp
npm ci
npm run check
```

`npm run check` runs the typecheck, the linter, the unit tests and the build. Use `npm run dev -- <command>` to run the CLI from source, for example `npm run dev -- status`.

## Tests

Unit tests live in `tests/` and use recorded fixtures with a mocked `fetch`. They run offline and must stay that way. `tests/server.test.ts` drives the real MCP server over an in-memory transport, so a new tool is covered end to end by adding a case there.

`npm run test:live` runs `tests/live/` against the real services. Search tests need `OPENALEX_API_KEY`; proxy tests need `IEEE_PROXY_URL` and a signed-in session. Live tests never run in CI.

## Layout

The design and the reasons behind it are in [docs/design.md](docs/design.md). In short:

- `src/sources/`: one client per documented API (IEEE Xplore, OpenAlex, doi.org). They map responses into the shared `Paper` type in `src/types.ts`.
- `src/library.ts`: chooses a source, falls back from IEEE to OpenAlex, resolves any paper id.
- `src/fulltext/`: finds a PDF (cache, open access, proxy), checks it is the right paper, extracts text in a worker.
- `src/proxy/`: institutional proxy sign-in, cookies, and the rate-limited PDF client.
- `src/tools.ts` and `src/server.ts`: MCP tool definitions and server assembly. `src/format.ts` renders results for the model.

## Adding a tool

1. Add a definition to `TOOLS` in `src/tools.ts`: a name, a title, a description written for the model, a zod input shape and an annotation constant. Say what the tool returns and when not to call it.
2. Keep service logic in `src/library.ts` or a source client; the tool only validates input, calls the service and formats the result.
3. Add fixture tests, and a case in `tests/server.test.ts`.
4. Run `npm run docs:tools` so `docs/tools.md` matches.

## Ground rules

- Metadata comes from documented public APIs only. Do not add scraping of IEEE Xplore pages or its internal endpoints.
- Full text is fetched one paper per request. Do not add bulk or batch download features; institutional licences forbid systematic downloading.
- Never let cookies, API keys or upstream response bodies reach tool output or error messages.
- Fixtures must not contain session material or personal data. Recorded API responses about published papers are fine.

## Commits and pull requests

Commits follow the conventional commit format (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`, `ci:`), with a subject under 72 characters that describes the change. Formatting is enforced by Prettier (`npm run format`) and ESLint. No emojis in code, comments, docs or commit messages.

Before opening a pull request:

- `npm run check` passes locally.
- New code has a fixture test that runs offline.
- `docs/tools.md` is regenerated if tools changed, and README or docs are updated if behaviour changed.
- `CHANGELOG.md` has an entry under Unreleased for user-visible changes.

Questions and ideas are welcome in GitHub issues.
