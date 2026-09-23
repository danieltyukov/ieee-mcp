import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    cli: 'src/cli.ts',
    'pdf-worker': 'src/fulltext/pdf-worker.js',
  },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
  minify: false,
  banner: { js: '#!/usr/bin/env node' },
  external: ['playwright-core', 'pdfjs-dist', 'zod', '@modelcontextprotocol/sdk'],
});
