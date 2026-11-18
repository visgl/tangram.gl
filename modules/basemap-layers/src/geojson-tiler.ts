// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// deck.gl-community
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * Cutting GeoJSON into vector tiles with `@maplibre/geojson-vt`, and the transferable form a
 * tile's features take between the worker that cuts them and the main thread that draws them.
 * This module runs in both: it holds no state and imports nothing from the rest of the module.
 */

import {GeoJSONVT, type GeoJSONVTFeature, type GeoJSONVTOptions} from '@maplibre/geojson-vt';

/** The extent of MapLibre GL JS's tiles, in tile units: GeoJSON is tiled at this precision. */
export const GEOJSON_TILE_EXTENT = 8192;

/** The geometry types of a tile's features, by how deep their coordinates nest. */
const GEOMETRY_DEPTHS = {
  Point: 0,
  MultiPoint: 1,
  LineString: 1,
  MultiLineString: 2,
  Polygon: 2,
  MultiPolygon: 3
} as const;

type GeometryType = keyof typeof GEOMETRY_DEPTHS;

/** One feature of an encoded tile: its coordinates are in the tile's typed arrays. */
type EncodedFeature = {
  type: GeometryType;
  properties: Record<string, unknown>;
  id?: unknown;
};

/**
 * A tile's features in a form whose bulk can be transferred between threads: each feature's
 * coordinates, in tile units, follow one another in `positions` (x, y pairs), and `lengths` holds,
 * depth first, the length of each array above a position (the polygons of a multipolygon, the
 * rings of a polygon, the points of a ring). Tile units are integers: geojson-vt rounds them.
 */
export type EncodedTile = {
  features: EncodedFeature[];
  positions: Int32Array;
  lengths: Uint32Array;
};

/**
 * Builds the tile index of a GeoJSON source's data, and counts the features that
 * `clipToMercatorRange` dropped or cut (see `clipToMercatorRange`). Throws if the data is not
 * valid GeoJSON.
 */
export function createTileIndex(
  data: unknown,
  options: GeoJSONVTOptions,
  clipToMercatorRange = false
): {index: GeoJSONVT; outside: number} {
  const clipped = clipToMercatorRange ? clipFeaturesToMercatorRange(data) : {data, outside: 0};
  return {index: new GeoJSONVT(clipped.data as GeoJSON.GeoJSON, options), outside: clipped.outside};
}

/** The latitude of the north edge of the Web Mercator world, 85.0511287798 degrees. */
const MERCATOR_LATITUDE = (Math.atan(Math.sinh(Math.PI)) * 180) / Math.PI;

/**
 * Web Mercator y of a latitude, 0 at the north edge of the world and 1 at the south edge, and
 * not clamped to them. Latitudes are taken to within 1e-4 degrees of the poles, where y is finite.
 */
function getMercatorY(latitude: number): number {
  const sin = Math.sin((Math.max(-89.9999, Math.min(89.9999, latitude)) * Math.PI) / 180);
  return 0.5 - (0.25 * Math.log((1 + sin) / (1 - sin))) / Math.PI;
}

type Position = number[];

/** Whether a position is in the Web Mercator world, where geojson-vt does not move it. */
function isInside(position: Position): boolean {
  return Math.abs(position[1]) <= MERCATOR_LATITUDE;
}

/**
 * The point at `t` of the segment from `a` to `b`, which is straight in Web Mercator as geojson-vt
 * draws it, on the edge of the world at `edge` (0 or 1).
 */
function interpolate(a: Position, b: Position, t: number, edge: number): Position {
  return [a[0] + t * (b[0] - a[0]), edge === 0 ? MERCATOR_LATITUDE : -MERCATOR_LATITUDE];
}

/**
 * The parts of a line inside the Web Mercator world. A segment that crosses an edge of the world
 * ends where it crosses it, as geojson-vt cuts lines at tile edges.
 */
function clipLine(line: Position[]): Position[][] {
  const parts: Position[][] = [];
  let part: Position[] = [];
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const ya = getMercatorY(a[1]);
    const dy = getMercatorY(b[1]) - ya;
    // The part of the segment with 0 <= y <= 1, as parameters from a (0) to b (1).
    let t0 = 0;
    let t1 = 1;
    let edge0 = -1;
    let edge1 = -1;
    for (const edge of [0, 1]) {
      if (dy === 0) {
        continue;
      }
      const t = (edge - ya) / dy;
      // Entering the world through this edge, or leaving it.
      if ((edge === 0) === dy > 0) {
        if (t > t0) [t0, edge0] = [t, edge];
      } else if (t < t1) {
        [t1, edge1] = [t, edge];
      }
    }
    if (dy === 0 ? !isInside(a) : t0 > t1) {
      continue;
    }
    if (part.length === 0 || edge0 >= 0) {
      if (part.length > 1) parts.push(part);
      part = [edge0 >= 0 ? interpolate(a, b, t0, edge0) : a];
    }
    if (edge1 >= 0) {
      part.push(interpolate(a, b, t1, edge1));
      parts.push(part);
      part = [];
    } else {
      part.push(b);
    }
  }
  if (part.length > 1) parts.push(part);
  return parts;
}

/**
 * A polygon ring cut at the edges of the Web Mercator world (Sutherland-Hodgman), closed, or
 * `null` if less than a triangle is left.
 */
function clipRing(ring: Position[]): Position[] | null {
  let points = ring;
  for (const edge of [0, 1]) {
    const inside = (y: number) => (edge === 0 ? y >= 0 : y <= 1);
    const clipped: Position[] = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      const ya = getMercatorY(a[1]);
      const yb = getMercatorY(b[1]);
      if (inside(ya)) clipped.push(a);
      if (inside(ya) !== inside(yb)) {
        clipped.push(interpolate(a, b, (edge - ya) / (yb - ya), edge));
      }
    }
    points = clipped;
  }
  const [first] = points;
  const last = points[points.length - 1];
  if (first && (first[0] !== last[0] || first[1] !== last[1])) {
    points.push(first);
  }
  return points.length >= 4 ? points : null;
}

/** A polygon's rings cut at the edges of the world, or `null` if its outer ring is gone. */
function clipPolygon(rings: Position[][]): Position[][] | null {
  const [outer, ...holes] = rings.map(ring => (ring.every(isInside) ? ring : clipRing(ring)));
  return outer ? [outer, ...holes.filter((hole): hole is Position[] => hole !== null)] : null;
}

type Geometry = {type: string; coordinates?: any; geometries?: Geometry[]};

/** Whether all of a geometry's positions are in the Web Mercator world. */
function isGeometryInside(geometry: Geometry): boolean {
  if (geometry.type === 'GeometryCollection') {
    return (geometry.geometries || []).every(isGeometryInside);
  }
  const visit = (value: any): boolean =>
    !Array.isArray(value) || (typeof value[0] === 'number' ? isInside(value) : value.every(visit));
  return visit(geometry.coordinates);
}

/** A geometry cut at the edges of the Web Mercator world, or `null` if none of it is left. */
function clipGeometry(geometry: Geometry): Geometry | null {
  const {type, coordinates} = geometry;
  const multi = (multiType: string, parts: unknown[], singleType: string): Geometry | null =>
    parts.length === 0
      ? null
      : parts.length === 1
        ? {type: singleType, coordinates: parts[0]}
        : {type: multiType, coordinates: parts};
  switch (type) {
    case 'Point':
      return isInside(coordinates) ? geometry : null;
    case 'MultiPoint':
      return multi('MultiPoint', coordinates.filter(isInside), 'Point');
    case 'LineString':
      return multi('MultiLineString', clipLine(coordinates), 'LineString');
    case 'MultiLineString':
      return multi('MultiLineString', coordinates.flatMap(clipLine), 'LineString');
    case 'Polygon':
      return multi('MultiPolygon', [clipPolygon(coordinates)].filter(Boolean), 'Polygon');
    case 'MultiPolygon':
      return multi('MultiPolygon', coordinates.map(clipPolygon).filter(Boolean), 'Polygon');
    case 'GeometryCollection': {
      const geometries = (geometry.geometries || [])
        .map(child => (isGeometryInside(child) ? child : clipGeometry(child)))
        .filter((child): child is Geometry => child !== null);
      return geometries.length ? {type, geometries} : null;
    }
    default:
      return geometry;
  }
}

/**
 * GeoJSON data without what lies past the edges of the Web Mercator world, at +-85.0511 degrees,
 * and how many features it dropped or cut. geojson-vt clamps latitudes past them onto them: a
 * point at -89.5 degrees is drawn at -85.0511 degrees, which only a Web Mercator view cannot show
 * apart. Here points past them are dropped, and lines and polygons end where they cross them, as
 * straight lines in Web Mercator, as geojson-vt draws them. Features all inside are kept as they
 * are, and data all inside is returned as it is.
 */
export function clipFeaturesToMercatorRange(data: unknown): {data: unknown; outside: number} {
  let outside = 0;
  const clipFeature = (feature: any): any => {
    const geometry = feature?.geometry as Geometry | null | undefined;
    if (!geometry || isGeometryInside(geometry)) {
      return feature;
    }
    outside++;
    const clipped = clipGeometry(geometry);
    return clipped ? {...feature, geometry: clipped} : null;
  };
  const value = data as {type?: string; features?: unknown[]};
  if (value?.type === 'FeatureCollection' && Array.isArray(value.features)) {
    const features = value.features.map(clipFeature);
    return outside ? {data: {...value, features: features.filter(Boolean)}, outside} : {data, outside};
  }
  if (value?.type === 'Feature') {
    const feature = clipFeature(value);
    return {data: feature ?? {type: 'FeatureCollection', features: []}, outside};
  }
  if (value && typeof value === 'object' && 'type' in value) {
    const geometry = value as Geometry;
    if (isGeometryInside(geometry)) {
      return {data, outside};
    }
    const clipped = clipGeometry(geometry);
    return {data: clipped ?? {type: 'FeatureCollection', features: []}, outside: 1};
  }
  return {data, outside};
}

/** A ring's signed area in tile units, as `@mapbox/vector-tile` computes it. */
function getSignedArea(ring: [number, number][]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] - ring[i][0]) * (ring[i][1] + ring[j][1]);
  }
  return sum;
}

/**
 * Groups a polygon feature's rings into polygons, as MapLibre GL JS does for vector tiles: a ring
 * wound as the first one starts a polygon, and a ring wound the other way is a hole of the
 * polygon before it. Rings without area are dropped.
 */
function classifyRings(rings: [number, number][][]): [number, number][][][] {
  const polygons: [number, number][][][] = [];
  let polygon: [number, number][][] | undefined;
  let clockwise: boolean | undefined;
  for (const ring of rings) {
    const area = getSignedArea(ring);
    if (area === 0) {
      continue;
    }
    clockwise ??= area < 0;
    if (clockwise === area < 0) {
      polygon = [ring];
      polygons.push(polygon);
    } else {
      polygon?.push(ring);
    }
  }
  return polygons;
}

/** A geojson-vt tile feature's GeoJSON geometry, in tile units; `null` for a polygon without area. */
function getGeometry(feature: GeoJSONVTFeature): {type: GeometryType; coordinates: unknown} | null {
  if (feature.type === 1) {
    const points = feature.geometry;
    return points.length === 1
      ? {type: 'Point', coordinates: points[0]}
      : {type: 'MultiPoint', coordinates: points};
  }
  if (feature.type === 2) {
    const lines = feature.geometry;
    return lines.length === 1
      ? {type: 'LineString', coordinates: lines[0]}
      : {type: 'MultiLineString', coordinates: lines};
  }
  const polygons = classifyRings(feature.geometry);
  if (polygons.length === 0) {
    return null;
  }
  return polygons.length === 1
    ? {type: 'Polygon', coordinates: polygons[0]}
    : {type: 'MultiPolygon', coordinates: polygons};
}

/**
 * Cuts one tile from a tile index, as MapLibre GL JS cuts it, and encodes its features. Its typed
 * arrays' buffers can be transferred.
 */
export function cutTile(index: GeoJSONVT, z: number, x: number, y: number): EncodedTile {
  const features: EncodedFeature[] = [];
  const positions: number[] = [];
  const lengths: number[] = [];

  const writeCoordinates = (coordinates: any, depth: number) => {
    if (depth === 0) {
      positions.push(coordinates[0], coordinates[1]);
      return;
    }
    lengths.push(coordinates.length);
    for (const child of coordinates) {
      writeCoordinates(child, depth - 1);
    }
  };

  for (const feature of index.getTile(z, x, y)?.features || []) {
    const geometry = getGeometry(feature);
    if (!geometry) {
      continue;
    }
    writeCoordinates(geometry.coordinates, GEOMETRY_DEPTHS[geometry.type]);
    const encoded: EncodedFeature = {type: geometry.type, properties: feature.tags || {}};
    if (feature.id !== undefined) {
      encoded.id = feature.id;
    }
    features.push(encoded);
  }
  return {features, positions: Int32Array.from(positions), lengths: Uint32Array.from(lengths)};
}

/**
 * The GeoJSON features of an encoded tile, in the normalized tile-local coordinates of decoded
 * vector tiles: the vector tile path then draws them as it draws vector tiles.
 */
export function decodeTile(tile: EncodedTile): Record<string, unknown>[] {
  const {positions, lengths} = tile;
  let position = 0;
  let length = 0;

  const readCoordinates = (depth: number): unknown => {
    if (depth === 0) {
      const point = [
        positions[position] / GEOJSON_TILE_EXTENT,
        positions[position + 1] / GEOJSON_TILE_EXTENT
      ];
      position += 2;
      return point;
    }
    const count = lengths[length++];
    const children = new Array(count);
    for (let i = 0; i < count; i++) {
      children[i] = readCoordinates(depth - 1);
    }
    return children;
  };

  return tile.features.map(({type, properties, id}) => {
    const feature: Record<string, unknown> = {
      type: 'Feature',
      geometry: {type, coordinates: readCoordinates(GEOMETRY_DEPTHS[type])},
      properties
    };
    if (id !== undefined) {
      feature.id = id;
    }
    return feature;
  });
}
