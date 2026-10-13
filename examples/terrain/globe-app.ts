// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Deck, _GlobeView as GlobeView, type GlobeViewState} from '@deck.gl/core';
import {webgpuAdapter} from '@luma.gl/webgpu';
import {GlobeTerrainLayer, GlobeTerrainDisplayPreparation, getGlobeScreenRatio, type GlobeTerrainDisplaySnapshot} from '@vis.gl/tangram-layers/experimental/terrain';
import {GlobeTerrainPreparation, getGlobeTerrainExaggeration, type TerrainHeightGrid} from '@vis.gl/tangram-renderer/map-logic';
import {createCollapsibleInfoCard} from '../deck/info-card.js';
import {TerrainTileset} from './terrain-tileset';
import {getTerrainTileBounds, getTerrainTileKey} from './tile-selection';
import {selectGlobeTerrainDetail, type GlobeTerrainDetail} from './globe-detail';
import {TerrainDecoderPool} from './decoder-pool';
import {formatTerrainDecoderStatus} from './decoder-status';
import type {TerrainGridData} from './terrain-payload';
import {createMapterhornTerrainSource, validateTerrainImageSource, type TerrainImageSource} from './terrain-source';
import type {TerrainExample} from './app';
import {createDrapedBasemap} from './draped-basemap';
import {sampleTerrainElevation, type SceneDefinition, type TerrainDrapingOptions} from '@vis.gl/tangram-renderer/core';
import {getConfiguredAttributions, updateAttribution} from '../classic/app/attribution.js';

/** Mount bounded global terrain with ordinary GlobeView navigation and physical-meter picking. */
export function mountGlobeTerrainExample(host: HTMLElement, options: {
    /** Same-origin decoder shared with the Mercator example. */
    workerUrl: string;
    /** Initial device/exaggeration settings. */
    parameters?: URLSearchParams;
    /** Persist settings without navigating away. */
    onParametersChange?: (parameters: URLSearchParams) => void;
    /** Immutable elevation source; the global preview requires z0 through z2. */
    source?: TerrainImageSource;
    /** Cooperative preparation slice target; default 4 ms, not a hard frame-time guarantee. */
    preparationBudgetMs?: number;
    /** Cooperative display rescaling/query-copy slice target; default 4 ms, including during navigation. */
    displayBudgetMs?: number;
    /** Current plus staged prepared-template retention; default 96 MiB, excluding scratch/display/query/GPU buffers. */
    maxPreparedBytes?: number;
    /** Current plus replacement display/query geometry typed-array cap; default 128 MiB. */
    maxDisplayBytes?: number;
    /** Total current lazy picking hierarchy typed-array cap; default 64 MiB. */
    maxQueryIndexBytes?: number;
    /** Uniform curved cells per tile axis, integer [2, 256]; defaults to 64. */
    meshResolution?: number;
    /** Offline host scene, or false to use only the original elevation preview. */
    basemap?: SceneDefinition | false;
}): TerrainExample {
    const workerUrl = new URL(options.workerUrl, location.href);
    if (workerUrl.origin !== location.origin) throw new Error('Terrain worker must be same-origin');
    const source = options.source ?? createMapterhornTerrainSource();
    validateTerrainImageSource(source);
    if (source.minZoom > 0 || source.maxZoom < 2) throw new Error('Global terrain preview requires source zooms 0–2');
    const preparationBudget = options.preparationBudgetMs ?? 4;
    if (!Number.isFinite(preparationBudget) || preparationBudget <= 0) throw new Error('Preparation slice target must be positive');
    const displayBudget = options.displayBudgetMs ?? 4;
    if (!Number.isFinite(displayBudget) || displayBudget <= 0) throw new Error('Display slice target must be positive');
    const meshResolution = options.meshResolution ?? 64;
    if (!Number.isSafeInteger(meshResolution) || meshResolution < 2 || meshResolution > 256) throw new Error('Globe terrain resolution must be an integer in [2, 256]');
    let preparation = new GlobeTerrainPreparation(options.maxPreparedBytes);
    const maxDisplayBytes = options.maxDisplayBytes ?? 128 * 1024 * 1024, maxQueryIndexBytes = options.maxQueryIndexBytes ?? 64 * 1024 * 1024;
    for (const limit of [maxDisplayBytes, maxQueryIndexBytes]) if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Globe terrain byte limits must be non-negative integers');
    let displayPreparation = new GlobeTerrainDisplayPreparation({maxDisplayBytes, maxQueryIndexBytes});
    const parameters = new URLSearchParams(options.parameters);
    const rawExaggeration = parameters.get('exaggeration');
    const requested = rawExaggeration?.trim() ? Number(rawExaggeration) : 100;
    const maximum = Number.isFinite(requested) && requested >= 0 && requested <= 200 ? Math.round(requested) : 100;
    const requestedDetail = Number(parameters.get('detail'));
    const targetPixels = [128, 256, 512].includes(requestedDetail) ? requestedDetail : 256;
    let currentMaximum = maximum;
    const root = document.createElement('div');
    root.className = 'mounted-example terrain-example';
    root.innerHTML = `<div data-example="map"></div><aside data-example="controls">
      <h1>Globe terrain</h1><p data-example="status" role="status">Loading global elevation…</p><p data-example="decoder-status" class="hint"></p><p data-example="preparation-status" class="hint"></p><p data-example="display-status" class="hint"></p>
      <label class="control"><span>Maximum globe exaggeration</span><input data-example="exaggeration" type="range" min="0" max="200" step="1"><output data-example="exaggeration-value"></output></label>
      <label class="control"><span>Terrain detail</span><select data-example="detail"><option value="128">High</option><option value="256">Balanced</option><option value="512">Fast</option></select></label>
      <label class="control checkbox-control"><input data-example="wireframe" type="checkbox"> Wireframe</label>
      <label class="control checkbox-control"><input data-example="draping" type="checkbox"> Draped OpenFreeMap basemap</label>
      <p data-example="draping-status" class="hint"></p>
      <button data-example="retry" type="button">Retry failed tiles</button>
      <output data-example="terrain-hit" aria-live="polite">Click terrain for physical elevation</output>
      <output data-example="terrain-visibility" aria-live="polite">Click terrain to pin a sightline target</output>
      <button data-example="clear-target" type="button">Clear pinned target</button>
      <p class="hint">Drag to rotate; scroll/pinch to zoom. Exaggerated relief fades to flat over one apparent-diameter doubling; explicit 1× stays physical. Detail preparation pauses during navigation; display rescaling yields in separate CPU slices. The requested multiplier can briefly lead admitted relief. Complete drawing and picking generations swap together.</p>
      <p class="hint">Adaptive globe terrain: global fallback stays warm while visible regions refine, bounded to 96 leaf tiles and 256 MiB of retained source/decoded arrays. Draped ground drawing and picking use the same worker triangles and transition clock. The separate wireframe preview remains available. Source detail is not a certified pixel-error guarantee. Polar regions outside ±85.05° and no-data areas have no terrain. Elevations retain the source datum; displayed mountains are exaggerated, returned meters are not.</p>
      <a href="https://github.com/visgl/tangram.gl/tree/master/examples/terrain" target="_blank" rel="noopener noreferrer">Source</a></aside>
      <div class="canvas-toolbar"><div class="canvas-device-tabs" role="tablist" aria-label="Rendering device">
      <button data-device-type="webgpu" type="button" role="tab">WebGPU</button><button data-device-type="webgl" type="button" role="tab">WebGL</button></div>
      <button data-example="fullscreen" class="canvas-fullscreen" type="button" aria-label="Fullscreen">⛶</button></div><p data-example="attribution"></p>`;
    host.append(root);
    /** Find a control only inside this mount. */
    const element = <T extends HTMLElement>(name: string): T => {
        const value = root.querySelector<T>(`[data-example="${name}"]`);
        if (!value) throw new Error(`Missing globe terrain control: ${name}`);
        return value;
    };
    const container = element<HTMLDivElement>('map'), status = element('status'), output = element('terrain-hit');
    const exaggeration = element<HTMLInputElement>('exaggeration'), wireframe = element<HTMLInputElement>('wireframe');
    const draping = element<HTMLInputElement>('draping'); draping.checked = options.basemap !== false; draping.disabled = options.basemap === false; wireframe.disabled = draping.checked;
    const basemapScene = options.basemap || createDrapedBasemap();
    let BasemapLayer: typeof import('@vis.gl/tangram-layers').TangramLayer | undefined;
    let basemap: InstanceType<typeof import('@vis.gl/tangram-layers').TangramLayer> | undefined;
    let terrainInput: TerrainDrapingOptions = {grids: [], querySurfaceStyles: ['ground']};
    let basemapError = '';
    const detailControl = element<HTMLSelectElement>('detail'); detailControl.value = String(targetPixels);
    exaggeration.value = String(maximum);
    const exaggerationValue = element<HTMLOutputElement>('exaggeration-value');
    exaggerationValue.value = `${maximum}×`;
    const attribution = element('attribution');
    attribution.textContent = 'Elevation: ';
    source.credits.forEach((credit, index) => {
        if (index) attribution.append(document.createTextNode(' · '));
        const link = document.createElement('a'); link.textContent = credit.label; link.href = credit.url; link.rel = 'noopener noreferrer'; attribution.append(link);
    });
    const basemapCredits = document.createElement('span'); basemapCredits.append(document.createTextNode(' · Basemap: '));
    const creditValue = document.createElement('span'); basemapCredits.append(creditValue); attribution.append(basemapCredits); basemapCredits.hidden = !draping.checked;
    updateAttribution(creditValue, getConfiguredAttributions(basemapScene));
    // deck.gl changes GlobeView to Mercator above zoom 12; this layer stays spherical.
    let camera: GlobeViewState = {longitude: 80, latitude: 25, zoom: 1, maxZoom: 12};
    let device = parameters.get('device') === 'webgl' ? 'webgl' : navigator.gpu ? 'webgpu' : 'webgl';
    let disposed = false, animationFrame = 0, layer: GlobeTerrainLayer | undefined;
    let detailTimer: ReturnType<typeof setTimeout> | undefined;
    let displayedMaximum: number | undefined, displayedWireframe: boolean | undefined;
    let deckReady = false, deckGeneration = 0;
    let renderingError: string | undefined;
    let tileset: TerrainTileset<TerrainGridData> | undefined;
    const decoder = new TerrainDecoderPool(workerUrl.href);
    let grids: TerrainHeightGrid[] = [];
    let displayedSnapshot: GlobeTerrainDisplaySnapshot | undefined;
    let pinnedCoordinate: [number, number] | undefined;
    let pinnedSignature = '', pinnedLayer: GlobeTerrainLayer | undefined;
    let pinnedSurfaces: GlobeTerrainLayer['state']['surfaces'] | undefined;
    const zoomByGrid = new WeakMap<TerrainHeightGrid, number>();
    let detail: GlobeTerrainDetail | undefined, selectionSignature = '', detailCameraSignature = '';
    const abort = new AbortController();
    /** Coalesce worker completions and camera updates without rebuilding source data. */
    function schedule(): void {
        if (!disposed && !animationFrame) animationFrame = requestAnimationFrame(() => {animationFrame = 0; updateLayers();});
    }
    /** Report actual retained display/query arrays after deck updates and lazy picking, without scheduling another frame. */
    function updateDisplayStatus(): void {
        if (disposed || !layer) return;
        const statistics = layer.getStatistics();
        const work = displayPreparation.getStatistics();
        const text = `Admitted: ${statistics.tileCount} tiles · ${statistics.exaggeration.toFixed(1)}× displayed · display/query geometry ${(statistics.displayBytes / 1000000).toFixed(1)} MB · picking index ${(statistics.queryIndexBytes / 1000000).toFixed(1)} MB · ${work.warmedIndexes} indexes warmed / ${work.deferredIndexes} deferred · display preparation ${work.pending} pending · ${(work.retainedBytes / 1000000).toFixed(1)} / ${(work.byteLimit / 1000000).toFixed(1)} MB retained · ${(work.requiredPeakBytes / 1000000).toFixed(1)} MB preflight · ${work.slices} slices / ${work.workMs.toFixed(1)} ms elapsed / longest ${work.maxSliceMs.toFixed(1)} ms · last update ${statistics.updateMs.toFixed(1)} ms · last query ${statistics.queryMs.toFixed(1)} ms${statistics.error || work.error ? ` · ${statistics.error ?? work.error}` : ''} · excludes GPU/transient allocations`;
        const target = element('display-status'); if (target.textContent !== text) target.textContent = text;
    }
    /** Re-sample the pinned geographic target only when camera or admitted geometry changes, never every idle frame. */
    function updatePinnedStatus(): void {
        if (disposed || !pinnedCoordinate || !layer && !basemap) return;
        const viewport = deck.getViewports()[0];
        if (!viewport || viewport.projectionMode !== 2) return;
        const surface = draping.checked ? basemap?.getDrapedTerrainSurface() : null;
        const signature = `${[...pinnedCoordinate, ...viewport.viewProjectionMatrix].join(',')}/${surface?.displayKey ?? 'preview'}`;
        if (pinnedSignature === signature && pinnedLayer === layer && pinnedSurfaces === layer?.state?.surfaces) return;
        pinnedSignature = signature; pinnedLayer = layer; pinnedSurfaces = layer?.state?.surfaces;
        const target = draping.checked ? surface && sampleTerrainElevation(surface, pinnedCoordinate, {minimumAltitude: -12000, maximumAltitude: 10000000}) : layer?.sampleElevation(pinnedCoordinate);
        let text = 'Pinned target is outside loaded terrain; visibility unknown';
        if (target) {
            const camera = viewport.cameraPosition;
            const blocker = surface ? surface.intersectSegment([camera[0], camera[1], camera[2]], target.position, {startInset: 1e-7, endInset: 1e-4}) : layer?.intersectTerrainSegment([camera[0], camera[1], camera[2]], target.position, {startInset: 1e-7, endInset: 1e-4});
            text = `Pinned ${pinnedCoordinate[0].toFixed(4)}, ${pinnedCoordinate[1].toFixed(4)} · ${target.coordinate[2].toFixed(1)} physical m · ${blocker ? 'blocked by loaded terrain' : 'no blocker in loaded terrain (not certified visibility)'}`;
        }
        const output = element('terrain-visibility'); if (output.textContent !== text) output.textContent = text;
    }
    /** Create one owned device, with a controlled GlobeView. */
    function createDeck(): Deck<GlobeView> {
        const generation = ++deckGeneration;
        deckReady = false;
        return new Deck({parent: container, width: '100%', height: '100%', views: new GlobeView({id: 'globe-terrain', controller: true}), viewState: camera,
            deviceProps: device === 'webgpu' ? {type: 'webgpu', adapters: [webgpuAdapter]} : {type: 'webgl'},
            onViewStateChange: ({viewState}) => {
                if (disposed || generation !== deckGeneration) return;
                camera = {...viewState, zoom: Math.min(12, viewState.zoom), maxZoom: 12}; deck.setProps({viewState: camera});
                // Navigation stays immediate; select new source detail once motion settles.
                clearTimeout(detailTimer);
                detailTimer = setTimeout(() => {detailTimer = undefined; schedule();}, 120);
                schedule();
            },
            onError: error => {if (!disposed && generation === deckGeneration) {renderingError = error.message; status.textContent = `Rendering error: ${error.message}`;}},
            onClick: information => {
                if (disposed || generation !== deckGeneration) return;
                const viewport = information.viewport ?? deck.getViewports()[0];
                const hit = draping.checked ? basemap?.getTerrainAt({x: information.x, y: information.y}) : viewport && layer?.pickTerrain(viewport, [information.x, information.y]);
                output.textContent = hit ? `${hit.coordinate[0].toFixed(4)}, ${hit.coordinate[1].toFixed(4)} — ${hit.coordinate[2].toFixed(1)} physical m` : 'Outside loaded terrain';
                pinnedCoordinate = hit ? [hit.coordinate[0], hit.coordinate[1]] : undefined; pinnedSignature = '';
                element('terrain-visibility').textContent = 'Click terrain to pin a sightline target';
                updatePinnedStatus(); updateDisplayStatus();
            }, onAfterRender: () => {if (generation === deckGeneration) {updatePinnedStatus(); updateDisplayStatus();
                const statistics = basemap?.getTerrainDrapingStatistics();
                const query = basemap?.getDrapedTerrainSurface()?.getStatistics();
                if (draping.checked && statistics) element('draping-status').textContent = `Basemap: ${statistics.meshes} meshes · ${(statistics.meshBytes / 1000000).toFixed(1)} MB draw / ${(statistics.queryBytes / 1000000).toFixed(1)} MB query / ${(statistics.stagedMeshBytes / 1000000).toFixed(1)} MB staged · slowest worker ${statistics.maximumPreparationMs.toFixed(1)} ms${query ? ` · frame queries ${(query.projectedBytes / 1000000).toFixed(1)} MB / ${query.projectionBuilds} projection builds / ${query.queryMs.toFixed(1)} ms traversal` : ''}${basemapError ? ` · ${basemapError}` : ''}`;
            }}, onLoad: () => {if (!disposed && generation === deckGeneration) {deckReady = true; schedule();}}});
    }
    let deck = createDeck();
    /** Refine visible data with hysteresis, retaining complete stitched parent fallback and warm sources. */
    function updateLayers(): void {
        if (!tileset || disposed || !deckReady) return;
        const viewport = deck.getViewports()[0];
        if (!viewport || viewport.projectionMode !== 2 || viewport.width <= 0 || viewport.height <= 0) return;
        const cameraSignature = [camera.longitude, camera.latitude, camera.zoom, viewport.x, viewport.y, viewport.width, viewport.height, ...viewport.viewProjectionMatrix].join(',');
        if (!detail || detailTimer === undefined && detailCameraSignature !== cameraSignature) {
            detail = selectGlobeTerrainDetail({...camera, x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height, cameraPosition: viewport.cameraPosition, project: position => viewport.project(position)}, {targetPixels: Number(detailControl.value), maxZoom: source.maxZoom, previous: detail?.tiles});
            detailCameraSignature = cameraSignature;
        }
        const signature = detail.tiles.map(getTerrainTileKey).join(',');
        if (signature !== selectionSignature) {selectionSignature = signature; tileset.update(detail.tiles, 10000);}
        const drawable = tileset.getDrawableTiles();
        const nextGrids = drawable.flatMap(tile => tile.data ? [tile.data.grid] : []);
        for (const tile of drawable) if (tile.data) zoomByGrid.set(tile.data.grid, tile.coordinate.zoom);
        if (draping.checked && BasemapLayer) {
            grids = nextGrids;
            if (nextGrids.length !== terrainInput.grids.length || nextGrids.some((grid, index) => grid !== terrainInput.grids[index])) {
                terrainInput = {grids, querySurfaceStyles: ['ground'], transitionDuration: 200, maxSegmentLength: 100000, occludeAnnotations: true,
                    maxGridBytes: 256 * 1024 * 1024, maxStagedMeshBytes: 128 * 1024 * 1024};
            }
            const effective = getGlobeTerrainExaggeration(getGlobeScreenRatio(viewport), Number(exaggeration.value));
            basemap = new BasemapLayer({id: 'globe-draped-basemap', scene: basemapScene, terrain: terrainInput,
                terrainExaggeration: effective, globeMaxElevation: 12000 * Math.max(1, effective), tileBuffer: 0, globePreloadZoom: 2,
                maxConcurrentTileLoadsPerWorker: 2, tileResources: {maxConcurrentTileBuilds: 2},
                onAttributionChange: (credits: string[]) => {if (!disposed) updateAttribution(creditValue, credits);},
                onSceneError: (error: unknown) => {if (!disposed) {basemapError = String(error); element('draping-status').textContent = basemapError;}}});
            deck.setProps({layers: [basemap]});
            const statistics = tileset.getStatistics();
            element('decoder-status').textContent = formatTerrainDecoderStatus(decoder.getStatistics(), statistics);
            element('preparation-status').textContent = 'Worker-owned basemap topology; separate elevation-preview preparation is paused';
            element('display-status').textContent = 'Exaggeration is GPU-only; exact ground queries are prepared lazily and reused while displacement is unchanged';
            const highest = Math.max(0, ...grids.map(grid => zoomByGrid.get(grid) ?? 0));
            status.textContent = `${device === 'webgpu' ? 'WebGPU' : 'WebGL 2'} · ${grids.length} loaded grids · z${highest} detail · ${effective.toFixed(1)}× relief · ${(statistics.bytes / 1000000).toFixed(1)} / ${(statistics.byteLimit / 1000000).toFixed(0)} MB cached${statistics.active || statistics.queued ? ` · ${statistics.active} active / ${statistics.queued} queued` : ''}${statistics.failed ? ` · ${statistics.failed} failed: ${statistics.failure} — retry available` : ''}${renderingError ? ` · Rendering error: ${renderingError}` : ''}`;
            return;
        }
        // Keep only one template→display handoff in flight; warm source acquisition can continue.
        if (!displayPreparation.isPending()) {
            preparation.request(nextGrids, meshResolution);
            if (detailTimer === undefined) preparation.advance(preparationBudget);
        }
        const terrain = preparation.getSnapshot();
        const previousDisplayError = displayPreparation.getStatistics().error;
        const effective = getGlobeTerrainExaggeration(getGlobeScreenRatio(viewport), Number(exaggeration.value));
        if (terrain) displayPreparation.request(terrain, effective);
        const displayCommitted = displayPreparation.advance(displayBudget);
        const snapshot = displayPreparation.getSnapshot();
        const dataChanged = displayedSnapshot !== snapshot;
        if (dataChanged) {displayedSnapshot = snapshot; grids = [...(snapshot?.terrain.grids ?? [])];}
        const currentExaggeration = Number(exaggeration.value);
        if (!layer || dataChanged || displayedMaximum !== currentExaggeration || displayedWireframe !== wireframe.checked) {
            layer = new GlobeTerrainLayer({id: 'globe-terrain', data: grids, preparedTerrain: snapshot?.terrain, preparedDisplay: snapshot, meshResolution, globeTerrainExaggeration: currentExaggeration, wireframe: wireframe.checked, maxDisplayBytes, maxQueryIndexBytes});
            displayedMaximum = currentExaggeration; displayedWireframe = wireframe.checked;
        }
        basemap = undefined;
        deck.setProps({layers: [layer]});
        updateDisplayStatus();
        const statistics = tileset.getStatistics();
        element('decoder-status').textContent = formatTerrainDecoderStatus(decoder.getStatistics(), statistics);
        const prepared = preparation.getStatistics();
        element('preparation-status').textContent = `Preparation: ${prepared.pending} pending · ${(prepared.retainedBytes / 1000000).toFixed(1)} / ${(prepared.byteLimit / 1000000).toFixed(1)} MB templates · ${prepared.prepared} new / ${prepared.reused} reused · ${prepared.slices} slices · ${prepared.workMs.toFixed(1)} ms CPU elapsed · longest ${prepared.maxSliceMs.toFixed(1)} ms${prepared.error ? ` · ${prepared.error} — retry available` : ''}`;
        const highest = Math.max(0, ...grids.map(grid => zoomByGrid.get(grid) ?? 0));
        status.textContent = `${device === 'webgpu' ? 'WebGPU' : 'WebGL 2'} · ${grids.length} tiles prepared · z${highest} detail · ${effective.toFixed(1)}× requested · ${(statistics.bytes / 1000000).toFixed(1)} / ${(statistics.byteLimit / 1000000).toFixed(0)} MB cached${statistics.active || statistics.queued ? ` · ${statistics.active} active / ${statistics.queued} queued` : ''}${detail.limited ? ' · detail budget/source limit' : ''}${statistics.failed ? ` · ${statistics.failed} failed: ${statistics.failure} — retry available` : ''}${renderingError ? ` · Rendering error: ${renderingError}` : ''}`;
        const displayErrorChanged = previousDisplayError !== displayPreparation.getStatistics().error;
        if (displayCommitted || displayErrorChanged || displayPreparation.isPending() || preparation.isPending() && detailTimer === undefined) schedule();
    }
    tileset = new TerrainTileset<TerrainGridData>({minZoom: 1, maxZoom: source.maxZoom, hierarchical: true, maxResidentBytes: 256 * 1024 * 1024, maxCachedTiles: 48, maxCachedBytes: 64 * 1024 * 1024, fetch: (tile, signal) => source.fetchTile(tile, signal),
        decode: (bytes, tile, _error, signal) => decoder.decodeGrid(bytes, getTerrainTileBounds(tile.zoom, tile.column, tile.row), signal, source.noData), onChange: schedule});
    const observer = new ResizeObserver(() => {if (!disposed) {deck.setProps({width: container.clientWidth, height: container.clientHeight}); schedule();}});
    observer.observe(container);
    exaggeration.addEventListener('input', () => {
        const value = Number(exaggeration.value);
        if (!Number.isFinite(value) || value < 0 || value > 200) {exaggeration.value = String(currentMaximum); return;}
        currentMaximum = value;
        exaggerationValue.value = `${value}×`;
        parameters.set('exaggeration', String(value)); options.onParametersChange?.(new URLSearchParams(parameters)); schedule();
    }, {signal: abort.signal});
    wireframe.addEventListener('change', schedule, {signal: abort.signal});
    draping.addEventListener('change', () => {
        wireframe.disabled = draping.checked; basemapCredits.hidden = !draping.checked; pinnedSignature = '';
        if (draping.checked) {
            // Release unused preview/query generations instead of keeping two complete terrain pipelines resident.
            preparation.destroy(); displayPreparation.destroy();
            preparation = new GlobeTerrainPreparation(options.maxPreparedBytes);
            displayPreparation = new GlobeTerrainDisplayPreparation({maxDisplayBytes, maxQueryIndexBytes});
            displayedSnapshot = undefined; layer = undefined; pinnedLayer = undefined; pinnedSurfaces = undefined;
        }
        schedule();
    }, {signal: abort.signal});
    detailControl.addEventListener('change', () => {
        parameters.set('detail', detailControl.value); options.onParametersChange?.(new URLSearchParams(parameters)); clearTimeout(detailTimer); detailTimer = undefined; detailCameraSignature = ''; schedule();
    }, {signal: abort.signal});
    element('retry').addEventListener('click', () => {tileset?.retry(); preparation.retry(); displayPreparation.retry(); schedule();}, {signal: abort.signal});
    element('clear-target').addEventListener('click', () => {pinnedCoordinate = undefined; pinnedLayer = undefined; pinnedSurfaces = undefined; pinnedSignature = ''; element('terrain-visibility').textContent = 'Click terrain to pin a sightline target';}, {signal: abort.signal});
    element('fullscreen').addEventListener('click', () => {if (document.fullscreenElement === root) void document.exitFullscreen(); else void root.requestFullscreen().catch(error => {status.textContent = `Fullscreen unavailable: ${error.message}`;});}, {signal: abort.signal});
    /** Preserve source/cache ownership when switching GPU devices. */
    function updateTabs(): void {
        for (const button of root.querySelectorAll<HTMLButtonElement>('[data-device-type]')) {button.classList.toggle('is-active', button.dataset.deviceType === device); button.setAttribute('aria-selected', String(button.dataset.deviceType === device));}
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-device-type]')) button.addEventListener('click', () => {
        if (button.dataset.deviceType === device) return;
        device = button.dataset.deviceType === 'webgpu' ? 'webgpu' : 'webgl'; renderingError = undefined; deck.finalize(); layer = undefined; deck = createDeck(); updateTabs(); schedule();
        parameters.set('device', device); options.onParametersChange?.(new URLSearchParams(parameters));
    }, {signal: abort.signal});
    updateTabs();
    const destroyCard = createCollapsibleInfoCard(element('controls'));
    const coordinates = Array.from({length: 16}, (_, index) => ({zoom: 2, column: index % 4, row: Math.floor(index / 4)}));
    selectionSignature = coordinates.map(getTerrainTileKey).join(',');
    tileset.update(coordinates, 10000);
    const basemapReady = options.basemap === false ? Promise.resolve() : import('@vis.gl/tangram-layers').then(module => {
        if (!disposed) {BasemapLayer = module.TangramLayer; schedule();}
    }).catch(error => {if (!disposed) {draping.checked = false; basemapCredits.hidden = true; wireframe.disabled = false; basemapError = String(error); element('draping-status').textContent = basemapError; schedule();}});
    return {ready: Promise.all([tileset.waitForIdle(), basemapReady]).then(() => {updateLayers();}), destroy() {
        if (disposed) return; disposed = true; clearTimeout(detailTimer); abort.abort(); observer.disconnect(); cancelAnimationFrame(animationFrame); tileset?.destroy(); decoder.destroy(); preparation.destroy(); displayPreparation.destroy(); destroyCard(); deck.finalize(); layer = undefined; basemap = undefined; terrainInput = {grids: []}; displayedSnapshot = undefined; pinnedLayer = undefined; pinnedSurfaces = undefined; pinnedCoordinate = undefined; grids = []; detail = undefined; root.remove();
    }};
}
