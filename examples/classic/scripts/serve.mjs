// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {createServer} from 'node:http';
import {createReadStream, statSync} from 'node:fs';
import {extname, join, normalize, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const packageDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)));
const repositoryDirectory = resolve(packageDirectory, '../..');
const outputDirectory = resolve(packageDirectory, 'dist');
const rendererDirectory = resolve(repositoryDirectory, 'modules/tangram-renderer/dist');
const contentTypes = {'.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.ttf': 'font/ttf', '.yaml': 'text/yaml', '.zip': 'application/zip'};

createServer((request, response) => {
  const requestedPath = normalize(request.url?.split('?')[0] || '/').replace(/^\.\.(?:\/|\\|$)/, '');
  const fileRoot = requestedPath.startsWith('/modules/tangram-renderer/dist/') ? rendererDirectory : outputDirectory;
  const relativePath = requestedPath.startsWith('/modules/tangram-renderer/dist/') ?
    requestedPath.replace('/modules/tangram-renderer/dist/', '/') :
    requestedPath.replace('/examples/classic/', '/') || '/';
  const filePath = resolve(fileRoot, `.${relativePath === '/' ? '/index.html' : relativePath}`);
  if (!filePath.startsWith(`${fileRoot}/`)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const statistics = statSync(filePath);
    const resolvedPath = statistics.isDirectory() ? join(filePath, 'index.html') : filePath;
    response.setHeader('Content-Type', contentTypes[extname(resolvedPath)] || 'application/octet-stream');
    createReadStream(resolvedPath).pipe(response);
  } catch {
    response.writeHead(404).end('Not found');
  }
}).listen(8080, '127.0.0.1', () => {
  console.log('Classic Tangram playground: http://127.0.0.1:8080/');
});
