// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {installGeoJsonTaskHandler} from './geojson-task-handler';

// Keep all GeoJSON source indexes inside one worker resource.
void installGeoJsonTaskHandler();
