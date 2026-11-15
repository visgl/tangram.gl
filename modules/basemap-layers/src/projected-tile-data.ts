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

/** A line or ring of tile-local positions, with vertices added along its long steps. */
function addVertices(line: number[][]): number[][] {
  const result: number[][] = [];
  line.forEach((position, index) => {
    const previous = line[index - 1];
    if (previous) {
      const steps = Math.ceil(
        Math.max(Math.abs(position[0] - previous[0]), Math.abs(position[1] - previous[1])) / MAX_STEP
      );
      for (let step = 1; step < steps; step++) {
        const t = step / steps;
        result[result.length] = previous.map((value, axis) => value + (position[axis] - value) * t);
      }
    }
    result[result.length] = position;
  });
  return result;
}

/** The coordinates of a geometry, with vertices added along the long steps of lines and rings. */
function addGeometryVertices(type: string, coordinates: any): any {
  switch (type) {
    case 'LineString':
      return addVertices(coordinates);
    case 'MultiLineString':
    case 'Polygon':
      return coordinates.map(addVertices);
    case 'MultiPolygon':
      return coordinates.map((polygon: number[][][]) => polygon.map(addVertices));
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
            coordinates: convertCoordinates(addGeometryVertices(geometry.type, geometry.coordinates))
          });
    converted = features.map(feature => ({...feature, geometry: convertGeometry(feature.geometry)}));
    cache.set(key, converted);
  }
  return converted;
}
