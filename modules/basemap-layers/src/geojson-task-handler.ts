// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {createResourceWorker} from '@math.gl/core/tasks';
import {createGeoJsonResourceState, runGeoJsonResource, type GeoJsonResourceState} from './geojson-resource';
import type {GeoJsonWorkerRequest} from './geojson-worker';
import type {GeoJsonTaskResult} from './geojson-task';

/** Install the stateful GeoJSON resource task handler on a worker global. */
export function installGeoJsonTaskHandler(): Promise<void> {
  return createResourceWorker({
    initialize: createGeoJsonResourceState,
    run: (state: GeoJsonResourceState, input: GeoJsonWorkerRequest): GeoJsonTaskResult => {
      try {
        return {tile: runGeoJsonResource(state, input)};
      } catch (error) {
        return {error: error instanceof Error ? error.message : String(error)};
      }
    }
  });
}
