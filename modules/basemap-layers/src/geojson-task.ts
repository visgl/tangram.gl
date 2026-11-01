// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {WorkerResourceObject} from '@math.gl/core/tasks';
import type {GeoJsonWorkerRequest} from './geojson-worker';
import type {cutTile} from './geojson-tiler';

/** A source error is distinct from a failure of the worker transport. */
export type GeoJsonTaskResult = {tile: ReturnType<typeof cutTile> | null} | {error: string};

/** Stateful GeoJSON tiling resource; one worker owns all source indexes. */
export const GeoJsonTask: WorkerResourceObject<null, GeoJsonWorkerRequest, GeoJsonTaskResult> = {
  id: 'tangram-geojson',
  name: 'Tangram GeoJSON tiler',
  module: 'tangram-basemap-layers',
  version: '0.0.1',
  worker: true,
  options: {},
  loadWorker: () => new Worker(new URL('./geojson-task-worker.js', import.meta.url), {type: 'module'})
};
