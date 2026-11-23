// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * Writes the PMTiles fixtures of the `pmtiles://` source tests, and the same tiles as plain
 * `{z}/{x}/{y}` files, from synthetic data. Run from the repository root:
 *
 *   node modules/basemap-layers/test/fixtures/pmtiles/generate.mjs
 *
 * Each archive holds the five tiles of zooms 0 and 1, packaged with the PMTiles v3 writer of
 * `@loaders.gl/tiles/pmtiles`:
 *
 * - `vector.pmtiles`: MVT tiles, each with one box polygon in the source layer `shapes` and its
 *   zoom in the property `z`. Tiles and directories are gzip-compressed, as in a Protomaps
 *   basemap; `tiles/vector/` holds the uncompressed tiles.
 * - `raster.pmtiles`: 256 pixel PNG tiles of four colored quadrants, a color per tile.
 * - `dem.pmtiles`: 32 pixel terrarium-encoded PNG elevation tiles of one smooth peak, in whole
 *   meters.
 *
 * The output is deterministic: running the script again writes the same bytes.
 */

import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {encodePMTiles} from '@loaders.gl/tiles/pmtiles';
import {PNG} from 'pngjs';

const OUTPUT = dirname(fileURLToPath(import.meta.url));
/** Bounds written to every archive header, distinct from the tile footprints. */
const BOUNDS = [-170, -80, 170, 80];
const TILE_INDICES = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [1, 0, 1],
  [1, 1, 1]
];

/** Appends `value` to `out` as a protobuf varint. */
function writeVarint(out, value) {
  while (value > 127) {
    out.push((value & 127) | 128);
    value >>>= 7;
  }
  out.push(value);
}

function writeBytes(out, field, bytes) {
  writeVarint(out, (field << 3) | 2);
  writeVarint(out, bytes.length);
  out.push(...bytes);
}

function writeVarintField(out, field, value) {
  writeVarint(out, field << 3);
  writeVarint(out, value);
}

/** An MVT tile with one box polygon, `[left, top, right, bottom]` in tile units, and `z`. */
function encodeBoxTile([left, top, right, bottom], z) {
  const ring = [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom]
  ];
  const zigzag = value => (value << 1) ^ (value >> 31);
  const geometry = [];
  let cursor = [0, 0];
  ring.forEach(([x, y], index) => {
    if (index === 0) geometry.push((1 << 3) | 1);
    if (index === 1) geometry.push(((ring.length - 1) << 3) | 2);
    geometry.push(zigzag(x - cursor[0]), zigzag(y - cursor[1]));
    cursor = [x, y];
  });
  geometry.push((1 << 3) | 7);
  const packedGeometry = [];
  geometry.forEach(value => writeVarint(packedGeometry, value));

  const feature = [];
  writeVarintField(feature, 1, 1);
  // tags: key 0 (`z`), value 0
  writeBytes(feature, 2, [0, 0]);
  writeVarintField(feature, 3, 3);
  writeBytes(feature, 4, packedGeometry);

  const value = [];
  writeVarintField(value, 5, z); // uint_value

  const layer = [];
  writeVarintField(layer, 15, 2);
  writeBytes(layer, 1, [...new TextEncoder().encode('shapes')]);
  writeBytes(layer, 2, feature);
  writeBytes(layer, 3, [...new TextEncoder().encode('z')]);
  writeBytes(layer, 4, value);
  writeVarintField(layer, 5, 4096);

  const tile = [];
  writeBytes(tile, 3, layer);
  return Uint8Array.from(tile);
}

/** A box inset by a different amount in each tile, so that a misplaced tile shows. */
function getVectorTile(z, x, y) {
  const inset = 256 + 256 * (2 * y + x);
  return encodeBoxTile([inset, inset / 2, 4096 - inset / 2, 4096 - inset], z);
}

function encodePng(size, getPixel) {
  const png = new PNG({width: size, height: size, colorType: 2});
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const [r, g, b] = getPixel(column, row);
      const i = (row * size + column) * 4;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
  return new Uint8Array(PNG.sync.write(png, {colorType: 2, deflateLevel: 9}));
}

function getRasterTile(z, x, y) {
  return encodePng(256, (column, row) => {
    const quadrant = (row < 128 ? 0 : 2) + (column < 128 ? 0 : 1);
    return [40 + 100 * z + 20 * quadrant, 40 + 80 * x + 30 * (quadrant & 1), 40 + 80 * y];
  });
}

/** Elevation in meters at a Web Mercator position, `u` and `v` from 0 to 1. */
function getElevation(u, v) {
  const distance = (u - 0.45) ** 2 + (v - 0.4) ** 2;
  return Math.round(4000 * Math.exp(-distance / 0.02) + 300 * Math.sin(12 * u));
}

function getDemTile(z, x, y) {
  const size = 32;
  return encodePng(size, (column, row) => {
    const scale = 2 ** z;
    const u = (x + (column + 0.5) / size) / scale;
    const v = (y + (row + 0.5) / size) / scale;
    const encoded = getElevation(u, v) + 32768;
    return [Math.floor(encoded / 256), encoded % 256, 0];
  });
}

async function writeArchive(name, extension, getTile, options) {
  const tiles = TILE_INDICES.map(([z, x, y]) => ({z, x, y, data: getTile(z, x, y)}));
  for (const {z, x, y, data} of tiles) {
    const path = join(OUTPUT, 'tiles', name, String(z), String(x), `${y}.${extension}`);
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, data);
  }
  const archive = await encodePMTiles(
    tiles.map(tile =>
      options.tileCompression === 'gzip' ? {...tile, data: gzipSync(tile.data)} : tile
    ),
    {bounds: BOUNDS, ...options}
  );
  writeFileSync(join(OUTPUT, `${name}.pmtiles`), new Uint8Array(archive));
}

await writeArchive('vector', 'mvt', getVectorTile, {
  tileType: 'mvt',
  tileCompression: 'gzip',
  internalCompression: 'gzip',
  metadata: {vector_layers: [{id: 'shapes', fields: {z: 'Number'}}]}
});
await writeArchive('raster', 'png', getRasterTile, {tileType: 'png'});
await writeArchive('dem', 'png', getDemTile, {tileType: 'png'});
