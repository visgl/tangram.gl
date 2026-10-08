// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Deck, OrthographicView} from '@deck.gl/core';
import {webgpuAdapter} from 'https://esm.sh/@luma.gl/webgpu@9.4.0?bundle&external=@luma.gl/core';
import {ProjectedBasemapLayer, createProjectedBasemapScene} from '@vis.gl/tangram-layers/experimental/projected-basemaps';
import {countProjectedTileCoordinates} from '@vis.gl/tangram-renderer/core';
import {createProjectedExampleScene, getProjectedExampleTileZoom} from './scene.js';
import {getProjectedExampleBounds, getProjectedExampleDetailChoices} from './detail.js';
import {createProjectedExampleProjectionEngine} from './projection-engine.js';
import {getConfiguredAttributions, updateAttribution} from '../classic/app/attribution.js';

const parameters = new URLSearchParams(location.search);
// The caller owns one stable factory; the renderer caches independent compiled CRS transforms.
const projectionEngine = createProjectedExampleProjectionEngine();
const device = parameters.get('device') || (navigator.gpu ? 'webgpu' : 'webgl');
const projectionSelector = document.querySelector('#projection');
const basemapSelector = document.querySelector('#basemap');
const coverageSelector = document.querySelector('#coverage');
const detailSelector = document.querySelector('#detail');
const status = document.querySelector('#status');
projectionSelector.value = parameters.get('projection') || 'equal-earth';
basemapSelector.value = parameters.get('basemap') === 'vector' ? 'vector' : 'raster';
coverageSelector.value = parameters.get('coverage') === 'regional' ? 'regional' : 'world';
let selectedDetail = parameters.has('detail') ? Number(parameters.get('detail')) : undefined;
let deck;
let preparedScene;
let preparedBasemap;
let updateGeneration = 0;

/** Update only the status text; provider attribution is displayed independently of load success. */
function setStatus(message, error = false) {
  status.textContent = message;
  status.dataset.type = error ? 'error' : '';
}

/** Load projected ground geometry; Tangram resolves the provider's current TileJSON source. */
async function initialize() {
  const type = projectionSelector.value;
  const generation = ++updateGeneration;
  const raster = basemapSelector.value === 'raster';
  if (type === 'albers') coverageSelector.value = 'regional';
  coverageSelector.disabled = type === 'albers';
  const regional = coverageSelector.value === 'regional';
  const choices = getProjectedExampleDetailChoices(raster, regional, countProjectedTileCoordinates);
  if (!choices.some(choice => choice.zoom === selectedDetail && !choice.disabled)) {
    selectedDetail = getProjectedExampleTileZoom(raster);
  }
  detailSelector.replaceChildren(...choices.map(choice => {
    const option = new Option(`Zoom ${choice.zoom} — ${choice.tiles} tiles${choice.disabled ? ' (over budget)' : ''}`, String(choice.zoom));
    option.disabled = choice.disabled;
    return option;
  }));
  detailSelector.value = String(selectedDetail);
  // Detail/coverage changes do not emit onProjectionChange; describe settings, not pending work.
  setStatus(`Data zoom ${selectedDetail}; style zoom stays at 6. Drag to pan and scroll to zoom.`);
  if (preparedBasemap !== basemapSelector.value) {
    preparedBasemap = basemapSelector.value;
    preparedScene = createProjectedBasemapScene(createProjectedExampleScene(raster), {type},
      new URL('../../modules/tangram-renderer/dist/projected-basemaps-worker.js', import.meta.url).href);
  }
  updateAttribution(document.querySelector('#attribution'), getConfiguredAttributions(preparedScene));
  const url = new URL(location.href);
  url.searchParams.set('projection', type);
  url.searchParams.set('basemap', basemapSelector.value);
  url.searchParams.set('coverage', coverageSelector.value);
  url.searchParams.set('detail', String(selectedDetail));
  history.replaceState(null, '', url);
  const layers = [new ProjectedBasemapLayer({id: 'projected-basemap', scene: preparedScene, projectionEngine,
    // OpenFreeMap transportation starts at zoom 4; overview imagery only needs zoom 2.
    projectedProjection: {type}, projectedTileZoom: selectedDetail, projectedStyleZoom: 6,
    projectedVisibleBounds: getProjectedExampleBounds(regional), projectedMaxTiles: 256,
    tileResources: {maxConcurrentBuilds: 8, maxCachedTiles: 256, maxCachedMeshBytes: 32 * 1024 * 1024},
    onProjectionChange: () => {
      if (generation === updateGeneration) setStatus('Caller-supplied math.gl engine enabled. Drag to pan and scroll to zoom.');
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
coverageSelector.addEventListener('change', () => initialize().catch(error => setStatus(error.message, true)));
detailSelector.addEventListener('change', () => {
  selectedDetail = Number(detailSelector.value);
  initialize().catch(error => setStatus(error.message, true));
});
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
