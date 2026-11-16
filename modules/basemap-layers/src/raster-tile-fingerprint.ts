// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {RejectRasterTile} from './raster-tile-loader';

/** The SHA-256 digest of the bytes of a raster tile, in hexadecimal. */
export async function getRasterTileFingerprint(arrayBuffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', arrayBuffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Creates a `rejectRasterTile` function that matches the tiles whose bytes have one of
 * `fingerprints` (see {@link getRasterTileFingerprint}): the placeholder images of a tile service,
 * which are the same bytes for every tile without data. `fingerprints` can be a promise, for
 * fingerprints that are measured at run time from a tile that is known to have no data. A promise
 * that rejects matches no tile.
 */
export function createRasterTileFingerprintFilter(
  fingerprints: Iterable<string> | Promise<Iterable<string>>
): RejectRasterTile {
  const known = Promise.resolve(fingerprints).then(
    values => new Set(values),
    () => new Set<string>()
  );
  return async ({arrayBuffer}) => {
    const set = await known;
    return set.has(await getRasterTileFingerprint(arrayBuffer));
  };
}
