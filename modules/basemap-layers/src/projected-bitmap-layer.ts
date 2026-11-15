// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {BitmapLayer} from '@deck.gl/layers';
import {subdivideTriangleMesh} from '@math.gl/geometry';
import {
  isProjectedViewport,
  lngLatToMercatorWorld,
  mercatorWorldToLngLat
} from './projected-viewport';

/** The cells along each side of the grid a tile's mesh starts from. */
const SEED_GRID_CELLS = 4;
/** The cells along each side of the grid of a tile whose mesh cannot be refined. */
const FALLBACK_GRID_CELLS = 16;
/** The share of a texel the drawn image may lie from its place. */
const TEXEL_TOLERANCE = 0.5;
/** The texels along a side of a tile image, to turn `TEXEL_TOLERANCE` into a distance. */
const DEFAULT_TILE_TEXELS = 512;

/** A mesh of a Web Mercator tile image, as `BitmapLayer` draws it. */
export type MercatorTileMesh = {
  /** The count of indices. */
  vertexCount: number;
  /** Longitude, latitude and 0 of each vertex. */
  positions: Float64Array;
  /** The projected position of each vertex: what `BitmapLayer` draws. */
  projectedPositions: Float64Array;
  indices: Uint32Array;
  /** The image coordinates of each vertex, with v down. */
  texCoords: Float32Array;
};

function createGrid(cells: number): {positions: Float64Array; indices: Uint32Array} {
  const side = cells + 1;
  const positions = new Float64Array(side * side * 2);
  const indices = new Uint32Array(cells * cells * 6);
  let index = 0;
  for (let i = 0; i < side; i++) {
    for (let j = 0; j < side; j++) {
      const vertex = i * side + j;
      positions[vertex * 2] = i / cells;
      positions[vertex * 2 + 1] = j / cells;
      if (i > 0 && j > 0) {
        indices[index++] = vertex - side;
        indices[index++] = vertex - side - 1;
        indices[index++] = vertex - 1;
        indices[index++] = vertex - side;
        indices[index++] = vertex - 1;
        indices[index++] = vertex;
      }
    }
  }
  return {positions, indices};
}

/**
 * Creates the mesh that draws a Web Mercator tile image in another projection. The image is
 * uniform in Web Mercator space, so each vertex takes the longitude/latitude of its place in that
 * space: a mesh uniform in latitude draws the image's rows at the wrong latitudes. The mesh is
 * refined with math.gl's `subdivideTriangleMesh` until the sampled distance between the mesh and
 * the projection is under half a texel. Where it cannot be refined, the tile is drawn with a
 * fixed grid.
 *
 * `bounds` are the tile's `[west, south, east, north]`, and `project` converts longitude/latitude
 * to the positions drawn. With `drawnBounds` (see `getNormalizedBounds`), only the part of the tile
 * inside them has a mesh: outside the area of use of a projection, math.gl moves positions to its
 * edge, and a mesh across that edge folds onto it. Its refinement follows the fold to its limit
 * of triangles, and draws nothing more.
 */
export function createMercatorTileMesh(
  bounds: ArrayLike<number>,
  project: (lngLat: number[]) => ArrayLike<number>,
  texels: number = DEFAULT_TILE_TEXELS,
  drawnBounds?: ArrayLike<number> | null
): MercatorTileMesh {
  const [x0, y0] = lngLatToMercatorWorld([bounds[0], bounds[1]]);
  const [x1, y1] = lngLatToMercatorWorld([bounds[2], bounds[3]]);
  const [u0, v0, u1, v1] = getDrawnPart(bounds, drawnBounds);
  if (!(u1 > u0 && v1 > v0)) {
    return EMPTY_MESH;
  }
  // `u` and `v` run over the part of the tile that is drawn, and `toImage` gives their place in
  // the tile image.
  const toImage = (u: number, v: number) => [u0 + u * (u1 - u0), v0 + v * (v1 - v0)];
  const toLngLat = (u: number, v: number) => {
    const [i, j] = toImage(u, v);
    return mercatorWorldToLngLat([x0 + i * (x1 - x0), y0 + j * (y1 - y0)]);
  };
  const transform = (uv: ArrayLike<number>): number[] => {
    const projected = project([...toLngLat(uv[0], uv[1]), 0]);
    return [projected[0], projected[1], projected[2] ?? 0];
  };
  /** A vertex without a projected position is not a number: its triangles are not drawn. */
  const transformOrSkip = (uv: ArrayLike<number>): number[] => {
    try {
      return transform(uv);
    } catch {
      return [Number.NaN, Number.NaN, 0];
    }
  };

  const a = transformOrSkip([0, 0]);
  const b = transformOrSkip([1, 1]);
  const c = transformOrSkip([0, 1]);
  const d = transformOrSkip([1, 0]);
  const diagonal = (Math.hypot(b[0] - a[0], b[1] - a[1]) + Math.hypot(d[0] - c[0], d[1] - c[1])) / 2;
  const tolerance = (diagonal / (texels * Math.SQRT2)) * TEXEL_TOLERANCE;

  let uv: ArrayLike<number> | null = null;
  let projected: ArrayLike<number> | null = null;
  let indices: Uint32Array | null = null;
  if (Number.isFinite(tolerance) && tolerance > 0) {
    try {
      const refined = subdivideTriangleMesh(createGrid(SEED_GRID_CELLS), {
        size: 2,
        targetSize: 3,
        tolerance,
        transform
      });
      uv = refined.sourcePositions;
      projected = refined.positions;
      indices = refined.indices;
    } catch {
      // The projection has no smooth form over this tile: draw the fixed grid.
    }
  }
  if (!uv || !projected || !indices) {
    const grid = createGrid(FALLBACK_GRID_CELLS);
    const positions = new Float64Array((grid.positions.length / 2) * 3);
    for (let vertex = 0; vertex < grid.positions.length / 2; vertex++) {
      positions.set(transformOrSkip(grid.positions.subarray(vertex * 2, vertex * 2 + 2)), vertex * 3);
    }
    uv = grid.positions;
    projected = positions;
    indices = grid.indices;
  }

  const vertexCount = uv.length / 2;
  const positions = new Float64Array(vertexCount * 3);
  const texCoords = new Float32Array(vertexCount * 2);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const u = uv[vertex * 2];
    const v = uv[vertex * 2 + 1];
    positions.set(toLngLat(u, v), vertex * 3);
    const [i, j] = toImage(u, v);
    texCoords[vertex * 2] = i;
    texCoords[vertex * 2 + 1] = 1 - j;
  }
  return {
    vertexCount: indices.length,
    positions,
    projectedPositions: Float64Array.from(projected),
    indices,
    texCoords
  };
}

const EMPTY_MESH: MercatorTileMesh = {
  vertexCount: 0,
  positions: new Float64Array(0),
  projectedPositions: new Float64Array(0),
  indices: new Uint32Array(0),
  texCoords: new Float32Array(0)
};

/**
 * The part of a tile inside `drawnBounds`, `[west, south, east, north]` in degrees (see
 * `getNormalizedBounds`), as `[u0, v0, u1, v1]` in the tile image, with v up. Empty where the
 * bounds have no area, and the whole tile without bounds.
 */
function getDrawnPart(
  bounds: ArrayLike<number>,
  drawnBounds?: ArrayLike<number> | null
): [number, number, number, number] {
  if (!drawnBounds) {
    return [0, 0, 1, 1];
  }
  const [x0, y0] = lngLatToMercatorWorld([bounds[0], bounds[1]]);
  const [x1, y1] = lngLatToMercatorWorld([bounds[2], bounds[3]]);
  const [ax0, ay0] = lngLatToMercatorWorld([drawnBounds[0], drawnBounds[1]]);
  const [ax1, ay1] = lngLatToMercatorWorld([drawnBounds[2], drawnBounds[3]]);
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  return [
    clamp((ax0 - x0) / (x1 - x0)),
    clamp((ay0 - y0) / (y1 - y0)),
    clamp((ax1 - x0) / (x1 - x0)),
    clamp((ay1 - y0) / (y1 - y0))
  ];
}

/**
 * The bounds, `[west, south, east, north]`, that a projection's normalization moves a tile to, or
 * null. math.gl's normalization moves a position outside the area of use of an EPSG code, such as
 * a UTM zone, to the nearest position on its edge: there it clamps longitude and latitude to a box.
 * Returns that box clipped to the tile, if the normalization moves the four corners of the tile as
 * such a clamp does, and null for another normalization, which then does not clip the tile. A
 * tile outside the box gets bounds without area, on the edge of the box.
 */
export function getNormalizedBounds(
  bounds: ArrayLike<number>,
  normalize: (position: number[]) => ArrayLike<number>
): [number, number, number, number] | null {
  let corners: ArrayLike<number>[];
  try {
    corners = [
      [bounds[0], bounds[1]],
      [bounds[2], bounds[1]],
      [bounds[2], bounds[3]],
      [bounds[0], bounds[3]]
    ].map(([longitude, latitude]) => normalize([longitude, latitude, 0]));
  } catch {
    return null;
  }
  const [west, south, east, north] = [corners[0][0], corners[0][1], corners[2][0], corners[2][1]];
  const isClamp =
    [west, south, east, north].every(Number.isFinite) &&
    west <= east &&
    south <= north &&
    corners[1][0] === east &&
    corners[1][1] === south &&
    corners[3][0] === west &&
    corners[3][1] === north;
  return isClamp ? [west, south, east, north] : null;
}

function isRectangularBounds(bounds: unknown): bounds is number[] {
  return Array.isArray(bounds) && bounds.length === 4 && bounds.every(Number.isFinite);
}

/**
 * A `BitmapLayer` for Web Mercator tile images that also draws in a projected view (deck.gl's
 * `_CustomProjectionView`), with the mesh of `createMercatorTileMesh`. `BitmapLayer` itself draws
 * a mesh uniform in longitude and latitude there, and its `_imageCoordinateSystem` has no effect.
 * In other views it draws as `BitmapLayer` does.
 */
export class ProjectedBitmapLayer<ExtraPropsT extends {} = {}> extends BitmapLayer<ExtraPropsT> {
  static layerName = 'ProjectedBitmapLayer';

  protected _createMesh() {
    const {bounds} = this.props;
    const transform = this.usePositionTransforms().transform;
    if (!transform || !isProjectedViewport(this.context.viewport) || !isRectangularBounds(bounds)) {
      return super._createMesh();
    }
    const {crs} = this.context.viewport as {
      crs?: {converter?: {WGS84?: {normalize?: (position: number[]) => number[]}}};
    };
    const normalize = crs?.converter?.WGS84?.normalize;
    return createMercatorTileMesh(
      bounds,
      lngLat => transform.call(this, lngLat),
      DEFAULT_TILE_TEXELS,
      normalize ? getNormalizedBounds(bounds, normalize) : null
    ) as ReturnType<BitmapLayer['_createMesh']>;
  }
}
