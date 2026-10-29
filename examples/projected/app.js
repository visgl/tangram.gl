// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {projectedMarkup} from './view.js';
import {Deck, OrthographicView} from '@deck.gl/core';
import {webgpuAdapter} from '@luma.gl/webgpu';
import {
  ProjectedBasemapLayer,
  createProjectedBasemapScene,
  ProjectedBasemapNavigation,
  selectProjectedTileDetail
} from '@tangram.gl/tangram-layers/experimental/projected-basemaps';
import {countProjectedTileCoordinates} from '@tangram.gl/tangram-renderer/core';
import {createProjectedExampleScene, getProjectedExampleTileZoom} from './scene.js';
import {getProjectedExampleBounds, getProjectedExampleDetailChoices} from './detail.js';
import {createProjectedExampleProjectionEngine} from './projection-engine.js';
import {getConfiguredAttributions, updateAttribution} from '../classic/app/attribution.js';
import {createCollapsibleInfoCard} from '../deck/info-card.js';
import {createProjectedDiagnosticsPoller, createProjectedSceneLoadHandler} from './diagnostics.js';
import {queryProjectedFeature} from './feature-selection.ts';

/** Mount one projected example; the host owns routing and worker asset URLs. */
export function mountProjectedExample(
  host,
  {parameters: initialParameters, workerUrl, onParametersChange} = {}
) {
  if (!workerUrl) throw new Error('A same-origin projection worker URL is required');
  const root = document.createElement('div');
  root.className = 'mounted-example projected-example';
  root.innerHTML = projectedMarkup;
  host.append(root);
  const listeners = new AbortController();
  const parameters = new URLSearchParams(initialParameters);
  // The caller owns one stable factory; the renderer caches independent compiled CRS transforms.
  const projectionEngine = createProjectedExampleProjectionEngine();
  const projectionEngineExecution = {maxBatchPositions: 4096};
  const navigation = new ProjectedBasemapNavigation(projectionEngine, projectionEngineExecution);
  let device = parameters.get('device') || (navigator.gpu ? 'webgpu' : 'webgl');
  const projectionSelector = root.querySelector('[data-example="projection"]');
  const basemapSelector = root.querySelector('[data-example="basemap"]');
  const coverageSelector = root.querySelector('[data-example="coverage"]');
  const detailSelector = root.querySelector('[data-example="detail"]');
  const detailMode = root.querySelector('[data-example="detail-mode"]');
  const refinementSelector = root.querySelector('[data-example="refinement"]');
  const coordinateProbe = root.querySelector('[data-example="coordinates"]');
  const featureProbe = root.querySelector('[data-example="selected-feature"]');
  let featureGeneration = 0;
  const diagnostics = root.querySelector('[data-example="diagnostics"]');
  const status = root.querySelector('[data-example="status"]');
  const destroyInfoCard = createCollapsibleInfoCard(
    root.querySelector('[data-example="controls"]')
  );
  projectionSelector.value = parameters.get('projection') || 'equal-earth';
  basemapSelector.value = parameters.get('basemap') === 'vector' ? 'vector' : 'raster';
  coverageSelector.value = parameters.get('coverage') === 'regional' ? 'regional' : 'world';
  detailMode.value = parameters.get('detailMode') === 'camera' ? 'camera' : 'manual';
  refinementSelector.value = parameters.get('refinement') === 'adaptive' ? 'adaptive' : 'angular';
  let selectedDetail = parameters.has('detail') ? Number(parameters.get('detail')) : undefined;
  let deck;
  let preparedScene;
  let preparedBasemap;
  let updateGeneration = 0;
  let projectionGeneration = 0;
  let projectionPending = false;
  let navigationGeneration = 0;
  let probeGeneration = 0;
  let probeController;
  let detailTimer;
  let disposed = false;
  let viewState = {target: [0, 0, 0], zoom: projectionSelector.value === 'albers' ? 0 : -1.5};
  let activeProjection = projectionSelector.value;
  let loadingBounds;
  let coverageEmpty = false;
  let refinementError;
  let loadedScene;
  const diagnosticsPoller = createProjectedDiagnosticsPoller(
    () => loadedScene,
    (text) => {
      diagnostics.textContent = text;
    }
  );

  /** Coalesce camera updates and discard obsolete projection, coverage or camera calculations. */
  function scheduleDetail() {
    const generation = ++navigationGeneration;
    clearTimeout(detailTimer);
    if (
      disposed ||
      projectionPending ||
      (detailMode.value !== 'camera' && refinementSelector.value !== 'adaptive')
    )
      return;
    detailTimer = setTimeout(async () => {
      const viewport = deck?.getViewports()[0];
      if (!viewport) return;
      try {
        const error =
          refinementSelector.value === 'adaptive' ? 2 / 2 ** Math.ceil(viewState.zoom) : undefined;
        if (error !== refinementError) {
          await initialize(false);
          return;
        }
        if (detailMode.value !== 'camera') return;
        const coverage = await navigation.getCameraCoverage(
          viewport,
          activeProjection,
          getProjectedExampleBounds(coverageSelector.value === 'regional')
        );
        if (disposed || generation !== navigationGeneration) return;
        if (!coverage.bounds) {
          if (!coverageEmpty) {
            coverageEmpty = true;
            await initialize(false);
          }
          setStatus('Camera is outside the loading region. The scene and tile cache remain warm.');
          return;
        }
        const result = await selectProjectedTileDetail(navigation, viewport, activeProjection, {
          visibleBounds: coverage.bounds,
          minZoom: basemapSelector.value === 'raster' ? 0 : 4,
          maxZoom: 6,
          maxTiles: 256,
          targetTilePixels: 256,
          currentTileZoom: selectedDetail
        });
        if (disposed || generation !== navigationGeneration) return;
        if (
          coverageEmpty ||
          selectedDetail !== result.tileZoom ||
          JSON.stringify(loadingBounds) !== JSON.stringify(coverage.bounds)
        ) {
          coverageEmpty = false;
          loadingBounds = coverage.bounds;
          selectedDetail = result.tileZoom;
          await initialize(false);
          return;
        }
        setStatus(
          `Camera detail ${result.tileZoom}: ${result.candidateCount} candidates, sampled span ${Math.round(result.estimatedTilePixels)} CSS px.${coverage.domainFallback ? ' Albers retains the full loading region.' : ''}${result.budgetLimited ? ' Candidate budget reached.' : ''}${result.detailLimited ? ' Maximum detail reached.' : ''}`
        );
      } catch (error) {
        if (!disposed && generation === navigationGeneration) setStatus(error.message, true);
      }
    }, 120);
  }

  /** Keep the geographic focus when replacing a projection, without rebuilding the source scene. */
  async function changeProjection() {
    featureGeneration++;
    const generation = ++projectionGeneration;
    projectionPending = true;
    navigationGeneration++;
    probeGeneration++;
    probeController?.abort();
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
      if (
        generation === projectionGeneration &&
        (transition.clamped || transition.domainFallback)
      ) {
        setStatus(
          transition.clamped
            ? 'Geographic focus clamped to the destination projection domain.'
            : 'Outside-domain focus reset to the destination region center.'
        );
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
      const fitted = await navigation.fitBounds(
        getProjectedExampleBounds(coverageSelector.value === 'regional'),
        viewport,
        activeProjection
      );
      if (disposed || generation !== navigationGeneration) return;
      viewState = fitted;
      probeGeneration++;
      probeController?.abort();
      deck.setProps({viewState});
      scheduleDetail();
    } catch (error) {
      if (!disposed && generation === navigationGeneration) setStatus(error.message, true);
    }
  }

  /** Invert CSS cursor coordinates on the ground plane; this does not select rendered features. */
  async function probeCoordinates(event) {
    const generation = ++probeGeneration;
    probeController?.abort();
    probeController = new AbortController();
    const viewport = deck?.getViewports()[0];
    if (!viewport || disposed) return;
    const rectangle = root.querySelector('[data-example="map"]').getBoundingClientRect();
    try {
      const position = await navigation.unprojectScreenPosition(
        viewport,
        [event.clientX - rectangle.left, event.clientY - rectangle.top],
        activeProjection,
        {signal: probeController.signal}
      );
      if (disposed || generation !== probeGeneration) return;
      coordinateProbe.textContent = position
        ? `${position[0].toFixed(4)}°, ${position[1].toFixed(4)}°`
        : 'Outside projection domain';
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
    featureGeneration++;
    navigationGeneration++;
    probeGeneration++;
    probeController?.abort();
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
    const choices = getProjectedExampleDetailChoices(raster, regional, (_bounds, zoom) =>
      countProjectedTileCoordinates(loadingBounds, zoom)
    );
    if (!choices.some((choice) => choice.zoom === selectedDetail && !choice.disabled)) {
      selectedDetail = getProjectedExampleTileZoom(raster);
    }
    detailSelector.replaceChildren(
      ...choices.map((choice) => {
        const option = new Option(
          `Zoom ${choice.zoom} — ${choice.tiles} tiles${choice.disabled ? ' (over budget)' : ''}`,
          String(choice.zoom)
        );
        option.disabled = choice.disabled;
        return option;
      })
    );
    detailSelector.value = String(selectedDetail);
    detailSelector.disabled = detailMode.value === 'camera';
    // Detail/coverage changes do not emit onProjectionChange; describe settings, not pending work.
    setStatus(
      `Data zoom ${selectedDetail}; style zoom stays at 6. Drag to pan and scroll to zoom.`
    );
    if (preparedBasemap !== basemapSelector.value) {
      loadedScene = undefined;
      diagnostics.textContent = 'Waiting for projected-worker diagnostics…';
      preparedBasemap = basemapSelector.value;
      preparedScene = createProjectedBasemapScene(
        createProjectedExampleScene(raster),
        {type, cacheProjectedMeshes: true},
        workerUrl
      );
    }
    updateAttribution(
      root.querySelector('[data-example="attribution"]'),
      getConfiguredAttributions(preparedScene)
    );
    parameters.set('projection', type);
    parameters.set('basemap', basemapSelector.value);
    parameters.set('coverage', coverageSelector.value);
    parameters.set('detail', String(selectedDetail));
    parameters.set('detailMode', detailMode.value);
    refinementError =
      refinementSelector.value === 'adaptive' ? 2 / 2 ** Math.ceil(viewState.zoom) : undefined;
    parameters.set('refinement', refinementSelector.value);
    onParametersChange?.(new URLSearchParams(parameters));
    const layers = [
      new ProjectedBasemapLayer({
        id: 'projected-basemap',
        scene: preparedScene,
        projectionEngine,
        projectionEngineExecution,
        // OpenFreeMap transportation starts at zoom 4; overview imagery only needs zoom 2.
        projectedProjection: {
          type,
          cacheProjectedMeshes: true,
          ...(refinementError === undefined ? {} : {maxProjectedError: refinementError})
        },
        projectedTileZoom: selectedDetail,
        projectedStyleZoom: 6,
        projectedVisibleBounds: loadingBounds,
        projectedMaxTiles: 256,
        visible: !coverageEmpty,
        tileResources: {
          maxConcurrentBuilds: 8,
          maxCachedTiles: 256,
          maxCachedMeshBytes: 32 * 1024 * 1024
        },
        onSceneLoad: createProjectedSceneLoadHandler(
          preparedScene,
          () => (disposed ? undefined : preparedScene),
          (scene) => {
            loadedScene = scene;
            diagnosticsPoller.update();
          }
        ),
        onProjectionChange: () => {
          if (
            !disposed &&
            !projectionPending &&
            generation === updateGeneration &&
            detailMode.value === 'manual'
          )
            setStatus('Caller-supplied math.gl engine enabled. Drag to pan and scroll to zoom.');
        },
        onSceneError: (error) => {
          if (!disposed && generation === updateGeneration) setStatus(error.message, true);
        }
      })
    ];
    if (deck) {
      // Stable scene identity retains the renderer, workers, decoded sources and raster textures.
      deck.setProps({layers});
      scheduleDetail();
      return;
    }
    deck = new Deck({
      parent: root.querySelector('[data-example="map"]'),
      deviceProps:
        device === 'webgpu' ? {type: 'webgpu', adapters: [webgpuAdapter]} : {type: 'webgl'},
      views: new OrthographicView({id: 'projected', flipY: false, controller: true}),
      viewState,
      onViewStateChange: (event) => {
        featureGeneration++;
        viewState = event.viewState;
        probeGeneration++;
        probeController?.abort();
        deck.setProps({viewState});
        scheduleDetail();
      },
      onLoad: scheduleDetail,
      onClick: (information) => {
        const generation = ++featureGeneration;
        const layer = deck.props.layers.find((layer) => layer.id === 'projected-basemap');
        void queryProjectedFeature(
          async () =>
            layer?.getFeatureAt(
              {x: information.x, y: information.y},
              {radius: 6, coordinateSpace: 'canvas'}
            ),
          () => !disposed && generation === featureGeneration,
          (text) => {
            featureProbe.textContent = text;
          }
        );
      },
      onResize: scheduleDetail,
      layers,
      _animate: true,
      onError: (error) => {
        setStatus(error.message, true);
        return true;
      }
    });
  }

  /** Retain configuration in the URL when changing the rendering device. */
  function navigateDevice(nextDevice) {
    if (nextDevice === device || disposed) return;
    device = nextDevice;
    parameters.set('device', device);
    loadedScene = undefined;
    deck?.finalize();
    deck = undefined;
    updateDeviceTabs();
    initialize(false).catch((error) => setStatus(error.message, true));
  }
  function updateDeviceTabs() {
    root.querySelectorAll('[data-device]').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.device === device);
      button.setAttribute('aria-selected', String(button.dataset.device === device));
    });
  }
  updateDeviceTabs();
  root
    .querySelectorAll('[data-device]')
    .forEach((button) =>
      button.addEventListener('click', () => navigateDevice(button.dataset.device), {
        signal: listeners.signal
      })
    );
  projectionSelector.addEventListener('change', changeProjection, {signal: listeners.signal});
  basemapSelector.addEventListener(
    'change',
    () => initialize().catch((error) => setStatus(error.message, true)),
    {signal: listeners.signal}
  );
  coverageSelector.addEventListener(
    'change',
    () => initialize().catch((error) => setStatus(error.message, true)),
    {signal: listeners.signal}
  );
  detailSelector.addEventListener(
    'change',
    () => {
      selectedDetail = Number(detailSelector.value);
      initialize().catch((error) => setStatus(error.message, true));
    },
    {signal: listeners.signal}
  );
  detailMode.addEventListener(
    'change',
    () => initialize().catch((error) => setStatus(error.message, true)),
    {signal: listeners.signal}
  );
  refinementSelector.addEventListener(
    'change',
    () => initialize(false).catch((error) => setStatus(error.message, true)),
    {signal: listeners.signal}
  );
  root
    .querySelector('[data-example="fit-region"]')
    .addEventListener('click', fitLoadingRegion, {signal: listeners.signal});
  root
    .querySelector('[data-example="map"]')
    .addEventListener('pointermove', probeCoordinates, {signal: listeners.signal});
  root.querySelector('[data-example="map"]').addEventListener(
    'pointerleave',
    () => {
      probeGeneration++;
      probeController?.abort();
      coordinateProbe.textContent = 'Move over the map to inspect coordinates';
    },
    {signal: listeners.signal}
  );
  root.querySelector('[data-example="fullscreen"]').addEventListener(
    'click',
    () => {
      const transition =
        document.fullscreenElement === root ? document.exitFullscreen() : root.requestFullscreen();
      transition.catch((error) => {
        if (!disposed) setStatus(error.message, true);
      });
    },
    {signal: listeners.signal}
  );
  root.querySelectorAll('[data-example-tab]').forEach((button) =>
    button.addEventListener(
      'click',
      () => {
        root.querySelectorAll('[data-example-tab]').forEach((tab) => {
          const active = tab === button;
          tab.classList.toggle('is-active', active);
          tab.setAttribute('aria-selected', String(active));
        });
        root.querySelectorAll('[data-example-tab-panel]').forEach((panel) => {
          panel.hidden = panel.dataset.exampleTabPanel !== button.dataset.exampleTab;
        });
      },
      {signal: listeners.signal}
    )
  );
  function destroy() {
    if (disposed) return;
    disposed = true;
    destroyInfoCard();
    projectionGeneration++;
    navigationGeneration++;
    probeGeneration++;
    probeController?.abort();
    clearTimeout(detailTimer);
    diagnosticsPoller.destroy();
    navigation.dispose();
    listeners.abort();
    observer.disconnect();
    deck?.finalize();
    root.remove();
  }
  const observer = new ResizeObserver(() => {
    if (!disposed) {
      const container = root.querySelector('[data-example="map"]');
      deck?.setProps({width: container.clientWidth, height: container.clientHeight});
    }
  });
  observer.observe(root.querySelector('[data-example="map"]'));
  return {
    ready: initialize().catch((error) => {
      if (!disposed) setStatus(error.message, true);
    }),
    destroy
  };
}
