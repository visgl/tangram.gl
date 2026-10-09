// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {build} from 'esbuild';
import {gzipSync} from 'node:zlib';

/** Renderer stays external to the layer entries; kernels are bundled only in the optional worker. */
const entries = [
  ['Normal layer entry', 'modules/tangram-layers/bundle.js', true],
  ['Experimental layer entry', 'modules/tangram-layers/experimental-projected-basemaps.js', true],
  ['Optional projection worker', 'modules/tangram-renderer/src/experimental/projected-basemaps-worker.ts', false]
];

console.log('| Entry | Minified | Gzip |');
console.log('| --- | ---: | ---: |');
for (const [label, entry, external] of entries) {
  const result = await build({entryPoints: [entry], bundle: true, minify: true, write: false,
    format: external ? 'esm' : 'iife', platform: 'browser', target: 'es2022', metafile: true,
    ...(external ? {packages: 'external'} : {})});
  const imports = Object.keys(result.metafile.inputs);
  if (external && imports.some(input => /@math\.gl\/projection\//.test(input))) {
    throw new Error(`${label} unexpectedly includes projection kernels`);
  }
  if (!external && imports.some(input => /@deck\.gl\//.test(input))) {
    throw new Error('Projection worker unexpectedly includes deck.gl');
  }
  if (!external && imports.some(input => /utils\/geo\.ts$/.test(input))) {
    throw new Error('Projection worker unexpectedly includes the full legacy Geo namespace');
  }
  const bytes = result.outputFiles[0].contents;
  console.log(`| ${label} | ${(bytes.length / 1000).toFixed(1)} KB | ${(gzipSync(bytes).length / 1000).toFixed(1)} KB |`);
}
