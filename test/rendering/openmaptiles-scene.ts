// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {MVTWriter} from '@loaders.gl/mvt';
import {createScene} from './scene';

/** One authored tile, centered away from tile edges and the antimeridian. */
const TILE_INDEX = {x: 4824, y: 6159, z: 14};
/** Geographic anchor shared by MVT projection and every camera. */
export function getOpenMapTilesAnchor(zoom = 14) {
  const tileIndex = getTileIndex(zoom);
  return {
    longitude: (tileIndex.x + 0.5) / 2 ** zoom * 360 - 180,
    latitude: Math.atan(Math.sinh(Math.PI * (1 - 2 * (tileIndex.y + 0.5) / 2 ** zoom))) * 180 / Math.PI
  };
}

/** Keep city and regional globe fixtures in the same geographic tile family. */
function getTileIndex(zoom: number) {
  return {x: Math.floor(TILE_INDEX.x / 2 ** (14 - zoom)),
    y: Math.floor(TILE_INDEX.y / 2 ** (14 - zoom)), z: zoom};
}

/** Encode real MVT bytes with representative OpenMapTiles collection/property names. */
export function createOpenMapTilesUrl(zoom = 14) {
  const {longitude, latitude} = getOpenMapTilesAnchor(zoom);
  const scale = zoom <= 3 ? 1000 : 1;
  const layers = [
    {name: 'transportation', geometry: {type: 'LineString', coordinates: [
      [longitude - 0.004 * scale, latitude], [longitude + 0.004 * scale, latitude]
    ]}, properties: {class: 'motorway', brunnel: 'bridge', ref: 'I-1'}},
    {name: 'building', geometry: {type: 'Polygon', coordinates: [[
      [longitude - 0.0005 * scale, latitude + 0.0005 * scale], [longitude + 0.0005 * scale, latitude + 0.0005 * scale],
      [longitude + 0.0005 * scale, latitude + 0.0015 * scale], [longitude - 0.0005 * scale, latitude + 0.0015 * scale],
      [longitude - 0.0005 * scale, latitude + 0.0005 * scale]
    ]]}, properties: {name: 'openmaptiles-building', render_height: 120 * scale, render_min_height: 20 * scale}},
    {name: 'place', geometry: {type: 'Point', coordinates: [longitude, latitude - 0.001 * scale]},
      properties: {class: 'city', name: 'Fixture City', rank: 1}}
  ];
  // Concatenating root protobuf messages combines their repeated Tile.layers fields.
  const chunks = layers.map((layer, index) => new Uint8Array(MVTWriter.encodeSync({
    type: 'FeatureCollection', features: [{type: 'Feature', id: index + 1,
      geometry: layer.geometry, properties: layer.properties}]
  }, {mvt: {layerName: layer.name, tileIndex: getTileIndex(zoom), extent: 4096}})));
  const bytes = chunks.flatMap(chunk => Array.from(chunk));
  return `data:application/vnd.mapbox-vector-tile;base64,${btoa(String.fromCharCode(...bytes))}#/{z}/{x}/{y}`;
}

/** Worker-evaluated OpenMapTiles feature properties used by real extrusion styling. */
declare const feature: {render_min_height?: number; render_height?: number};

/** Serialize a closure-free feature function into the scene worker. */
function buildingExtrusion() {
  return [feature.render_min_height || 0, feature.render_height || 0];
}

/** Build an offline scene that consumes tile schema fields rather than GeoJSON aliases. */
export function createOpenMapTilesScene(url: string, animated = false, extruded = true, labels = true, zoom = 14) {
  const {longitude, latitude} = getOpenMapTilesAnchor(zoom);
  const scale = zoom <= 3 ? 1000 : 1;
  const scene = createScene(url, '#20d0b0', animated);
  return {...scene,
    sources: {fixture: {type: 'MVT', url, max_zoom: zoom, tile_size: 512,
      bounds: [longitude - 0.005 * scale, latitude - 0.005 * scale, longitude + 0.005 * scale, latitude + 0.005 * scale]}},
    layers: {
      roads: {data: {source: 'fixture', layer: 'transportation'}, filter: {class: 'motorway'},
        draw: {traffic: {order: 2, color: '#20d0b0', width: '10px'}}},
      buildings: {data: {source: 'fixture', layer: 'building'},
        draw: {polygons: {order: 1, color: '#ff6020', extrude: extruded ? buildingExtrusion : false,
          interactive: true}}},
      places: {data: {source: 'fixture', layer: 'place'}, enabled: labels,
        draw: {text: {order: 3, text_source: 'name', font: {family: 'sans-serif', size: '24px', fill: '#5080ff'}}}}
    }
  };
}
