// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {build} from 'esbuild';
import {getOcularConfig} from '@vis.gl/dev-tools';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
const config = await getOcularConfig({root: resolve(packageDirectory, '../..')});

// Use Ocular's esbuild configuration, with the browser asset handling and
// code splitting needed by Monaco (not exposed by ocular-bundle alpha.8).
await build({
  absWorkingDir: packageDirectory,
  entryPoints: ['app/settings-panel.js'],
  outdir: 'dist/app',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'browser',
  minify: true,
  target: config.bundle.target,
  alias: config.aliases,
  loader: {'.ttf': 'file'},
  logLevel: 'info'
});
