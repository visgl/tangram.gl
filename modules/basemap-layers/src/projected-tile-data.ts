// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {MERCATOR_WORLD_SIZE, mercatorWorldToLngLat} from './projected-viewport';

type TileIndex = {x: number; y: number; z: number};

/**
 * The longest step between two vertices of a line or ring, as a share of the tile's side. A
 * straight edge in a tile is straight in Web Mercator space and curved in another projection:
 * longer steps, such as the edges of a polygon cut at the tile's sides, get more vertices, so
 * that the view projects the curve and not its chord.
 */
const MAX_STEP = 1 / 16;
/**
 * The range of tile-local coordinates that a step is measured in: the tile and a buffer of its
 * own size on each side. Tiles come from servers the application does not control, and a corrupt
 * coordinate far outside the tile must not ask for millions of vertices.
 */
const MIN_COORDINATE = -1;
const MAX_COORDINATE = 2;
/** The most parts one step is divided into, whatever its length. */
const MAX_STEP_PARTS = 64;
/** The most vertices added to the features of one tile. Past it, steps are left whole. */
export const MAX_ADDED_VERTICES = 65536;

/** The count of vertices that the features of one tile can still get. */
type VertexBudget = {remaining: number};

const clampCoordinate = (value: number) =>
  Math.max(MIN_COORDINATE, Math.min(MAX_COORDINATE, value));

/** The count of parts a step between two tile-local positions is divided into: 1 or more. */
function getStepParts(from: number[], to: number[]): number {
  const length = Math.max(
    Math.abs(clampCoordinate(to[0]) - clampCoordinate(from[0])),
    Math.abs(clampCoordinate(to[1]) - clampCoordinate(from[1]))
  );
  const parts = Math.min(MAX_STEP_PARTS, Math.ceil(length / MAX_STEP));
  // A coordinate that is not a number has no length.
  return parts >= 1 ? parts : 1;
}

/** A line or ring of tile-local positions, with vertices added along its long steps. */
function addVertices(line: number[][], budget: VertexBudget): number[][] {
  const result: number[][] = [];
  line.forEach((position, index) => {
    const previous = line[index - 1];
    if (previous) {
      const parts = getStepParts(previous, position);
      // A step that the budget does not cover is left whole.
      if (parts - 1 <= budget.remaining) {
        budget.remaining -= parts - 1;
        for (let part = 1; part < parts; part++) {
          const t = part / parts;
          result[result.length] = previous.map(
            (value, axis) => value + (position[axis] - value) * t
          );
        }
      }
    }
    result[result.length] = position;
  });
  return result;
}

/** The coordinates of a geometry, with vertices added along the long steps of lines and rings. */
function addGeometryVertices(type: string, coordinates: any, budget: VertexBudget): any {
  switch (type) {
    case 'LineString':
      return addVertices(coordinates, budget);
    case 'MultiLineString':
    case 'Polygon':
      return coordinates.map((line: number[][]) => addVertices(line, budget));
    case 'MultiPolygon':
      return coordinates.map((polygon: number[][][]) =>
        polygon.map(ring => addVertices(ring, budget))
      );
    default:
      return coordinates;
  }
}

const geographicTiles = new WeakMap<object, Map<string, any[]>>();

/**
 * The features of a vector tile with longitude/latitude geometry, for a projected view, from the
 * tile-local features a shared tileset holds. Lines and rings get vertices along their long
 * steps (see `MAX_STEP`). The tileset's features are not changed: views of other kinds draw them
 * too. The result is kept per feature array and tile, so that a tile's sublayers get the same
 * data at each update.
 */
export function getTileFeaturesInLngLat(features: any[], index: TileIndex): any[] {
  const key = `${index.x}/${index.y}/${index.z}`;
  let cache = geographicTiles.get(features);
  if (!cache) {
    cache = new Map();
    geographicTiles.set(features, cache);
  }
  let converted = cache.get(key);
  if (!converted) {
    const scale = 2 ** index.z;
    const budget: VertexBudget = {remaining: MAX_ADDED_VERTICES};
    const convertCoordinates = (coordinates: any): any => {
      if (typeof coordinates[0] === 'number') {
        const [x, y, ...rest] = coordinates;
        return [
          ...mercatorWorldToLngLat([
            (MERCATOR_WORLD_SIZE * (index.x + x)) / scale,
            MERCATOR_WORLD_SIZE * (1 - (index.y + y) / scale)
          ]),
          ...rest
        ];
      }
      return coordinates.map(convertCoordinates);
    };
    const convertGeometry = (geometry: any): any =>
      geometry &&
      (geometry.type === 'GeometryCollection'
        ? {...geometry, geometries: geometry.geometries.map(convertGeometry)}
        : {
            ...geometry,
            coordinates: convertCoordinates(
              addGeometryVertices(geometry.type, geometry.coordinates, budget)
            )
          });
    converted = features.map(feature => ({...feature, geometry: convertGeometry(feature.geometry)}));
    cache.set(key, converted);
  }
  return converted;
}
