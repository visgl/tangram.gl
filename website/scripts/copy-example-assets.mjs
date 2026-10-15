// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {cp} from 'node:fs/promises';
import {resolve} from 'node:path';

/** Copy example assets without shadowing the integrated Docusaurus route. */
export async function copyExampleAssets(sourceDirectory, destinationDirectory) {
  const standaloneEntry = resolve(sourceDirectory, 'index.html');
  await cp(sourceDirectory, destinationDirectory, {
    recursive: true,
    filter: sourcePath => resolve(sourcePath) !== standaloneEntry
  });
}
