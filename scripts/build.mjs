// Build the CLI (Node bundle) and the web UI (browser bundle) with esbuild.
// Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'web'), { recursive: true });

await build({
  entryPoints: [join(root, 'src', 'cli.ts')],
  outfile: join(dist, 'cli.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  legalComments: 'none',
  // yaml is CommonJS; give it a require() inside the ESM bundle
  banner: { js: "import { createRequire as __latencylensRequire } from 'node:module'; const require = __latencylensRequire(import.meta.url);" },
  logLevel: 'warning',
});

await build({
  entryPoints: [join(root, 'web', 'src', 'main.ts')],
  outfile: join(dist, 'web', 'app.js'),
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  sourcemap: true,
  minify: true,
  logLevel: 'warning',
});
cpSync(join(root, 'web', 'index.html'), join(dist, 'web', 'index.html'));
cpSync(join(root, 'web', 'app.css'), join(dist, 'web', 'app.css'));
cpSync(join(root, 'web', 'favicon.svg'), join(dist, 'web', 'favicon.svg'));
console.log('built dist/cli.js and dist/web/');
