// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Deck, OrthographicView} from '@deck.gl/core';
import {webgpuAdapter} from 'https://esm.sh/@luma.gl/webgpu@9.4.0?bundle&external=@luma.gl/core';
import {ProjectedBasemapLayer, createProjectedBasemapScene} from '@vis.gl/tangram-layers/experimental/projected-basemaps';

const parameters = new URLSearchParams(location.search);
const device = parameters.get('device') || (navigator.gpu ? 'webgpu' : 'webgl');
const projectionSelector = document.querySelector('#projection');
const basemapSelector = document.querySelector('#basemap');
const status = document.querySelector('#status');
projectionSelector.value = parameters.get('projection') || 'equal-earth';
basemapSelector.value = parameters.get('basemap') || 'vector';
let deck;

/** Update only the status text; provider attribution is displayed independently of load success. */
function setStatus(message, error = false) {
  status.textContent = message;
  status.dataset.error = String(error);
}

/** A ground-only OpenMapTiles scene: no silent unprojected lines, labels or building extrusions. */
function createScene(raster) {
  return {
    scene: {background: {color: '#0b1729'}},
    sources: raster
      ? {map: {type: 'Raster', url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg', max_zoom: 6}}
      : {map: {type: 'MVT', url: '', tilejson: 'https://tiles.openfreemap.org/planet', max_zoom: 6}},
    layers: raster ? {ground: {data: {source: 'map'}, draw: {raster: {order: 0}}}} : {
      landcover: {data: {source: 'map', layer: 'landcover'}, draw: {polygons: {order: 0, color: '#3b6552'}}},
      landuse: {data: {source: 'map', layer: 'landuse'}, draw: {polygons: {order: 1, color: '#537d63'}}},
      water: {data: {source: 'map', layer: 'water'}, draw: {polygons: {order: 2, color: '#388ab3'}}}
    }
  };
}

/** Load projected ground geometry; Tangram resolves the provider's current TileJSON source. */
async function initialize() {
  setStatus('Loading projected ground meshes…');
  const raster = basemapSelector.value === 'raster';
  const scene = createScene(raster);
  const type = projectionSelector.value;
  const prepared = createProjectedBasemapScene(scene, {type},
    new URL('../../modules/tangram-renderer/dist/projected-basemaps-worker.js', import.meta.url).href);
  document.querySelector('#attribution').innerHTML = raster
    ? 'Imagery: <a href="https://www.earthdata.nasa.gov/engage/open-data-services-and-software/earthdata-developer-portal/gibs">NASA GIBS / Blue Marble</a>'
    : '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a> | © <a href="https://openmaptiles.org/">OpenMapTiles</a> | <a href="https://openfreemap.org/">OpenFreeMap</a>';
  deck?.finalize();
  deck = new Deck({parent: document.querySelector('#projected-map'),
    deviceProps: device === 'webgpu' ? {type: 'webgpu', adapters: [webgpuAdapter]} : {type: 'webgl'},
    views: new OrthographicView({id: 'projected', flipY: false, controller: true}),
    initialViewState: {target: [0, 0, 0], zoom: type === 'albers' ? 0 : -1.5},
    layers: [new ProjectedBasemapLayer({id: 'projected-basemap', scene: prepared, projectedTileZoom: 2,
      onSceneLoad: () => setStatus('Worker CPU projection enabled. Drag to pan and scroll to zoom.'),
      onSceneError: error => setStatus(error.message, true)})],
    onError: error => {setStatus(error.message, true); return true;}});
}

/** Retain configuration in the URL when changing the rendering device. */
function navigateDevice(nextDevice) {
  const url = new URL(location.href);
  url.searchParams.set('device', nextDevice);
  url.searchParams.set('projection', projectionSelector.value);
  url.searchParams.set('basemap', basemapSelector.value);
  location.assign(url);
}
document.querySelectorAll('[data-device]').forEach(button => {
  button.disabled = button.dataset.device === device;
  button.addEventListener('click', () => navigateDevice(button.dataset.device));
});
projectionSelector.addEventListener('change', () => initialize().catch(error => setStatus(error.message, true)));
basemapSelector.addEventListener('change', () => initialize().catch(error => setStatus(error.message, true)));
document.querySelector('#fullscreen').addEventListener('click', () => {
  document.querySelector('#projected-map').requestFullscreen().catch(error => setStatus(error.message, true));
});
window.addEventListener('pagehide', () => deck?.finalize());
initialize().catch(error => setStatus(error.message, true));
