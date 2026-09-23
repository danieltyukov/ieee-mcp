import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: process.env.IEEE_MCP_LIVE ? [] : ['tests/live/**'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
