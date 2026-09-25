// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {cp, mkdir, rm, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

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

await cp(
  resolve(repositoryDirectory, 'examples/classic/dist'),
  resolve(staticDirectory, 'examples/classic'),
  {
    recursive: true
  }
);
await cp(resolve(repositoryDirectory, 'examples/deck'), resolve(staticDirectory, 'examples/deck'), {
  recursive: true
});
await cp(
  resolve(repositoryDirectory, 'examples/webxr'),
  resolve(staticDirectory, 'examples/webxr'),
  {
    recursive: true
  }
);

const websiteExampleRedirect = (target) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="robots" content="noindex, nofollow, noarchive">
    <meta http-equiv="refresh" content="0;url=../${target}.html">
    <title>Tangram layers example</title>
  </head>
  <body>
    <p>Opening the integrated example…</p>
    <script>
      const targetUrl = new URL(window.location.href);
      targetUrl.pathname = targetUrl.pathname.replace(/\\/+$/, '') + '.html';
      targetUrl.search = window.location.search;
      targetUrl.hash = window.location.hash;
      window.location.replace(targetUrl.href);
    </script>
  </body>
</html>
`;

// Docusaurus owns the integrated `.html` route. Replace copied standalone
// entrypoints with redirects so `/examples/*/` cannot bypass the embedded page
// (and does not loop back to the same static directory).
await writeFile(
  resolve(staticDirectory, 'examples/classic/index.html'),
  websiteExampleRedirect('classic')
);
await writeFile(
  resolve(staticDirectory, 'examples/deck/index.html'),
  websiteExampleRedirect('deck')
);
await writeFile(
  resolve(staticDirectory, 'examples/webxr/index.html'),
  websiteExampleRedirect('webxr')
);
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
  resolve(repositoryDirectory, 'modules/tangram-layers/dist/index.js'),
  resolve(staticDirectory, 'modules/tangram-layers/dist/index.js')
);
await cp(
  resolve(repositoryDirectory, 'modules/tangram-layers/dist/experimental/webxr.js'),
  resolve(staticDirectory, 'modules/tangram-layers/dist/experimental/webxr.js')
);
await cp(resolve(repositoryDirectory, 'robots.txt'), resolve(staticDirectory, 'robots.txt'));
