// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {initializeTaskWorker} from '@math.gl/tasks';
import {GeoJsonTask} from './geojson-task';

/** Install the stateful GeoJSON resource task handler on a worker global. */
export function installGeoJsonTaskHandler(): Promise<void> {
  return initializeTaskWorker(GeoJsonTask);
}
