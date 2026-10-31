import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string };

export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  shims: false,
  banner: { js: '#!/usr/bin/env node' },
  define: { __GHCARD_VERSION__: JSON.stringify(version) },
});
