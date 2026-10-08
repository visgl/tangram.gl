// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Deck, OrthographicView} from '@deck.gl/core';
import {webgpuAdapter} from '@luma.gl/webgpu';
import {ProjectedBasemapLayer, createProjectedBasemapScene, ProjectedBasemapNavigation,
  selectProjectedTileDetail} from '@vis.gl/tangram-layers/experimental/projected-basemaps';
import {countProjectedTileCoordinates} from '@vis.gl/tangram-renderer/core';
import {createProjectedExampleScene, getProjectedExampleTileZoom} from './scene.js';
import {getProjectedExampleBounds, getProjectedExampleDetailChoices} from './detail.js';
import {createProjectedExampleProjectionEngine} from './projection-engine.js';
import {getConfiguredAttributions, updateAttribution} from '../classic/app/attribution.js';

const parameters = new URLSearchParams(location.search);
// The caller owns one stable factory; the renderer caches independent compiled CRS transforms.
const projectionEngine = createProjectedExampleProjectionEngine();
const navigation = new ProjectedBasemapNavigation(projectionEngine);
const device = parameters.get('device') || (navigator.gpu ? 'webgpu' : 'webgl');
const projectionSelector = document.querySelector('#projection');
const basemapSelector = document.querySelector('#basemap');
const coverageSelector = document.querySelector('#coverage');
const detailSelector = document.querySelector('#detail');
const detailMode = document.querySelector('#detail-mode');
const coordinateProbe = document.querySelector('#coordinates');
const status = document.querySelector('#status');
projectionSelector.value = parameters.get('projection') || 'equal-earth';
basemapSelector.value = parameters.get('basemap') === 'vector' ? 'vector' : 'raster';
coverageSelector.value = parameters.get('coverage') === 'regional' ? 'regional' : 'world';
detailMode.value = parameters.get('detailMode') === 'camera' ? 'camera' : 'manual';
let selectedDetail = parameters.has('detail') ? Number(parameters.get('detail')) : undefined;
let deck;
let preparedScene;
let preparedBasemap;
let updateGeneration = 0;
let projectionGeneration = 0;
let projectionPending = false;
let navigationGeneration = 0;
let probeGeneration = 0;
let detailTimer;
let disposed = false;
let viewState = {target: [0, 0, 0], zoom: projectionSelector.value === 'albers' ? 0 : -1.5};
let activeProjection = projectionSelector.value;
let loadingBounds;
let coverageEmpty = false;

/** Coalesce camera updates and discard obsolete projection, coverage or camera calculations. */
function scheduleDetail() {
  const generation = ++navigationGeneration;
  clearTimeout(detailTimer);
  if (disposed || projectionPending || detailMode.value !== 'camera') return;
  detailTimer = setTimeout(async () => {
    const viewport = deck?.getViewports()[0];
    if (!viewport) return;
    try {
      const coverage = await navigation.getCameraCoverage(viewport, activeProjection,
        getProjectedExampleBounds(coverageSelector.value === 'regional'));
      if (disposed || generation !== navigationGeneration) return;
      if (!coverage.bounds) {
        if (!coverageEmpty) {coverageEmpty = true; await initialize(false);}
        setStatus('Camera is outside the loading region. The scene and tile cache remain warm.');
        return;
      }
      const result = await selectProjectedTileDetail(navigation, viewport, activeProjection, {
        visibleBounds: coverage.bounds,
        minZoom: basemapSelector.value === 'raster' ? 0 : 4,
        maxZoom: 6, maxTiles: 256, targetTilePixels: 256, currentTileZoom: selectedDetail});
      if (disposed || generation !== navigationGeneration) return;
      if (coverageEmpty || selectedDetail !== result.tileZoom || JSON.stringify(loadingBounds) !== JSON.stringify(coverage.bounds)) {
        coverageEmpty = false;
        loadingBounds = coverage.bounds;
        selectedDetail = result.tileZoom;
        await initialize(false);
        return;
      }
      setStatus(`Camera detail ${result.tileZoom}: ${result.candidateCount} candidates, sampled span ${Math.round(result.estimatedTilePixels)} CSS px.${coverage.domainFallback ? ' Albers retains the full loading region.' : ''}${result.budgetLimited ? ' Candidate budget reached.' : ''}${result.detailLimited ? ' Maximum detail reached.' : ''}`);
    } catch (error) {
      if (!disposed && generation === navigationGeneration) setStatus(error.message, true);
    }
  }, 120);
}

/** Keep the geographic focus when replacing a projection, without rebuilding the source scene. */
async function changeProjection() {
  const generation = ++projectionGeneration;
  projectionPending = true;
  navigationGeneration++;
  probeGeneration++;
  clearTimeout(detailTimer);
  const type = projectionSelector.value;
  try {
    let previousState;
    let transition;
    do {
      previousState = viewState;
      transition = await navigation.reprojectViewState(previousState, activeProjection, type);
      if (disposed || generation !== projectionGeneration) return;
      // Recompute against the latest drag/fit without replacing the user's requested projection.
    } while (previousState !== viewState);
    projectionPending = false;
    viewState = {...viewState, ...transition.viewState};
    activeProjection = type;
    deck?.setProps({viewState});
    await initialize();
    if (generation === projectionGeneration && (transition.clamped || transition.domainFallback)) {
      setStatus(transition.clamped ? 'Geographic focus clamped to the destination projection domain.' : 'Outside-domain focus reset to the destination region center.');
    }
  } catch (error) {
    if (!disposed && generation === projectionGeneration) {
      projectionPending = false;
      projectionSelector.value = activeProjection;
      setStatus(error.message, true);
      scheduleDetail();
    }
  }
}

/** Fit the configured loading region, without replacing the scene, workers or factory. */
async function fitLoadingRegion() {
  const generation = ++navigationGeneration;
  clearTimeout(detailTimer);
  const viewport = deck?.getViewports()[0];
  if (!viewport) return;
  try {
    const fitted = await navigation.fitBounds(getProjectedExampleBounds(coverageSelector.value === 'regional'),
      viewport, activeProjection);
    if (disposed || generation !== navigationGeneration) return;
    viewState = fitted;
    probeGeneration++;
    deck.setProps({viewState});
    scheduleDetail();
  } catch (error) {
    if (!disposed && generation === navigationGeneration) setStatus(error.message, true);
  }
}

/** Invert CSS cursor coordinates on the ground plane; this does not select rendered features. */
async function probeCoordinates(event) {
  const generation = ++probeGeneration;
  const viewport = deck?.getViewports()[0];
  if (!viewport || disposed) return;
  const rectangle = document.querySelector('#projected-map').getBoundingClientRect();
  try {
    const position = await navigation.unprojectScreenPosition(viewport,
      [event.clientX - rectangle.left, event.clientY - rectangle.top], activeProjection);
    if (disposed || generation !== probeGeneration) return;
    coordinateProbe.textContent = position ? `${position[0].toFixed(4)}°, ${position[1].toFixed(4)}°` : 'Outside projection domain';
  } catch (error) {
    if (!disposed && generation === probeGeneration) coordinateProbe.textContent = error.message;
  }
}

/** Update only the status text; provider attribution is displayed independently of load success. */
function setStatus(message, error = false) {
  status.textContent = message;
  status.dataset.type = error ? 'error' : '';
}

/** Load projected ground geometry; Tangram resolves the provider's current TileJSON source. */
async function initialize(resetCoverage = true) {
  if (disposed) return;
  navigationGeneration++;
  probeGeneration++;
  clearTimeout(detailTimer);
  const type = activeProjection;
  if (!projectionPending) projectionSelector.value = type;
  const generation = ++updateGeneration;
  const raster = basemapSelector.value === 'raster';
  if (type === 'albers') coverageSelector.value = 'regional';
  coverageSelector.disabled = type === 'albers';
  const regional = coverageSelector.value === 'regional';
  if (resetCoverage || !loadingBounds) {
    loadingBounds = getProjectedExampleBounds(regional);
    coverageEmpty = false;
  }
  activeProjection = type;
  const choices = getProjectedExampleDetailChoices(raster, regional,
    (_bounds, zoom) => countProjectedTileCoordinates(loadingBounds, zoom));
  if (!choices.some(choice => choice.zoom === selectedDetail && !choice.disabled)) {
    selectedDetail = getProjectedExampleTileZoom(raster);
  }
  detailSelector.replaceChildren(...choices.map(choice => {
    const option = new Option(`Zoom ${choice.zoom} — ${choice.tiles} tiles${choice.disabled ? ' (over budget)' : ''}`, String(choice.zoom));
    option.disabled = choice.disabled;
    return option;
  }));
  detailSelector.value = String(selectedDetail);
  detailSelector.disabled = detailMode.value === 'camera';
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
  url.searchParams.set('detailMode', detailMode.value);
  history.replaceState(null, '', url);
  const layers = [new ProjectedBasemapLayer({id: 'projected-basemap', scene: preparedScene, projectionEngine,
    // OpenFreeMap transportation starts at zoom 4; overview imagery only needs zoom 2.
    projectedProjection: {type}, projectedTileZoom: selectedDetail, projectedStyleZoom: 6,
    projectedVisibleBounds: loadingBounds, projectedMaxTiles: 256, visible: !coverageEmpty,
    tileResources: {maxConcurrentBuilds: 8, maxCachedTiles: 256, maxCachedMeshBytes: 32 * 1024 * 1024},
    onProjectionChange: () => {
      if (!disposed && !projectionPending && generation === updateGeneration && detailMode.value === 'manual') setStatus('Caller-supplied math.gl engine enabled. Drag to pan and scroll to zoom.');
    },
    onSceneError: error => {
      if (!disposed && generation === updateGeneration) setStatus(error.message, true);
    }})];
  if (deck) {
    // Stable scene identity retains the renderer, workers, decoded sources and raster textures.
    deck.setProps({layers});
    scheduleDetail();
    return;
  }
  deck = new Deck({parent: document.querySelector('#projected-map'),
    deviceProps: device === 'webgpu' ? {type: 'webgpu', adapters: [webgpuAdapter]} : {type: 'webgl'},
    views: new OrthographicView({id: 'projected', flipY: false, controller: true}),
    viewState,
    onViewStateChange: event => {
      viewState = event.viewState;
      probeGeneration++;
      deck.setProps({viewState});
      scheduleDetail();
    },
    onLoad: scheduleDetail,
    onResize: scheduleDetail,
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
projectionSelector.addEventListener('change', changeProjection);
basemapSelector.addEventListener('change', () => initialize().catch(error => setStatus(error.message, true)));
coverageSelector.addEventListener('change', () => initialize().catch(error => setStatus(error.message, true)));
detailSelector.addEventListener('change', () => {
  selectedDetail = Number(detailSelector.value);
  initialize().catch(error => setStatus(error.message, true));
});
detailMode.addEventListener('change', () => initialize().catch(error => setStatus(error.message, true)));
document.querySelector('#fit-region').addEventListener('click', fitLoadingRegion);
document.querySelector('#projected-map').addEventListener('pointermove', probeCoordinates);
document.querySelector('#projected-map').addEventListener('pointerleave', () => {
  probeGeneration++;
  coordinateProbe.textContent = 'Move over the map to inspect coordinates';
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
window.addEventListener('pagehide', () => {
  disposed = true;
  projectionGeneration++;
  navigationGeneration++;
  probeGeneration++;
  clearTimeout(detailTimer);
  navigation.dispose();
  deck?.finalize();
});
initialize().catch(error => setStatus(error.message, true));
