// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {Task} from '@math.gl/tasks';
import {createGeoJsonResourceState, runGeoJsonResource, type GeoJsonResourceState} from './geojson-resource';
import type {GeoJsonWorkerRequest} from './geojson-worker';
import type {cutTile} from './geojson-tiler';

/** A source error is distinct from a failure of the worker transport. */
export type GeoJsonTaskResult = {tile: ReturnType<typeof cutTile> | null} | {error: string};

/** Stateful GeoJSON tiling resource; one worker owns all source indexes. */
export const GeoJsonTask = {
  id: 'tangram-geojson',
  worker: {
    create: () => new Worker(new URL('./geojson-task-worker.js', import.meta.url), {type: 'module'}),
    capabilities: {atomic: true, streaming: false}
  },
  initialize: (_input: object) => createGeoJsonResourceState(),
  process: (input, _options: object, {state}): GeoJsonTaskResult => {
    try {
      return {tile: runGeoJsonResource(state, input)};
    } catch (error) {
      return {error: error instanceof Error ? error.message : String(error)};
    }
  }
} satisfies Task<{input: GeoJsonWorkerRequest; output: GeoJsonTaskResult; state: GeoJsonResourceState}>;
