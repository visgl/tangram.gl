// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {BasemapSource} from './style-resolver';

/** A tile index of the Web Mercator tile pyramid. */
export type SourceTileIndex = {x: number; y: number; z: number};

/** The `bounds` of a source, `[west, south, east, north]` in degrees. */
export type SourceTileBounds = [number, number, number, number];

/** The `{y}` placeholder of a tile URL template. */
const ROW_PLACEHOLDER = /\{y\}/g;

/** The flipped tile templates of `scheme: "tms"` sources, with the `tiles` they came from. */
const tmsTemplates = new WeakMap<BasemapSource, {tiles: string[]; templates: string[]}>();

/**
 * The tile URL templates that a source's tiles load from. For `scheme: "tms"`, every `{y}` is
 * replaced by `{-y}`, which deck.gl expands to the row counted from the south, `2^z - y - 1`, as
 * MapLibre GL JS writes `{y}` for a TMS source. For any other scheme, the source's own `tiles`.
 * The same source gives the same array while its `tiles` stay the same, so the tiles are not
 * reloaded on each render.
 */
export function getSourceTileTemplates(source: BasemapSource): string[] | undefined {
  const {tiles} = source;
  if (source.scheme !== 'tms' || !Array.isArray(tiles)) {
    return tiles;
  }
  let entry = tmsTemplates.get(source);
  if (!entry || entry.tiles !== tiles) {
    entry = {tiles, templates: tiles.map(tile => tile.replace(ROW_PLACEHOLDER, '{-y}'))};
    tmsTemplates.set(source, entry);
  }
  return entry.templates;
}

/** The clamped bounds of sources, with the `bounds` they came from. */
const clampedBounds = new WeakMap<BasemapSource, {bounds: unknown; clamped: SourceTileBounds}>();

/**
 * A source's `bounds`, clamped to longitudes -180 to 180 and latitudes -90 to 90 as MapLibre GL JS
 * clamps them, or null if the source has no bounds of four numbers. Bounds whose west is east of
 * their east, across the antimeridian, contain no tiles past zoom 0, as in MapLibre GL JS. The
 * same source gives the same array while its `bounds` stay the same.
 */
export function getSourceTileBounds(source: BasemapSource): SourceTileBounds | null {
  const {bounds} = source;
  if (
    !Array.isArray(bounds) ||
    bounds.length !== 4 ||
    !bounds.every(value => typeof value === 'number' && !Number.isNaN(value))
  ) {
    return null;
  }
  let entry = clampedBounds.get(source);
  if (!entry || entry.bounds !== bounds) {
    const [west, south, east, north] = bounds as number[];
    entry = {
      bounds,
      clamped: [Math.max(-180, west), Math.max(-90, south), Math.min(180, east), Math.min(90, north)]
    };
    clampedBounds.set(source, entry);
  }
  return entry.clamped;
}

function getMercatorX(longitude: number): number {
  return (180 + longitude) / 360;
}

function getMercatorY(latitude: number): number {
  return (
    (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (latitude * Math.PI) / 360))) / 360
  );
}

/**
 * Whether a tile overlaps `bounds` (see `getSourceTileBounds`), as MapLibre GL JS's
 * `TileBounds.contains` tests it: a tile that only touches the bounds at an edge is outside. The
 * bounds hold in every copy of the world.
 */
export function isTileInBounds({x, y, z}: SourceTileIndex, bounds: SourceTileBounds): boolean {
  const [west, south, east, north] = bounds;
  const worldSize = 2 ** z;
  const column = ((x % worldSize) + worldSize) % worldSize;
  return (
    column >= Math.floor(getMercatorX(west) * worldSize) &&
    column < Math.ceil(getMercatorX(east) * worldSize) &&
    y >= Math.floor(getMercatorY(north) * worldSize) &&
    y < Math.ceil(getMercatorY(south) * worldSize)
  );
}

/** The tile indices that overlap `bounds`, or all of them if there are no bounds. */
export function filterTileIndicesByBounds<IndexT extends SourceTileIndex>(
  indices: IndexT[],
  bounds: SourceTileBounds | null | undefined
): IndexT[] {
  return bounds ? indices.filter(index => isTileInBounds(index, bounds)) : indices;
}
