// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** The Terrarium tiles of the AWS Terrain Tiles open data set. They hold land and seabed heights. */
export const TERRARIUM_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

/** The highest zoom at which the Terrarium tiles hold seabed heights. Above it, the sea is at 0 m. */
export const TERRARIUM_MAX_ZOOM = 10;

/** The tile URL template of the depth tint. `fetchDepthTint` answers requests for these URLs. */
export const DEPTH_TINT_TILES = 'https://depth-tint.invalid/{z}/{x}/{y}.png';

const DEPTH_TINT_URL = /^https:\/\/depth-tint\.invalid\/(\d+)\/(\d+)\/(\d+)\.png$/;

/** The side of a Terrarium tile, in pixels. */
const TILE_SIZE = 256;

/** The depth interval between two isobaths, in meters. */
const ISOBATH_INTERVAL = 500;

/** The colors of the depth tint, as `[depth in meters, red, green, blue]`, from shallow to deep. */
const DEPTH_COLORS: [number, number, number, number][] = [
  [0, 186, 230, 238],
  [60, 142, 210, 230],
  [200, 98, 178, 218],
  [800, 62, 134, 196],
  [2000, 44, 98, 168],
  [4000, 30, 62, 128]
];

/** deck.gl's `elevationDecoder` of Terrarium tiles, with the heights multiplied by `exaggeration`. */
export function getTerrariumDecoder(exaggeration: number) {
  return {
    rScaler: 256 * exaggeration,
    gScaler: exaggeration,
    bScaler: exaggeration / 256,
    offset: -32768 * exaggeration
  };
}

/** The height of a Terrarium pixel, in meters. */
export function decodeTerrarium(red: number, green: number, blue: number): number {
  return red * 256 + green + blue / 256 - 32768;
}

/** The color of the depth tint at `depth` meters below sea level, as `[red, green, blue]`. */
export function getDepthColor(depth: number): [number, number, number] {
  const last = DEPTH_COLORS[DEPTH_COLORS.length - 1];
  for (let i = 1; i < DEPTH_COLORS.length; i++) {
    const [depth0, ...color0] = DEPTH_COLORS[i - 1];
    const [depth1, ...color1] = DEPTH_COLORS[i];
    if (depth <= depth1) {
      const t = Math.max(0, (depth - depth0) / (depth1 - depth0));
      return [
        color0[0] + (color1[0] - color0[0]) * t,
        color0[1] + (color1[1] - color0[1]) * t,
        color0[2] + (color1[2] - color0[2]) * t
      ];
    }
  }
  return [last[1], last[2], last[3]];
}

/**
 * Writes the depth tint of a Terrarium tile into `pixels`, in place. The land is transparent. The
 * seabed has the color of its depth, with a darker line at each isobath.
 */
export function tintDepth(pixels: Uint8ClampedArray, size: number): void {
  const depths = new Float32Array(size * size);
  for (let i = 0; i < depths.length; i++) {
    depths[i] = -decodeTerrarium(pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2]);
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const depth = depths[i];
      if (depth <= 0) {
        pixels[i * 4 + 3] = 0;
        continue;
      }
      const band = Math.floor(depth / ISOBATH_INTERVAL);
      const right = depths[y * size + Math.min(x + 1, size - 1)];
      const below = depths[Math.min(y + 1, size - 1) * size + x];
      const isIsobath =
        Math.floor(right / ISOBATH_INTERVAL) !== band || Math.floor(below / ISOBATH_INTERVAL) !== band;
      const shade = isIsobath && right > 0 && below > 0 ? 0.82 : 1;
      const [red, green, blue] = getDepthColor(depth);
      pixels[i * 4] = red * shade;
      pixels[i * 4 + 1] = green * shade;
      pixels[i * 4 + 2] = blue * shade;
      // The tint comes in over the first meters of depth: the shore of the style stays sharp.
      pixels[i * 4 + 3] = 255 * Math.min(1, depth / 4);
    }
  }
}

/**
 * A `fetch` for `BasemapLayer`'s `loadOptions`. It answers a request for a `DEPTH_TINT_TILES` URL
 * with a PNG that it makes from the Terrarium tile at the same position. Other requests go to
 * the network.
 */
export const fetchDepthTint: typeof fetch = async (input, init) => {
  const match = typeof input === 'string' ? DEPTH_TINT_URL.exec(input) : null;
  if (!match) {
    return fetch(input, init);
  }
  const [, z, x, y] = match;
  const url = TERRARIUM_TILES.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  const response = await fetch(url, {signal: init?.signal});
  if (!response.ok) {
    return response;
  }
  // The pixels are heights, not colors: the browser must not change them.
  const bitmap = await createImageBitmap(await response.blob(), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none'
  });
  const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
  const context = canvas.getContext('2d', {willReadFrequently: true});
  if (!context) {
    throw new Error('The depth tint needs a 2D canvas context');
  }
  context.drawImage(bitmap, 0, 0, TILE_SIZE, TILE_SIZE);
  bitmap.close();
  const image = context.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
  tintDepth(image.data, TILE_SIZE);
  context.putImageData(image, 0, 0);
  return new Response(await canvas.convertToBlob({type: 'image/png'}), {
    headers: {'Content-Type': 'image/png'}
  });
};
