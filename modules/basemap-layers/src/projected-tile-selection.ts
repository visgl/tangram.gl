// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {
  getMercatorZoom,
  lngLatToMercatorWorld,
  MAX_MERCATOR_LATITUDE,
  MERCATOR_WORLD_SIZE,
  mercatorWorldToLngLat,
  type ProjectedViewportLike
} from './projected-viewport';

/** The index of a Web Mercator (OSM) tile. */
export type ProjectedTileIndex = {x: number; y: number; z: number};

/** Options of {@link getProjectedTileIndices}. */
export type ProjectedTileSelectionOptions = {
  /** The tile zoom to select. */
  z: number;
  /** Longitude/latitude bounds `[west, south, east, north]` that limit the selection. */
  extent?: ArrayLike<number> | null;
  /**
   * The most tiles to select. A view that needs more draws the tiles of a lower zoom: a projected
   * view can show high latitudes, where Web Mercator tiles are small, far from its center.
   */
  maxTiles?: number;
  /** The highest tile zoom of the source. Tiles are not divided past it. */
  maxZoom?: number;
  /** The lowest tile zoom of the source. No tiles of a lower zoom stand in for too many tiles. */
  minZoom?: number;
  /**
   * How many times longer than at true scale the projection may draw a part of a tile's outline
   * (see `isTileStretched`). Default `DEFAULT_MAX_STRETCH`. A projection that stretches the map
   * smoothly toward the edge of its area of use, as a polar stereographic one, can take more: 16
   * draws EPSG:3031 out to latitude 60N, where math.gl clamps its positions. A larger limit also
   * stops seeing the places a projection cannot draw, as in a transverse Mercator projection of
   * the whole world, whose tiles are then drawn across the map.
   */
  maxStretch?: number;
};

/** The default of `ProjectedTileSelectionOptions.maxStretch`. */
export const DEFAULT_MAX_STRETCH = 4;

/** The default of `ProjectedTileSelectionOptions.maxTiles`. */
export const DEFAULT_MAX_PROJECTED_TILES = 512;

/** The screen is sampled at the corners of a grid of this many cells along each side. */
const SCREEN_GRID_CELLS = 16;
/** A tile's edge is sampled at this many points along each side. */
const TILE_GRID_CELLS = 8;
/**
 * The scale of the map plane at true scale: common units per degree of arc. deck.gl's common
 * space is `MERCATOR_WORLD_SIZE` units around the equator, in a projected view too.
 */
const TRUE_PLANE_SCALE = MERCATOR_WORLD_SIZE / 360;
/**
 * A view center that the projection draws up to this many times its true scale does not change
 * the stretch limit. A view of a place drawn larger than that, far outside the area of use,
 * measures the stretch against half the scale at its center, so that it still draws the tiles
 * at its center.
 */
const MAX_CENTER_STRETCH = 2;
/**
 * The zoom at which the edge of the drawn area is decided. A stretched tile of a lower zoom is
 * divided down to this zoom, and the parts still stretched there are left out. A tile of a higher
 * zoom is drawn only where its ancestor at this zoom is not stretched. So the edge is the same at
 * every zoom of the view.
 */
const EDGE_ZOOM = 5;
/** The step, in degrees, that measures the scale of the projection at the view center. */
const SCALE_STEP_DEGREES = 1e-3;
/** Pixels by which a sample may miss its own pixel when it is projected back. */
const ROUND_TRIP_PIXELS = 1;
/** The share of a tile's size by which a tile sample may miss itself when it is projected back. */
const ROUND_TRIP_TILE_SHARE = 1e-3;

/** A point of the screen that shows the map, in tile pyramid units: [0, 1) across the world. */
type ScreenSample = {u: number; v: number};

type TileNode = ProjectedTileIndex & {
  /** The screen samples that lie in the tile. */
  samples: ScreenSample[];
};

function wrapLongitude(longitude: number): number {
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

function toPyramid(lngLat: ArrayLike<number>): ScreenSample {
  const world = lngLatToMercatorWorld([wrapLongitude(lngLat[0]), lngLat[1]]);
  return {u: world[0] / MERCATOR_WORLD_SIZE, v: 1 - world[1] / MERCATOR_WORLD_SIZE};
}

/** The longitude/latitude of a point of the tile pyramid. */
function fromPyramid(u: number, v: number): [number, number] {
  return mercatorWorldToLngLat([u * MERCATOR_WORLD_SIZE, (1 - v) * MERCATOR_WORLD_SIZE]);
}

/**
 * The pixel of a longitude/latitude, with its depth, or null where the view has none. deck.gl
 * throws for a position that its projection converts to no number, as far outside the area of
 * use of a transverse Mercator projection.
 */
function projectOrNull(viewport: ProjectedViewportLike, lngLat: ArrayLike<number>): number[] | null {
  try {
    const pixel = viewport.project([lngLat[0], lngLat[1], 0]);
    return Number.isFinite(pixel[0]) && Number.isFinite(pixel[1]) ? pixel : null;
  } catch {
    return null;
  }
}

/** The longitude/latitude of a pixel, or null where the view has none. */
function unprojectOrNull(viewport: ProjectedViewportLike, pixel: number[]): number[] | null {
  try {
    const lngLat = viewport.unproject([pixel[0], pixel[1]]);
    return Number.isFinite(lngLat[0]) && Number.isFinite(lngLat[1]) ? lngLat : null;
  } catch {
    return null;
  }
}

/**
 * Whether a projected position, `[x, y, depth]`, lies in front of the camera. A pitched view
 * projects the ground behind its camera too, mirrored, to pixels above the horizon, with a depth
 * outside the range of the view. A position without a depth counts as in front.
 */
function isInFrontOfCamera(pixel: number[]): boolean {
  const depth = pixel[2];
  return depth === undefined || (depth >= 0 && depth <= 1);
}

/**
 * The points of the screen that show the map. A pixel shows the map if it has a longitude and
 * latitude inside the tile pyramid that the view draws back at that pixel: a projection draws
 * positions outside its area of use elsewhere, or nowhere, and a pitched view has pixels above
 * the horizon, which show the ground behind the camera, mirrored.
 */
function getScreenSamples(viewport: ProjectedViewportLike): ScreenSample[] {
  const samples: ScreenSample[] = [];
  const moved: number[][] = [];
  const addSample = (pixel: number[]): void => {
    const lngLat = unprojectOrNull(viewport, pixel);
    if (!lngLat || Math.abs(lngLat[1]) > MAX_MERCATOR_LATITUDE) {
      return;
    }
    const back = projectOrNull(viewport, lngLat);
    if (!back || !isInFrontOfCamera(back)) {
      return;
    }
    if (
      Math.abs(back[0] - pixel[0]) <= ROUND_TRIP_PIXELS &&
      Math.abs(back[1] - pixel[1]) <= ROUND_TRIP_PIXELS
    ) {
      samples.push(toPyramid(lngLat));
    } else if (isOnScreen(back, viewport.width, viewport.height)) {
      moved.push(back);
    }
  };
  for (let i = 0; i <= SCREEN_GRID_CELLS; i++) {
    for (let j = 0; j <= SCREEN_GRID_CELLS; j++) {
      addSample([
        (i / SCREEN_GRID_CELLS) * viewport.width,
        (j / SCREEN_GRID_CELLS) * viewport.height
      ]);
    }
  }
  // No screen point shows the map, but the view can still draw a part of it smaller than the
  // gaps between them, as a zoomed-out UTM zone. A projection that moves positions outside its
  // area of use to the edge of that area draws a screen point's position there: on that part.
  if (!samples.length) {
    for (const pixel of moved.splice(0)) {
      addSample(pixel);
    }
  }
  return samples;
}

/** Whether two segments, `a` to `b` and `c` to `d`, cross. */
function segmentsCross(a: number[], b: number[], c: number[], d: number[]): boolean {
  const side = (p: number[], q: number[], r: number[]) =>
    Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return side(a, b, c) !== side(a, b, d) && side(c, d, a) !== side(c, d, b);
}

const isOnScreen = ([x, y]: number[], width: number, height: number) =>
  x >= 0 && x <= width && y >= 0 && y <= height;

/**
 * Whether the view draws a part of a tile on the screen. The tile's edge is sampled, and the
 * outline of its samples, as the view draws them, is tested against the screen: a sample on the
 * screen, or an outline segment across a screen edge. A sample counts only if the view draws it at a pixel that shows it again: positions outside the
 * projection's area of use, or behind the camera of a pitched view, do not, and the outline has
 * no segment to or from them.
 */
function isTileOnScreen(viewport: ProjectedViewportLike, {x, y, z}: ProjectedTileIndex): boolean {
  const {width, height} = viewport;
  const scale = 2 ** z;
  const tolerance = (360 / scale) * ROUND_TRIP_TILE_SHARE;
  const ring: (number[] | null)[] = [];
  // Around the tile: the top edge, the right, the bottom and the left.
  for (let side = 0; side < 4; side++) {
    for (let step = 0; step < TILE_GRID_CELLS; step++) {
      const t = step / TILE_GRID_CELLS;
      const [i, j] = [
        [t, 0],
        [1, t],
        [1 - t, 1],
        [0, 1 - t]
      ][side];
      const lngLat = fromPyramid((x + i) / scale, (y + j) / scale);
      const pixel = projectOrNull(viewport, lngLat);
      const back = pixel && isInFrontOfCamera(pixel) ? unprojectOrNull(viewport, pixel) : null;
      const isDrawn =
        back !== null &&
        Math.abs(wrapLongitude(back[0] - lngLat[0])) <= tolerance &&
        Math.abs(back[1] - lngLat[1]) <= tolerance;
      ring[ring.length] = pixel && isDrawn ? [pixel[0], pixel[1]] : null;
    }
  }
  const corners = [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height]
  ];
  for (let index = 0; index < ring.length; index++) {
    const a = ring[index];
    const b = ring[(index + 1) % ring.length];
    if (!a) {
      continue;
    }
    if (
      isOnScreen(a, width, height) ||
      (b && corners.some((corner, side) => segmentsCross(a, b, corner, corners[(side + 1) % 4])))
    ) {
      return true;
    }
  }
  // An outline around the whole screen is not on it: such a tile holds every screen sample.
  return false;
}

/**
 * The length the view's map plane gives a step between two positions, per degree of arc on the
 * ground: common units per degree. Infinite where the projection has no position for an end.
 */
function getPlaneScale(
  viewport: ProjectedViewportLike,
  a: ArrayLike<number>,
  b: ArrayLike<number>
): number {
  const cosLatitude = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const arc = Math.hypot(wrapLongitude(b[0] - a[0]) * cosLatitude, b[1] - a[1]);
  try {
    const from = viewport.projectPosition!([a[0], a[1], 0]);
    const to = viewport.projectPosition!([b[0], b[1], 0]);
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    return Number.isFinite(length) ? length / arc : Infinity;
  } catch {
    return Infinity;
  }
}

/** The scale of the view's map plane at the view center (see `getPlaneScale`), or null. */
function getCenterPlaneScale(viewport: ProjectedViewportLike): number | null {
  const center = unprojectOrNull(viewport, [viewport.width / 2, viewport.height / 2]);
  if (!center || !viewport.projectPosition) {
    return null;
  }
  const east = getPlaneScale(viewport, center, [center[0] + SCALE_STEP_DEGREES, center[1]]);
  const north = getPlaneScale(viewport, center, [center[0], center[1] + SCALE_STEP_DEGREES]);
  const scale = Math.sqrt(east * north);
  return Number.isFinite(scale) && scale > 0 ? scale : null;
}

/**
 * The longest step, in common units per degree of arc, that the projection may draw along a
 * tile's outline (see `isTileStretched`), or null where the view has no map plane. It does not
 * depend on the camera in a view of the area of use: a limit that moves with the view center
 * moves the edge of the drawn area, and the tiles at the edge come and go as the view pans.
 */
function getStretchLimit(viewport: ProjectedViewportLike, maxStretch: number): number | null {
  const centerScale = getCenterPlaneScale(viewport);
  return centerScale === null
    ? null
    : maxStretch * Math.max(TRUE_PLANE_SCALE, centerScale / MAX_CENTER_STRETCH);
}

/**
 * Whether the projection draws a step along a tile's outline longer than `limit` (see
 * `getStretchLimit`), or has no position for it. Such a tile holds a place the projection
 * cannot draw, or a seam: its geometry is drawn across the map. A projection that moves positions
 * outside its area of use to the edge of that area shrinks them, and is not stretched.
 */
function isTileStretched(
  viewport: ProjectedViewportLike,
  {x, y, z}: ProjectedTileIndex,
  limit: number
): boolean {
  const scale = 2 ** z;
  let previous = fromPyramid(x / scale, y / scale);
  for (let side = 0; side < 4; side++) {
    for (let step = 1; step <= TILE_GRID_CELLS; step++) {
      const t = step / TILE_GRID_CELLS;
      const [i, j] = [
        [t, 0],
        [1, t],
        [1 - t, 1],
        [0, 1 - t]
      ][side];
      const lngLat = fromPyramid((x + i) / scale, (y + j) / scale);
      if (!(getPlaneScale(viewport, previous, lngLat) <= limit)) {
        return true;
      }
      previous = lngLat;
    }
  }
  return false;
}

function isTileInExtent({x, y, z}: ProjectedTileIndex, extent: ArrayLike<number>): boolean {
  const scale = 2 ** z;
  const [west, north] = fromPyramid(x / scale, y / scale);
  const [east, south] = fromPyramid((x + 1) / scale, (y + 1) / scale);
  return west < extent[2] && east > extent[0] && south < extent[3] && north > extent[1];
}

/**
 * Divides the tiles that the projection stretches into the tiles of the next zooms, down to
 * `EDGE_ZOOM` (or `maxZoom`), and leaves out the parts that are still stretched there. A tile of a
 * higher zoom is left out where its ancestor at that zoom is stretched. The area drawn is then the
 * same for each tile zoom: the edge tiles do not come and go as the view zooms. Where the division
 * makes more than `maxTiles` tiles, the stretched tiles are left out whole.
 */
function divideStretchedTiles(
  viewport: ProjectedViewportLike,
  tiles: TileNode[],
  getShownChildren: (node: TileNode) => TileNode[],
  {
    maxTiles,
    maxZoom = Infinity,
    maxStretch
  }: {maxTiles: number; maxZoom?: number; maxStretch: number}
): TileNode[] {
  const limit = getStretchLimit(viewport, maxStretch);
  if (limit === null) {
    return tiles;
  }
  const edgeZoom = Math.min(EDGE_ZOOM, maxZoom);
  const edgeTiles = new Map<string, boolean>();
  const isStretched = ({x, y, z}: ProjectedTileIndex): boolean => {
    if (z <= edgeZoom) {
      return isTileStretched(viewport, {x, y, z}, limit);
    }
    const shift = 2 ** (z - edgeZoom);
    const edge = {x: Math.floor(x / shift), y: Math.floor(y / shift), z: edgeZoom};
    const key = `${edge.x}/${edge.y}`;
    let stretched = edgeTiles.get(key);
    if (stretched === undefined) {
      stretched = isTileStretched(viewport, edge, limit);
      edgeTiles.set(key, stretched);
    }
    return stretched;
  };
  const divided: TileNode[] = [];
  const divide = (node: TileNode): void => {
    if (!isStretched(node)) {
      divided[divided.length] = node;
    } else if (node.z < edgeZoom && divided.length <= maxTiles) {
      for (const child of getShownChildren(node)) {
        divide(child);
      }
    }
  };
  for (const tile of tiles) {
    divide(tile);
  }
  return divided.length <= maxTiles ? divided : tiles.filter(tile => !isStretched(tile));
}

/**
 * Selects the Web Mercator tiles that a projected view shows, of one zoom where the projection
 * draws them without stretch. deck.gl selects tiles
 * for a Web Mercator view and a globe from the view frustum, with tiles as boxes in Web Mercator
 * space; in a view of another projection a tile is neither a box nor, far from the projection's
 * area of use, a shape at all.
 *
 * The tile pyramid is walked from its root. A tile is kept if a point of the screen lies in it,
 * or if the view draws its outline across the screen: the first finds the tiles larger than the
 * gaps between the screen points, the second the smaller ones. Both read only the
 * view's `project` and `unproject`, so the selection holds for any projection, bearing and pitch.
 *
 * A selected tile that the projection stretches (see `isTileStretched`) is divided into the tiles
 * of the next zooms, down to `EDGE_ZOOM`, and the parts still stretched are left out: a
 * view zoomed out past the area the projection can draw shows the tiles around that area, and
 * not geometry drawn across the map. Tiles come nearest the screen center first.
 */
export function getProjectedTileIndices(
  viewport: ProjectedViewportLike,
  {
    z,
    extent = null,
    maxTiles = DEFAULT_MAX_PROJECTED_TILES,
    maxZoom,
    minZoom = 0,
    maxStretch = DEFAULT_MAX_STRETCH
  }: ProjectedTileSelectionOptions
): ProjectedTileIndex[] {
  if (!(viewport.width > 0) || !(viewport.height > 0) || !Number.isFinite(z)) {
    return [];
  }
  const samples = getScreenSamples(viewport);
  const root: TileNode = {x: 0, y: 0, z: 0, samples};
  if (!samples.length && !isTileOnScreen(viewport, root)) {
    return [];
  }
  /** The tiles of the next zoom in a tile that the view shows, in `extent` unless it is null. */
  const getShownChildren = (node: TileNode, tileExtent = extent): TileNode[] => {
    const children: TileNode[] = [];
    const scale = 2 ** (node.z + 1);
    for (let child = 0; child < 4; child++) {
      const index = {x: node.x * 2 + (child & 1), y: node.y * 2 + (child >> 1), z: node.z + 1};
      if (tileExtent && !isTileInExtent(index, tileExtent)) {
        continue;
      }
      const childSamples = node.samples.filter(
        sample =>
          Math.min(scale - 1, Math.floor(sample.u * scale)) === index.x &&
          Math.min(scale - 1, Math.floor(sample.v * scale)) === index.y
      );
      if (childSamples.length || isTileOnScreen(viewport, index)) {
        children[children.length] = {...index, samples: childSamples};
      }
    }
    return children;
  };
  let level: TileNode[] = [root];
  for (let zoom = 0; zoom < z; zoom++) {
    const next = level.flatMap(node => getShownChildren(node));
    // The view shows tiles of this zoom, but none in the extent: the source has none to draw.
    if (!next.length && extent && level.some(node => getShownChildren(node, null).length)) {
      return [];
    }
    // A level the view shows no tile of, or too many: the tiles of the level before stand in, if
    // the source serves its zoom.
    if (!next.length || next.length > maxTiles) {
      if (zoom < minZoom) {
        return [];
      }
      break;
    }
    level = next;
  }
  level = divideStretchedTiles(viewport, level, getShownChildren, {
    maxTiles,
    maxZoom,
    maxStretch
  });
  const centerLngLat = unprojectOrNull(viewport, [viewport.width / 2, viewport.height / 2]);
  const center = centerLngLat ? toPyramid(centerLngLat) : null;
  const indices = level.map(({x, y, z: tileZoom}) => ({x, y, z: tileZoom}));
  if (center) {
    const getDistance = (index: ProjectedTileIndex) =>
      Math.hypot(
        (index.x + 0.5) / 2 ** index.z - center.u,
        (index.y + 0.5) / 2 ** index.z - center.v
      );
    indices.sort((a, b) => getDistance(a) - getDistance(b));
  }
  return indices;
}

/**
 * The zoom of the tiles a projected view draws, as deck.gl's `TileLayer` chooses it in a Web
 * Mercator view, from the zoom of the Web Mercator map of the same scale (see `getMercatorZoom`):
 * `zoomOffset` is added before the zoom is rounded. Returns null below `minZoom` without an
 * `extent`, where `TileLayer` draws no tiles.
 */
export function getProjectedTileZoom(
  viewport: ProjectedViewportLike,
  {
    tileSize = MERCATOR_WORLD_SIZE,
    zoomOffset = 0,
    minZoom,
    maxZoom,
    extent
  }: {
    tileSize?: number;
    zoomOffset?: number;
    minZoom?: number;
    maxZoom?: number;
    extent?: ArrayLike<number> | null;
  }
): number | null {
  let z = Math.round(
    getMercatorZoom(viewport) + Math.log2(MERCATOR_WORLD_SIZE / tileSize) + zoomOffset
  );
  if (typeof minZoom === 'number' && Number.isFinite(minZoom) && z < minZoom) {
    if (!extent) {
      return null;
    }
    z = minZoom;
  }
  if (typeof maxZoom === 'number' && Number.isFinite(maxZoom) && z > maxZoom) {
    z = maxZoom;
  }
  return Math.max(0, z);
}
