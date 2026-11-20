// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {Task} from '@math.gl/tasks';
import {createGeoJsonResourceState, runGeoJsonResource, type GeoJsonResourceState} from './geojson-resource';
import type {GeoJsonWorkerRequest} from './geojson-worker';
import type {cutTile} from './geojson-tiler';

/**
 * A source error is distinct from a failure of the worker transport. An index request reports how
 * many features it dropped or cut at the edges of the Web Mercator world in `outside`.
 */
export type GeoJsonTaskResult =
  | {tile: ReturnType<typeof cutTile> | null; outside?: number}
  | {error: string};

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
      const output = runGeoJsonResource(state, input);
      return typeof output === 'number' ? {tile: null, outside: output} : {tile: output};
    } catch (error) {
      return {error: error instanceof Error ? error.message : String(error)};
    }
  }
} satisfies Task<{input: GeoJsonWorkerRequest; output: GeoJsonTaskResult; state: GeoJsonResourceState}>;
