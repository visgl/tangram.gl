// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Deck, OrthographicView} from '@deck.gl/core';
import {webgpuAdapter} from 'https://esm.sh/@luma.gl/webgpu@9.4.0?bundle&external=@luma.gl/core';
import {ProjectedBasemapLayer, createProjectedBasemapScene} from '@vis.gl/tangram-layers/experimental/projected-basemaps';
import {createBlueMarbleScene} from '../classic/app/nasa-basemap.js';
import {createVectorSource} from '../classic/app/vector-providers.js';
import {getConfiguredAttributions, updateAttribution} from '../classic/app/attribution.js';

const parameters = new URLSearchParams(location.search);
const device = parameters.get('device') || (navigator.gpu ? 'webgpu' : 'webgl');
const projectionSelector = document.querySelector('#projection');
const basemapSelector = document.querySelector('#basemap');
const status = document.querySelector('#status');
projectionSelector.value = parameters.get('projection') || 'equal-earth';
basemapSelector.value = parameters.get('basemap') === 'vector' ? 'vector' : 'raster';
let deck;
let preparedScene;
let preparedBasemap;
let activeProjection;
let updateGeneration = 0;

/** Update only the status text; provider attribution is displayed independently of load success. */
function setStatus(message, error = false) {
  status.textContent = message;
  status.dataset.type = error ? 'error' : '';
}

/** A ground-only OpenMapTiles scene: no silent unprojected lines, labels or building extrusions. */
function createScene(raster) {
  if (raster) return createBlueMarbleScene();
  return {
    scene: {background: {color: '#0b1729'}},
    sources: {map: {...createVectorSource(), max_zoom: 6}},
    layers: {
      landcover: {data: {source: 'map', layer: 'landcover'}, draw: {polygons: {order: 0, color: '#3b6552'}}},
      landuse: {data: {source: 'map', layer: 'landuse'}, draw: {polygons: {order: 1, color: '#537d63'}}},
      water: {data: {source: 'map', layer: 'water'}, draw: {polygons: {order: 2, color: '#388ab3'}}}
    }
  };
}

/** Load projected ground geometry; Tangram resolves the provider's current TileJSON source. */
async function initialize() {
  const type = projectionSelector.value;
  if (deck && preparedBasemap === basemapSelector.value && activeProjection === type) return;
  activeProjection = type;
  const generation = ++updateGeneration;
  setStatus('Loading projected ground meshes…');
  const raster = basemapSelector.value === 'raster';
  if (preparedBasemap !== basemapSelector.value) {
    preparedBasemap = basemapSelector.value;
    preparedScene = createProjectedBasemapScene(createScene(raster), {type},
      new URL('../../modules/tangram-renderer/dist/projected-basemaps-worker.js', import.meta.url).href);
  }
  updateAttribution(document.querySelector('#attribution'), getConfiguredAttributions(preparedScene));
  const url = new URL(location.href);
  url.searchParams.set('projection', type);
  url.searchParams.set('basemap', basemapSelector.value);
  history.replaceState(null, '', url);
  const layers = [new ProjectedBasemapLayer({id: 'projected-basemap', scene: preparedScene,
    projectedProjection: {type}, projectedTileZoom: 2,
    onProjectionChange: () => {
      if (generation === updateGeneration) setStatus('Worker CPU projection enabled. Drag to pan and scroll to zoom.');
    },
    onSceneError: error => {
      if (generation === updateGeneration) setStatus(error.message, true);
    }})];
  if (deck) {
    // Stable scene identity retains the renderer, workers, decoded sources and raster textures.
    deck.setProps({layers});
    return;
  }
  deck = new Deck({parent: document.querySelector('#projected-map'),
    deviceProps: device === 'webgpu' ? {type: 'webgpu', adapters: [webgpuAdapter]} : {type: 'webgl'},
    views: new OrthographicView({id: 'projected', flipY: false, controller: true}),
    initialViewState: {target: [0, 0, 0], zoom: type === 'albers' ? 0 : -1.5},
    layers,
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
  button.classList.toggle('is-active', button.dataset.device === device);
  button.setAttribute('aria-selected', String(button.dataset.device === device));
  button.addEventListener('click', () => navigateDevice(button.dataset.device));
});
projectionSelector.addEventListener('change', () => initialize().catch(error => setStatus(error.message, true)));
basemapSelector.addEventListener('change', () => initialize().catch(error => setStatus(error.message, true)));
document.querySelector('#fullscreen').addEventListener('click', () => {
  const target = document.querySelector('#deck-container');
  const transition = document.fullscreenElement ? document.exitFullscreen() : target.requestFullscreen();
  transition.catch(error => setStatus(error.message, true));
});
document.querySelectorAll('[data-example-tab]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('[data-example-tab]').forEach(tab => {
    const active = tab === button;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('[data-example-tab-panel]').forEach(panel => {
    panel.hidden = panel.dataset.exampleTabPanel !== button.dataset.exampleTab;
  });
}));
window.addEventListener('pagehide', () => deck?.finalize());
initialize().catch(error => setStatus(error.message, true));
