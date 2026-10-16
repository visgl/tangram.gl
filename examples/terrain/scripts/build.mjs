// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {getOcularConfig} from '@vis.gl/dev-tools';

const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const configuration = await getOcularConfig({root: repositoryDirectory});

// The dedicated decoder contains CPU helpers only and has no import-map/CDN dependency.
const worker = await build({absWorkingDir: repositoryDirectory,
  entryPoints: ['examples/terrain/terrain-worker.ts'], outfile: 'examples/terrain/dist/terrain-worker.js',
  bundle: true, format: 'esm', platform: 'browser', minify: true, target: configuration.bundle.target,
  alias: {'@vis.gl/tangram-renderer/map-logic': resolve(repositoryDirectory, 'modules/tangram-renderer/src/map-logic/index.ts')},
  sourcemap: true, sourcesContent: false, metafile: true, logLevel: 'info'});
for (const [path, output] of Object.entries(worker.metafile.outputs)) {
  if (output.imports.some(dependency => dependency.external)) throw new Error(`Terrain worker has unresolved imports: ${path}`);
}
if (Object.keys(worker.metafile.inputs).some(path => /modules\/tangram-renderer\/src\/(scene|styles|gl|renderer)\//.test(path) || /node_modules\/@deck\.gl\//.test(path))) {
  throw new Error('Terrain worker unexpectedly embeds drawing or scene infrastructure');
}

// Unlike a published library entry, the standalone browser app bundles its npm
// dependencies. The website imports the same source through Docusaurus instead.
const result = await build({
  absWorkingDir: repositoryDirectory,
  entryPoints: ['examples/terrain/standalone.ts'],
  outfile: 'examples/terrain/dist/app.js',
  bundle: true, format: 'esm', platform: 'browser', minify: true,
  target: configuration.bundle.target,
  sourcemap: true, sourcesContent: false, metafile: true, logLevel: 'info'
});
for (const output of Object.values(result.metafile.outputs)) {
  for (const dependency of output.imports) {
    if (dependency.external) {
      throw new Error(`Terrain browser bundle has an unresolved import: ${dependency.path}`);
    }
  }
}
