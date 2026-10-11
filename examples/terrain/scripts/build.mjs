// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {getOcularConfig} from '@vis.gl/dev-tools';

const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const configuration = await getOcularConfig({root: repositoryDirectory});
const external = ['@deck.gl/core', '@deck.gl/geo-layers', '@luma.gl/core', '@luma.gl/webgpu', '@vis.gl/tangram-renderer'];

// ocular-bundle's package ESM preset externalizes all npm imports. This browser
// application instead bundles its parsers and only externalizes the import map.
const result = await build({
  absWorkingDir: repositoryDirectory,
  entryPoints: ['examples/terrain/standalone.ts'],
  outfile: 'examples/terrain/dist/app.js',
  bundle: true, format: 'esm', platform: 'browser', minify: true,
  target: configuration.bundle.target, external,
  sourcemap: true, sourcesContent: false, metafile: true, logLevel: 'info'
});
for (const output of Object.values(result.metafile.outputs)) {
  for (const dependency of output.imports) {
    if (dependency.external && !external.some(name => dependency.path === name || dependency.path.startsWith(`${name}/`))) {
      throw new Error(`Terrain browser bundle has an unresolved import: ${dependency.path}`);
    }
  }
}
if (Object.keys(result.metafile.inputs).some(path => path.startsWith('modules/tangram-renderer/'))) {
  throw new Error('Terrain browser bundle unexpectedly embeds the renderer');
}
