import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';

export default defineConfig({
  test: {
    root: '.',
    include: ['test/**/*.test.js'],
  },
  // Mirror esbuild's text loader for .md so tests can import extractor.js
  // (which embeds prompts/extraction-batch.md). Without this, vite chokes
  // on markdown content during import analysis.
  plugins: [
    {
      name: 'md-text-loader',
      enforce: 'pre',
      load(id) {
        const real = id.split('?')[0];
        if (real.endsWith('.md')) {
          const content = readFileSync(real, 'utf8');
          return `export default ${JSON.stringify(content)};`;
        }
      },
    },
  ],
});
