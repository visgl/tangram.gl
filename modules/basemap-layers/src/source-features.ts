// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {compileStyleFilter} from './style-expression';
import type {BasemapSource} from './style-resolver';

/** The parameters of {@link BasemapLayer.querySourceFeatures}, as MapLibre GL JS's. */
export type QuerySourceFeaturesOptions = {
  /**
   * The source layer to read. Required for a `vector` source, where no features are returned
   * without it, and ignored for a `geojson` source.
   */
  sourceLayer?: string;
  /** A style-spec filter expression that the features must match. */
  filter?: unknown[] | null;
};

/**
 * A feature returned by {@link BasemapLayer.querySourceFeatures}: a GeoJSON feature in longitude
 * and latitude, as MapLibre GL JS returns one, with the source it was read from and the tile it was
 * read in.
 */
export type BasemapSourceFeature = {
  type: 'Feature';
  /** The feature id: the tile feature's id, or the property that the source's `promoteId` names. */
  id?: string | number;
  /** The feature's geometry in the tile, in longitude and latitude. */
  geometry: {type: string; coordinates: unknown};
  /** The feature's properties. */
  properties: Record<string, unknown>;
  /** The id of the style source the feature was read from. */
  source: string;
  /** The source layer the feature was read from, for a `vector` source. */
  sourceLayer?: string;
  /** The index of the tile the feature was read from. */
  tile: {x: number; y: number; z: number};
};

/** The part of a loaded tile that the query reads. */
export type QueriedTile = {
  index: {x: number; y: number; z: number};
  isLoaded: boolean;
  content: unknown;
};

/**
 * The features of a vector or GeoJSON source in `tiles`, as MapLibre GL JS's
 * `Map#querySourceFeatures` reads them from the tiles it renders: every feature of the source
 * layer that matches the filter, whether a style layer draws it or not. A tile that is in `tiles`
 * more than once, as for the copies of the world, is read once. A feature that crosses a tile edge,
 * or a point in the buffer of two tiles, is returned once per tile, as in MapLibre.
 *
 * `["zoom"]` in the filter is the zoom of the tile.
 */
export function querySourceFeaturesInTiles(
  tiles: readonly QueriedTile[],
  sourceId: string,
  source: BasemapSource,
  options: QuerySourceFeaturesOptions = {}
): BasemapSourceFeature[] {
  const isGeoJson = source.type === 'geojson';
  const sourceLayer = isGeoJson ? undefined : options.sourceLayer;
  if (!isGeoJson && !sourceLayer) {
    return [];
  }
  const filter = options.filter ? compileStyleFilter(options.filter) : null;

  const tilesByKey = new Map<string, {index: QueriedTile['index']; features: any[]}>();
  for (const tile of tiles) {
    if (!tile.isLoaded || !Array.isArray(tile.content)) {
      continue;
    }
    const {z, y} = tile.index;
    const size = 2 ** z;
    const x = ((tile.index.x % size) + size) % size;
    const key = `${z}/${x}/${y}`;
    tilesByKey.set(key, {index: {x, y, z}, features: tile.content});
  }
  const sortedTiles = [...tilesByKey.values()].sort(
    (a, b) => a.index.z - b.index.z || a.index.y - b.index.y || a.index.x - b.index.x
  );

  const result: BasemapSourceFeature[] = [];
  for (const {index, features} of sortedTiles) {
    const globals = {zoom: index.z};
    for (const feature of features) {
      if (!feature?.geometry) {
        continue;
      }
      if (!isGeoJson && feature.properties?.layerName !== sourceLayer) {
        continue;
      }
      const properties: Record<string, unknown> = {...feature.properties};
      if (!isGeoJson) {
        // The decoder records the source layer of each feature in its properties.
        delete properties.layerName;
      }
      if (filter && !filter(globals, {...feature, properties})) {
        continue;
      }
      const sourceFeature: BasemapSourceFeature = {
        type: 'Feature',
        geometry: getGeometryInLngLat(feature.geometry, index),
        properties,
        source: sourceId,
        tile: {...index}
      };
      const id = isGeoJson ? feature.id : getVectorFeatureId(feature, properties, source, sourceLayer!);
      if (id !== undefined && id !== null) {
        sourceFeature.id = id;
      }
      if (sourceLayer) {
        sourceFeature.sourceLayer = sourceLayer;
      }
      result.push(sourceFeature);
    }
  }
  return result;
}

/**
 * The id of a vector tile feature, as MapLibre GL JS gives it: the property that the source's
 * `promoteId` names (a name, or a name per source layer), else the feature's own id. A boolean id
 * is a number.
 */
function getVectorFeatureId(
  feature: {id?: unknown},
  properties: Record<string, unknown>,
  source: BasemapSource,
  sourceLayer: string
): string | number | undefined {
  const {promoteId} = source;
  let id: unknown = feature.id;
  if (promoteId) {
    const name =
      typeof promoteId === 'string'
        ? promoteId
        : (promoteId as Record<string, unknown>)[sourceLayer];
    id = typeof name === 'string' ? properties[name] : undefined;
    if (typeof id === 'boolean') {
      id = Number(id);
    }
  }
  return typeof id === 'string' || typeof id === 'number' ? id : undefined;
}

/** Converts tile-local geometry (0 to 1 across the tile, y down) to longitude and latitude. */
function getGeometryInLngLat(
  geometry: {type: string; coordinates?: unknown; geometries?: unknown[]},
  index: {x: number; y: number; z: number}
): BasemapSourceFeature['geometry'] {
  const size = 2 ** index.z;
  const convert = (coordinates: any): unknown => {
    if (typeof coordinates[0] === 'number') {
      const [x, y, ...rest] = coordinates;
      const lng = ((index.x + x) / size) * 360 - 180;
      const lat = (360 / Math.PI) * Math.atan(Math.exp((1 - (2 * (index.y + y)) / size) * Math.PI)) - 90;
      return [lng, lat, ...rest];
    }
    return coordinates.map(convert);
  };
  if (geometry.type === 'GeometryCollection') {
    return {
      ...geometry,
      geometries: (geometry.geometries || []).map(child => getGeometryInLngLat(child as any, index))
    } as unknown as BasemapSourceFeature['geometry'];
  }
  return {type: geometry.type, coordinates: convert(geometry.coordinates)};
}
