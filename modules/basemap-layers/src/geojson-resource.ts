// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {GeoJSONVT} from '@maplibre/geojson-vt';
import type {GeoJsonWorkerRequest} from './geojson-worker';
import {createTileIndex, cutTile} from './geojson-tiler';

/** Worker-owned source indexes and not-yet-indexed feature batches. */
export type GeoJsonResourceState = {
  /** Feature batches received before indexing. */
  pendingFeatures: Map<number, unknown[]>;
  /** Successfully constructed indexes or their construction errors. */
  indexes: Map<number, GeoJSONVT | Error>;
};

/** Create the state held exclusively by one GeoJSON resource worker. */
export function createGeoJsonResourceState(): GeoJsonResourceState {
  return {pendingFeatures: new Map(), indexes: new Map()};
}

/**
 * Apply an ordered source operation. A tile request returns its tile, and an index request the
 * number of features dropped or cut at the edges of the Web Mercator world (see
 * `clipFeaturesToMercatorRange`).
 */
export function runGeoJsonResource(state: GeoJsonResourceState, message: GeoJsonWorkerRequest): ReturnType<typeof cutTile> | number | null {
  switch (message.type) {
    case 'features': {
      const features = state.pendingFeatures.get(message.source);
      if (features) for (const feature of message.features) features.push(feature);
      else state.pendingFeatures.set(message.source, message.features);
      return null;
    }
    case 'index': {
      const data = message.data ?? {type: 'FeatureCollection', features: state.pendingFeatures.get(message.source) || []};
      state.pendingFeatures.delete(message.source);
      try {
        const {index, outside} = createTileIndex(data, message.options, message.clipToMercatorRange);
        state.indexes.set(message.source, index);
        return outside;
      } catch (error) {
        state.indexes.set(message.source, error instanceof Error ? error : new Error(String(error)));
        return 0;
      }
    }
    case 'tile': {
      const index = state.indexes.get(message.source);
      if (!index) throw new Error('GeoJSON source has no index');
      if (index instanceof Error) throw index;
      return cutTile(index, message.z, message.x, message.y);
    }
    case 'remove':
      state.pendingFeatures.delete(message.source);
      state.indexes.delete(message.source);
      return null;
  }
}
