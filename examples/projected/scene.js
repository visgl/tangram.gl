// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {createBlueMarbleScene} from '../classic/app/nasa-basemap.js';
import {createVectorSource} from '../classic/app/vector-providers.js';

/** Overview imagery needs fewer tiles than OpenFreeMap's zoom-4 transportation layer. */
export function getProjectedExampleTileZoom(raster) {
  return raster ? 2 : 4;
}

/** Ground polygons and static pixel-width roads with portable traffic; no labels or building extrusions. */
export function createProjectedExampleScene(raster) {
  if (raster) return createBlueMarbleScene();
  return {
    scene: {background: {color: '#0b1729'}},
    styles: {traffic: {base: 'lines', lighting: false, animated: true}},
    // Avoid the provider helper's 512-pixel zoom bias: detail 4 must request XYZ zoom 4.
    sources: {map: {...createVectorSource(), tile_size: 256, max_zoom: 6}},
    layers: {
      landcover: {data: {source: 'map', layer: 'landcover'}, draw: {polygons: {order: 0, color: '#3b6552'}}},
      landuse: {data: {source: 'map', layer: 'landuse'}, draw: {polygons: {order: 1, color: '#537d63'}}},
      water: {data: {source: 'map', layer: 'water'}, draw: {polygons: {order: 2, color: '#388ab3'}}},
      roads: {data: {source: 'map', layer: 'transportation'},
        filter: {class: ['motorway', 'trunk', 'primary']},
        draw: {traffic: {order: 3, color: '#208d9f', width: '6px', cap: 'round', join: 'round',
          outline: {width: '1px', color: '#6542ac'}}}}
    }
  };
}
