// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// The basemap-layers API reference has one source, the website copy in `docs/basemap-layers`.
// The package copy in `modules/basemap-layers/docs` is generated from it: run this script after
// an edit of the website copy, or with `--check` to verify that the copies agree.

import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The API reference pages: the website copy is the source of the package copy. */
export const BASEMAP_API_REFERENCE_PAGES = ['basemap-layer.md', 'map-style.md', 'map-style-loader.md'];

/** The path of a page in the website copy and in the package copy. */
export function getBasemapDocPaths(page) {
  return {
    source: `${ROOT}docs/basemap-layers/api-reference/${page}`,
    target: `${ROOT}modules/basemap-layers/docs/api-reference/${page}`
  };
}

/**
 * The package copy of a website page: an HTML comment in place of the MDX comment of the license
 * header, and without the website's live example.
 */
export function toPackageDoc(source) {
  return source
    .replace(/^\{\/\*\n([\s\S]*?)\n \*\/\}$/m, '<!--\n$1\n-->')
    .replace(/^import LayerLiveExample from '[^']+';\n\n/m, '')
    .replace(/^<LayerLiveExample [^>]*\/>\n\n/m, '');
}

function main() {
  const check = process.argv.includes('--check');
  const stale = [];
  for (const page of BASEMAP_API_REFERENCE_PAGES) {
    const {source, target} = getBasemapDocPaths(page);
    const expected = toPackageDoc(readFileSync(source, 'utf8'));
    if (readFileSync(target, 'utf8') !== expected) {
      stale.push(target);
      if (!check) writeFileSync(target, expected);
    }
  }
  if (check && stale.length > 0) {
    console.error(`Out of date, run node scripts/sync-basemap-docs.mjs:\n${stale.join('\n')}`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
