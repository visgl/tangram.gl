// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {cp, mkdir, readdir, rm} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = resolve(packageDirectory, 'dist');

await rm(outputDirectory, {recursive: true, force: true});
await mkdir(outputDirectory, {recursive: true});
for (const entry of await readdir(packageDirectory, {withFileTypes: true})) {
  if (entry.name === 'dist' || entry.name === 'scripts' || entry.name === 'package.json' || entry.name === '.ocularrc.js') {
    continue;
  }
  await cp(resolve(packageDirectory, entry.name), resolve(outputDirectory, entry.name), {
    recursive: true
  });
}
