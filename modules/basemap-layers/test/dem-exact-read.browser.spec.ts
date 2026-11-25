// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, describe, expect, test, vi} from 'vitest';
import {decodeDemTile, loadDemTile} from '../src/hillshade-layer';
import {
  KNOWN_TILE_SIZE,
  MAPBOX,
  TERRARIUM,
  countVideoFrames,
  encodePng,
  fetchBlob,
  getKnownTileBytes,
  getMaxError
} from './dem-pixel-fixtures';

// Where canvas reads are exact, DEM tiles decode to their exact elevations through the canvas, as
// before, and no VideoFrame is made. See dem-exact-read-noisy for a browser that adds noise.

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('loadDemTile with exact canvas reads', () => {
  test.each([
    ['terrarium', TERRARIUM],
    ['mapbox', MAPBOX]
  ] as const)('decodes a known %s tile with no error', async (_, unpack) => {
    const frames = countVideoFrames();
    const bytes = getKnownTileBytes();
    const blob = await encodePng(bytes, KNOWN_TILE_SIZE);

    const tile = await loadDemTile('known://dem.png', unpack, {
      loadOptions: {fetch: fetchBlob(blob)}
    });

    const expected = decodeDemTile(bytes, KNOWN_TILE_SIZE, KNOWN_TILE_SIZE, unpack);
    expect(tile!.dim).toBe(KNOWN_TILE_SIZE);
    expect(getMaxError(tile!.elevations, expected.elevations)).toBe(0);
    expect(frames.count()).toBe(0);
  });

  test('decodes sea level as 0 m in both encodings', async () => {
    // Terrarium: 128·256 − 32768. Mapbox: (1·65536 + 134·256 + 160)·0.1 − 10000.
    const pixels = (r: number, g: number, b: number) =>
      new Uint8ClampedArray(Array.from({length: 4}, () => [r, g, b, 255]).flat());
    for (const [unpack, bytes] of [
      [TERRARIUM, pixels(128, 0, 0)],
      [MAPBOX, pixels(1, 134, 160)]
    ] as const) {
      const blob = await encodePng(bytes as Uint8ClampedArray<ArrayBuffer>, 2);
      const tile = await loadDemTile('known://sea.png', unpack, {
        loadOptions: {fetch: fetchBlob(blob)}
      });
      expect(Array.from(tile!.elevations)).toEqual([0, 0, 0, 0]);
    }
  });
});
