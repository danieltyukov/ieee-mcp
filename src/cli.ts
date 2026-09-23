import { rm } from 'node:fs/promises';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { describeError, toSafeError } from './errors.js';
import { createServer } from './server.js';
import { collectStatus, formatStatus, TOOLS } from './tools.js';
import { VERSION } from './version.js';

const HELP = `ieee-xplore-mcp ${VERSION}

Usage: ieee-xplore-mcp [command]

Commands
  serve            Run the MCP server on stdio (default when no command is given)
  login            Sign in to your institution's proxy in a browser window (needs IEEE_PROXY_URL)
  logout           Remove the saved proxy session and browser profile
  status [--check] Show configuration; --check verifies the IEEE key and proxy session live
  tools            List the tools this server exposes
  cache clear      Delete cached PDFs and extracted text

Environment
  IEEE_API_KEY                 IEEE Xplore API key (optional)
  OPENALEX_API_KEY             OpenAlex API key (optional, free, recommended)
  IEEE_MCP_EMAIL               Contact address sent to OpenAlex and doi.org (optional)
  IEEE_PROXY_URL               Your institution's proxied IEEE Xplore URL, for full text
  IEEE_MCP_PROXY_DAILY_LIMIT   Maximum proxy PDF downloads per day (default 40)
  IEEE_MCP_DOWNLOAD_DIR        Where download_pdf saves files (default ~/Downloads/ieee-papers)
  IEEE_MCP_HOME                Data directory (default ~/.ieee-mcp)
  IEEE_MCP_BROWSER             Browser executable for sign-in instead of auto-detection
  IEEE_MCP_DEBUG               Log requests to stderr (keys are redacted)

Docs: https://github.com/danieltyukov/ieee-mcp
`;

const log = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

async function main(argv: string[]): Promise<void> {
  const [command = 'serve', ...rest] = argv;
  if (command === '--version' || command === '-v' || command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(HELP);
    return;
  }
  const config = loadConfig();
  switch (command) {
    case 'serve': {
      const ctx = createContext(config);
      const server = createServer(ctx);
      await server.connect(new StdioServerTransport());
      log(`ieee-xplore-mcp ${VERSION} running on stdio.`);
      return;
    }
    case 'login': {
      const ctx = createContext(config);
      const session = await ctx.signIn({ headless: false, log });
      process.stdout.write(`Signed in to ${session.origin}.\n`);
      return;
    }
    case 'logout': {
      await rm(config.sessionFile, { force: true });
      await rm(config.profileDir, { recursive: true, force: true });
      process.stdout.write('Removed the saved proxy session and browser profile.\n');
      return;
    }
    case 'status':
    case 'doctor': {
      const ctx = createContext(config);
      process.stdout.write(`${formatStatus(await collectStatus(ctx, rest.includes('--check')))}\n`);
      return;
    }
    case 'tools': {
      for (const tool of TOOLS) process.stdout.write(`${tool.name.padEnd(20)} ${tool.title}\n`);
      process.stdout.write(`\n${TOOLS.length} tools\n`);
      return;
    }
    case 'cache': {
      if (rest[0] !== 'clear') {
        process.stderr.write('Usage: ieee-xplore-mcp cache clear\n');
        process.exitCode = 2;
        return;
      }
      await rm(config.cacheDir, { recursive: true, force: true });
      process.stdout.write(`Cleared ${config.cacheDir}\n`);
      return;
    }
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
      process.exitCode = 2;
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const safe = toSafeError(error);
  process.stderr.write(`${safe.code}: ${safe.message}\n`);
  // The command line is the user's own terminal, so unexpected errors are shown in full.
  if (safe.code === 'INTERNAL_ERROR') process.stderr.write(`${describeError(error)}\n`);
  if (process.env.IEEE_MCP_DEBUG && error instanceof Error && error.stack)
    process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
