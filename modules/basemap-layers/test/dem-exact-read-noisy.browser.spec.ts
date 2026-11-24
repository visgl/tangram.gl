// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {beforeAll, describe, expect, test} from 'vitest';
import {readPixelsWithCanvas} from '../src/dem-pixels';
import {decodeDemTile, loadDemTile} from '../src/hillshade-layer';
import {
  KNOWN_TILE_SIZE,
  MAPBOX,
  RAINIER_TILE_PATH,
  TERRARIUM,
  countVideoFrames,
  encodePng,
  fetchBlob,
  getKnownTileBytes,
  getMaxError,
  installCanvasNoise
} from './dem-pixel-fixtures';

// A browser that adds noise to canvas reads, as fingerprinting protection does: DEM tiles still
// decode to their exact elevations, through VideoFrame. The read method is chosen once per page,
// so the noise is installed before the first DEM tile of this file and kept for all of it.

let frames: {count: () => number};
let rainierImage: ImageBitmap;
let rainierExact: Float32Array;

beforeAll(async () => {
  const blob = await (await fetch(`/${RAINIER_TILE_PATH}`)).blob();
  rainierImage = await createImageBitmap(blob, {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none'
  });
  // The elevations of the recorded tile, read before the noise.
  const pixels = await readPixelsWithCanvas(rainierImage);
  const {width, height} = rainierImage;
  rainierExact = decodeDemTile(pixels, width, height, TERRARIUM).elevations;
  installCanvasNoise();
  frames = countVideoFrames();
});

describe('loadDemTile with canvas noise', () => {
  test('a canvas read would be wrong by up to 256 m', async () => {
    const pixels = await readPixelsWithCanvas(rainierImage);
    const noisy = decodeDemTile(pixels, rainierImage.width, rainierImage.height, TERRARIUM);
    const error = getMaxError(noisy.elevations, rainierExact);
    console.log(`R1 baseline: canvas read under noise, max elevation error ${error} m`);
    expect(error).toBeGreaterThan(0);
    expect(error).toBeLessThanOrEqual(256);
  });

  test.each([
    ['terrarium', TERRARIUM],
    ['mapbox', MAPBOX]
  ] as const)('decodes a known %s tile with no error', async (encoding, unpack) => {
    const bytes = getKnownTileBytes();
    const blob = await encodePng(bytes, KNOWN_TILE_SIZE);
    const before = frames.count();

    const tile = await loadDemTile('known://dem.png', unpack, {
      loadOptions: {fetch: fetchBlob(blob)}
    });

    const expected = decodeDemTile(bytes, KNOWN_TILE_SIZE, KNOWN_TILE_SIZE, unpack);
    const error = getMaxError(tile!.elevations, expected.elevations);
    console.log(`R1 metric: ${encoding} known tile under noise, max elevation error ${error} m`);
    expect(error).toBe(0);
    expect(frames.count()).toBeGreaterThan(before);
  });

  test('decodes a recorded Terrarium tile as a canvas without noise does', async () => {
    const response = await fetch(`/${RAINIER_TILE_PATH}`);
    const tile = await loadDemTile('known://rainier.png', TERRARIUM, {
      loadOptions: {fetch: fetchBlob(await response.blob())}
    });
    const error = getMaxError(tile!.elevations, rainierExact);
    console.log(`R1 metric: recorded Terrarium tile under noise, max elevation error ${error} m`);
    expect(error).toBe(0);
  });
});
