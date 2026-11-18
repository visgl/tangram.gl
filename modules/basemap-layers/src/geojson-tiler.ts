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
  const clipped = clipToMercatorRange
    ? clipFeaturesToMercatorRange(data, options)
    : {data, outside: 0};
  // Cut data carries the ids that `generateId` gave the features of the data as it was.
  const indexOptions =
    clipped.data !== data && options.generateId ? {...options, generateId: false} : options;
  return {index: new GeoJSONVT(clipped.data as GeoJSON.GeoJSON, indexOptions), outside: clipped.outside};
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

/** How far past an edge of the world, in Web Mercator y, a position on the edge can round to. */
const EDGE_TOLERANCE = 1e-12;

/** Whether a Web Mercator y is in the world, or on its edge within rounding. */
const isInsideY = (y: number) => y >= -EDGE_TOLERANCE && y <= 1 + EDGE_TOLERANCE;

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

/** A part of a cut line, and where it starts and ends along the whole line, from 0 to 1. */
type LinePart = {line: Position[]; start: number; end: number};

/**
 * The parts of a line inside the Web Mercator world. A segment that crosses an edge of the world
 * ends where it crosses it, as geojson-vt cuts lines at tile edges. Each part keeps where it lies
 * along the whole line, measured as geojson-vt measures `line-progress`: in the Web Mercator
 * world square with latitudes clamped to it, here with the points where the line is cut.
 */
function clipLine(line: Position[]): LinePart[] {
  const points: Position[] = [];
  for (let i = 0; i < line.length; i++) {
    if (i > 0) {
      const a = line[i - 1];
      const ya = getMercatorY(a[1]);
      const dy = getMercatorY(line[i][1]) - ya;
      const crossings = [0, 1]
        .map(edge => ({edge, t: (edge - ya) / dy}))
        .filter(({t}) => t > 0 && t < 1)
        .sort((p, q) => p.t - q.t);
      for (const {edge, t} of crossings) points.push(interpolate(a, line[i], t, edge));
    }
    points.push(line[i]);
  }
  const ys = points.map(point => getMercatorY(point[1]));
  const distances = [0];
  for (let i = 1; i < points.length; i++) {
    const dx = (points[i][0] - points[i - 1][0]) / 360;
    const dy = Math.min(1, Math.max(0, ys[i])) - Math.min(1, Math.max(0, ys[i - 1]));
    distances.push(distances[i - 1] + Math.hypot(dx, dy));
  }
  const length = distances[distances.length - 1] || 1;
  const parts: LinePart[] = [];
  let first = -1;
  for (let i = 0; i < points.length; i++) {
    // A segment is inside when its middle is: its ends are inside or on an edge.
    const middle = i < points.length - 1 ? (ys[i] + ys[i + 1]) / 2 : NaN;
    const inside = isInsideY(middle);
    if (inside && first < 0) {
      first = i;
    } else if (!inside && first >= 0) {
      parts.push({line: points.slice(first, i + 1), start: distances[first] / length, end: distances[i] / length});
      first = -1;
    }
  }
  return parts;
}

/**
 * A polygon ring cut at the edges of the Web Mercator world (Sutherland-Hodgman), closed, or
 * `null` if less than a triangle is left.
 */
function clipRing(ring: Position[]): Position[] | null {
  let points = ring;
  for (const edge of [0, 1]) {
    const inside = (y: number) =>
      edge === 0 ? y >= -EDGE_TOLERANCE : y <= 1 + EDGE_TOLERANCE;
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

const getLines = (parts: LinePart[]) => parts.map(part => part.line);

/**
 * The properties that carry where a part of a cut line lies along the whole line, from 0 to 1,
 * for `line-progress` (see `cutTile`).
 */
const LINE_PART_START = 'tangram_line_part_start';
const LINE_PART_END = 'tangram_line_part_end';

/** The `line-progress` tags of geojson-vt, along the line it was given. */
const LINE_CLIP_START = 'geojsonvt_clip_start';
const LINE_CLIP_END = 'geojsonvt_clip_end';

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
      return multi('MultiLineString', getLines(clipLine(coordinates)), 'LineString');
    case 'MultiLineString':
      return multi('MultiLineString', getLines(coordinates.flatMap(clipLine)), 'LineString');
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
 *
 * With `generateId`, each feature of cut data carries the id that geojson-vt gives it in the data
 * as it was, its index: index the cut data without `generateId`. With `lineMetrics`, each part of a
 * cut line is a feature of its own that carries where it lies along the whole line, so that its
 * `line-progress` goes on along the line (see `cutTile`).
 */
export function clipFeaturesToMercatorRange(
  data: unknown,
  {generateId = false, lineMetrics = false}: {generateId?: boolean; lineMetrics?: boolean} = {}
): {data: unknown; outside: number} {
  let outside = 0;
  const clipFeature = (feature: any): any[] => {
    const geometry = feature?.geometry as Geometry | null | undefined;
    if (!geometry || isGeometryInside(geometry)) {
      return [feature];
    }
    outside++;
    const isLine = geometry.type === 'LineString' || geometry.type === 'MultiLineString';
    if (lineMetrics && isLine) {
      const lines: Position[][] =
        geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates;
      return lines.flatMap(clipLine).map(({line, start, end}) => ({
        ...feature,
        geometry: {type: 'LineString', coordinates: line},
        properties: {...feature.properties, [LINE_PART_START]: start, [LINE_PART_END]: end}
      }));
    }
    const clipped = clipGeometry(geometry);
    return clipped ? [{...feature, geometry: clipped}] : [];
  };
  const withIds = (features: any[], index: number) =>
    generateId ? features.map(feature => feature && {...feature, id: index}) : features;
  const value = data as {type?: string; features?: unknown[]};
  if (value?.type === 'FeatureCollection' && Array.isArray(value.features)) {
    const features = value.features.map(clipFeature);
    return outside
      ? {data: {...value, features: features.flatMap(withIds)}, outside}
      : {data, outside};
  }
  if (value?.type === 'Feature') {
    const features = clipFeature(value);
    return outside ? {data: {type: 'FeatureCollection', features: withIds(features, 0)}, outside} : {data, outside};
  }
  if (value && typeof value === 'object' && 'type' in value) {
    const geometry = value as Geometry;
    if (isGeometryInside(geometry)) {
      return {data, outside};
    }
    const features = clipFeature({type: 'Feature', properties: {}, geometry});
    return {data: {type: 'FeatureCollection', features: withIds(features, 0)}, outside};
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
 * A tile feature's properties. A part of a line cut at the edges of the Web Mercator world (see
 * `clipFeaturesToMercatorRange`) gets its `line-progress` along the whole line.
 */
function getProperties(tags: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!tags || !(LINE_PART_START in tags)) {
    return tags || {};
  }
  const {[LINE_PART_START]: start, [LINE_PART_END]: end, ...properties} = tags as Record<string, any>;
  if (LINE_CLIP_START in properties) {
    properties[LINE_CLIP_START] = start + properties[LINE_CLIP_START] * (end - start);
    properties[LINE_CLIP_END] = start + properties[LINE_CLIP_END] * (end - start);
  }
  return properties;
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
    const encoded: EncodedFeature = {type: geometry.type, properties: getProperties(feature.tags)};
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
