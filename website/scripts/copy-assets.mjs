// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {cp, mkdir, rm} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {copyExampleAssets} from './copy-example-assets.mjs';

const websiteDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = resolve(websiteDirectory, '..');
const staticDirectory = resolve(websiteDirectory, 'static');

await rm(resolve(staticDirectory, 'examples'), {recursive: true, force: true});
await rm(resolve(staticDirectory, 'modules'), {recursive: true, force: true});
await mkdir(resolve(staticDirectory, 'examples'), {recursive: true});
await mkdir(resolve(staticDirectory, 'modules/tangram-renderer/dist'), {recursive: true});
await mkdir(resolve(staticDirectory, 'modules/tangram-layers/dist'), {recursive: true});
await mkdir(resolve(staticDirectory, 'modules/tangram-layers/dist/experimental'), {
  recursive: true
});

await copyExampleAssets(
  resolve(repositoryDirectory, 'examples/classic/dist'),
  resolve(staticDirectory, 'examples/classic')
);
await copyExampleAssets(
  resolve(repositoryDirectory, 'examples/deck'),
  resolve(staticDirectory, 'examples/deck')
);
await copyExampleAssets(
  resolve(repositoryDirectory, 'examples/webxr'),
  resolve(staticDirectory, 'examples/webxr')
);
await copyExampleAssets(resolve(repositoryDirectory, 'examples/projected'), resolve(staticDirectory, 'examples/projected'));
// .htm avoids the preview server's .html-to-clean-route redirect, which drops the base URL.
// No directory index can shadow a Docusaurus route.
await cp(resolve(repositoryDirectory, 'examples/projected/index.html'), resolve(staticDirectory, 'examples/projected/embed.htm'));
await cp(resolve(repositoryDirectory, 'modules/tangram-renderer/dist/projected-basemaps-worker.js'),
  resolve(staticDirectory, 'modules/tangram-renderer/dist/projected-basemaps-worker.js'));
await cp(resolve(repositoryDirectory, 'modules/tangram-layers/dist/experimental/projected-basemaps.js'),
  resolve(staticDirectory, 'modules/tangram-layers/dist/experimental/projected-basemaps.js'));
await cp(
  resolve(repositoryDirectory, 'modules/tangram-renderer/dist/tangram.debug.mjs'),
  resolve(staticDirectory, 'modules/tangram-renderer/dist/tangram.debug.mjs')
);
await cp(
  resolve(repositoryDirectory, 'modules/tangram-renderer/dist/loaders-gl-worker.js'),
  resolve(staticDirectory, 'modules/tangram-renderer/dist/loaders-gl-worker.js')
);
await cp(
  resolve(repositoryDirectory, 'modules/tangram-renderer/dist/tangram-style.schema.json'),
  resolve(staticDirectory, 'modules/tangram-renderer/dist/tangram-style.schema.json')
);
await cp(
  resolve(repositoryDirectory, 'modules/tangram-renderer/dist/index.js'),
  resolve(staticDirectory, 'modules/tangram-renderer/dist/index.js')
);
await cp(
  resolve(repositoryDirectory, 'modules/tangram-renderer/dist/core.js'),
  resolve(staticDirectory, 'modules/tangram-renderer/dist/core.js')
);
await cp(
  resolve(repositoryDirectory, 'modules/tangram-layers/dist/index.js'),
  resolve(staticDirectory, 'modules/tangram-layers/dist/index.js')
);
await cp(
  resolve(repositoryDirectory, 'modules/tangram-layers/dist/experimental/webxr.js'),
  resolve(staticDirectory, 'modules/tangram-layers/dist/experimental/webxr.js')
);
await cp(resolve(repositoryDirectory, 'robots.txt'), resolve(staticDirectory, 'robots.txt'));
