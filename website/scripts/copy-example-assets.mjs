// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {cp, stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {MATH_BROWSER_ASSETS} from '../../examples/browser-dependencies/math-assets.mjs';

/** Copy example assets without shadowing the integrated Docusaurus route. */
export async function copyExampleAssets(sourceDirectory, destinationDirectory) {
  const standaloneEntry = resolve(sourceDirectory, 'index.html');
  await cp(sourceDirectory, destinationDirectory, {
    recursive: true,
    filter: sourcePath => resolve(sourcePath) !== standaloneEntry
  });
}

/** Validate the complete generated math graph and notices before publishing any assets. */
export async function copyBrowserMathAssets(sourceDirectory, destinationDirectory) {
  for (const filename of [...Object.values(MATH_BROWSER_ASSETS), 'THIRD-PARTY-NOTICES.txt']) {
    const metadata = await stat(resolve(sourceDirectory, filename));
    if (!metadata.isFile() || !metadata.size) throw new Error(`Missing or empty browser math asset: ${filename}`);
  }
  await cp(sourceDirectory, destinationDirectory, {recursive: true});
}
