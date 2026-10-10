// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {createBlueMarbleScene} from '../classic/app/nasa-basemap.js';
import {createVectorSource} from '../classic/app/vector-providers.js';

/** Overview imagery needs fewer tiles than OpenFreeMap's zoom-4 transportation layer. */
export function getProjectedExampleTileZoom(raster) {
  return raster ? 2 : 4;
}

/** Ground basemaps, zoom-stop pixel roads and a small curated set of noncolliding annotations. */
export function createProjectedExampleScene(raster) {
  const scene = raster ? createBlueMarbleScene() : {
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
        draw: {traffic: {order: 3, color: '#208d9f', width: [[4, '3px'], [6, '6px'], [8, '10px']], cap: 'round', join: 'round',
          outline: {width: [[4, '1px'], [8, '2px']], color: '#6542ac'}}}}
    }
  };
  const features = [['New York', -74.006, 40.713], ['San Francisco', -122.419, 37.775],
    ['London', -0.128, 51.507], ['Tokyo', 139.692, 35.689], ['Sydney', 151.209, -33.869]]
    .map(([name, longitude, latitude]) => ({type: 'Feature', properties: {name},
      geometry: {type: 'Point', coordinates: [longitude, latitude]}}));
  const annotations = {type: 'GeoJSON',
    url: `data:application/json,${encodeURIComponent(JSON.stringify({type: 'FeatureCollection', features}))}`};
  const annotationLayer = {data: {source: 'annotations'}, draw: {
    points: {order: 10, size: '8px', color: '#ffcd66', collide: false, interactive: true,
      text: {text_source: 'name', collide: true, optional: true, anchor: 'top', offset: [0, -6],
        font: {family: 'sans-serif', size: '14px', fill: '#ffffff', stroke: {color: '#0b1729', width: 2}}}}
  }};
  return {...scene, sources: {...scene.sources, annotations}, layers: {...scene.layers, annotations: annotationLayer}};
}
