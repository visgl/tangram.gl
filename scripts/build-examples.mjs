// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {cp, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {build} from 'esbuild';
import {getOcularConfig} from '@vis.gl/dev-tools';

const repositoryDirectory = fileURLToPath(new URL('../', import.meta.url));
const configuration = await getOcularConfig({root: repositoryDirectory});
await rm(resolve(repositoryDirectory, 'examples/dist'), {recursive: true, force: true});

// These are browser applications, not externalized npm package entries. Resolve
// installed dependencies normally and share their code between lazy entrypoints.
const result = await build({
  absWorkingDir: repositoryDirectory,
  entryPoints: {
    deck: 'examples/deck/app.js',
    webxr: 'examples/webxr/standalone.js',
    projected: 'examples/projected/standalone.js'
  },
  outdir: 'examples/dist',
  chunkNames: 'chunks/[name]-[hash]',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'browser',
  target: configuration.bundle.target,
  minify: true,
  sourcemap: true,
  sourcesContent: false,
  metafile: true,
  logLevel: 'info'
});
for (const [path, output] of Object.entries(result.metafile.outputs)) {
  if (output.imports.some(dependency => dependency.external)) {
    throw new Error(`Browser application has unresolved module imports: ${path}`);
  }
}

// Keep the Git package's MIT notice with both the standalone apps and website.
const exampleRequire = createRequire(new URL('../examples/webxr/package.json', import.meta.url));
await cp(resolve(dirname(exampleRequire.resolve('thor.gl')), '../LICENSE'),
  resolve(repositoryDirectory, 'examples/dist/thor.LICENSE.txt'));
