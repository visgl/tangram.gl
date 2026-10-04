// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {build} from 'esbuild';
import {gzipSync} from 'node:zlib';

/** Comparable browser bundles include each Tangram compatibility adapter and all its imports. */
const candidates = [
  ['Legacy YAML', 'modules/tangram-renderer/src/procedures/scene-yaml-legacy.ts'],
  ['loaders.gl YAML', 'modules/tangram-renderer/src/procedures/scene-yaml-loaders.ts'],
  ['Legacy MVT', 'modules/tangram-renderer/src/procedures/mvt-legacy.ts'],
  ['loaders.gl lightweight MVT', 'modules/tangram-renderer/src/procedures/mvt-loaders.ts']
];

console.log('| Parser with adapter | Minified | Gzip |');
console.log('| --- | ---: | ---: |');
for (const [name, entry] of candidates) {
  const result = await build({entryPoints: [entry], bundle: true, minify: true, platform: 'browser',
    format: 'esm', target: 'es2022', write: false, metafile: true});
  if (name.includes('lightweight') && Object.keys(result.metafile.inputs).some(path =>
    /apache-arrow|@loaders\.gl\/(arrow|schema-utils|gis)\/|@loaders\.gl\/mvt\/dist\/bundled\.js/.test(path))) {
    throw new Error('Lightweight MVT parser unexpectedly includes Arrow/binary conversion code');
  }
  const bytes = result.outputFiles[0].contents;
  console.log(`| ${name} | ${(bytes.length / 1000).toFixed(1)} KB | ${(gzipSync(bytes).length / 1000).toFixed(1)} KB |`);
}
