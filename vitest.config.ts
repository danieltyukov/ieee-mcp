import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: process.env.IEEE_MCP_LIVE ? [] : ['tests/live/**'],
    environment: 'node',
    // Tests that read a PDF start a worker that loads pdfjs from cold. That takes
    // about a second on Linux but has taken over 20 s on a busy Windows runner,
    // so the limit matches the 60 s extractPdf allows itself.
    testTimeout: 60_000,
    hookTimeout: 20_000,
  },
});
