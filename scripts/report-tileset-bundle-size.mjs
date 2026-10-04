// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {build} from 'esbuild';
import {gzipSync} from 'node:zlib';

/** These boundaries have different ownership policies; sizes do not imply substitutability. */
const candidates = [
  ['Tangram mesh tileset', {entryPoints: ['modules/tangram-renderer/src/tile/tangram_tileset_2d.ts']}],
  ['Published decoded Tileset2D', {stdin: {contents: "export {Tileset2D} from '@loaders.gl/tiles';", resolveDir: process.cwd()}}],
  ['loaders-backed candidate with adapter', {entryPoints: ['modules/tangram-renderer/test/helpers/loaders_tileset_candidate.ts']}]
];

console.log('| Boundary | Minified | Gzip |');
console.log('| --- | ---: | ---: |');
for (const [name, entry] of candidates) {
  const result = await build({...entry, bundle: true, minify: true, platform: 'browser',
    format: 'esm', target: 'es2022', write: false, metafile: true});
  const retainedInputs = Object.values(result.metafile.outputs).flatMap(output =>
    Object.entries(output.inputs).filter(([, contribution]) => contribution.bytesInOutput > 0).map(([path]) => path));
  if (name !== 'Tangram mesh tileset' && retainedInputs.some(path =>
    /@loaders\.gl\/tiles\/.*(?:tileset-3d|point-cloud|spatial)\//.test(path))) {
    throw new Error('Decoded tileset probe unexpectedly retains 3D/spatial code');
  }
  const bytes = result.outputFiles[0].contents;
  console.log(`| ${name} | ${(bytes.length / 1000).toFixed(3)} KB | ${(gzipSync(bytes).length / 1000).toFixed(3)} KB |`);
}
