// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {mkdir} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import esbuild from 'esbuild';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = resolve(packageDirectory, 'dist');

await mkdir(outputDirectory, {recursive: true});
await esbuild.build({
  entryPoints: [resolve(packageDirectory, 'src/experimental/loaders-gl-worker.ts')],
  outfile: resolve(outputDirectory, 'loaders-gl-worker.js'),
  bundle: true,
  format: 'iife',
  globalName: 'TangramLoadersGL',
  platform: 'browser',
  target: ['chrome110', 'firefox110', 'safari15'],
  sourcemap: true,
  sourcesContent: false,
  minify: true,
  logLevel: 'info'
});
