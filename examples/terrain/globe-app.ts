// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Deck, _GlobeView as GlobeView, type GlobeViewState} from '@deck.gl/core';
import {webgpuAdapter} from '@luma.gl/webgpu';
import {GlobeTerrainLayer, getGlobeScreenRatio} from '@vis.gl/tangram-layers/experimental/terrain';
import {getGlobeTerrainExaggeration, type TerrainHeightGrid} from '@vis.gl/tangram-renderer/map-logic';
import {createCollapsibleInfoCard} from '../deck/info-card.js';
import {TerrainTileset} from './terrain-tileset';
import {getTerrainTileBounds, getTerrainTileKey} from './tile-selection';
import {selectGlobeTerrainDetail, type GlobeTerrainDetail} from './globe-detail';
import {decodeTerrainInWorker} from './worker-client';
import {createMapterhornTerrainSource, validateTerrainImageSource, type TerrainImageSource} from './terrain-source';
import type {TerrainExample} from './app';

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
}): TerrainExample {
    const workerUrl = new URL(options.workerUrl, location.href);
    if (workerUrl.origin !== location.origin) throw new Error('Terrain worker must be same-origin');
    const source = options.source ?? createMapterhornTerrainSource();
    validateTerrainImageSource(source);
    if (source.minZoom > 0 || source.maxZoom < 2) throw new Error('Global terrain preview requires source zooms 0–2');
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
      <h1>Globe terrain</h1><p data-example="status" role="status">Loading global elevation…</p>
      <label class="control"><span>Maximum globe exaggeration</span><input data-example="exaggeration" type="range" min="0" max="200" step="1"><output data-example="exaggeration-value"></output></label>
      <label class="control"><span>Terrain detail</span><select data-example="detail"><option value="128">High</option><option value="256">Balanced</option><option value="512">Fast</option></select></label>
      <label class="control checkbox-control"><input data-example="wireframe" type="checkbox"> Wireframe</label>
      <button data-example="retry" type="button">Retry failed tiles</button>
      <output data-example="terrain-hit" aria-live="polite">Click terrain for physical elevation</output>
      <p class="hint">Drag to rotate; scroll/pinch to zoom. Exaggerated relief fades to flat over one apparent-diameter doubling; explicit 1× stays physical. Detail refines after navigation settles.</p>
      <p class="hint">Adaptive globe terrain: global fallback stays warm while visible regions refine, bounded to 96 leaf tiles and 256 MiB of retained source/decoded arrays. Coarse/fine edges are stitched. This is not basemap draping or a certified pixel-error guarantee. Polar regions outside ±85.05° and no-data areas have no terrain. Elevations retain the source datum; displayed mountains are exaggerated, returned meters are not.</p>
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
    // deck.gl changes GlobeView to Mercator above zoom 12; this layer stays spherical.
    let camera: GlobeViewState = {longitude: 80, latitude: 25, zoom: 1, maxZoom: 12};
    let device = parameters.get('device') === 'webgl' ? 'webgl' : navigator.gpu ? 'webgpu' : 'webgl';
    let disposed = false, animationFrame = 0, layer: GlobeTerrainLayer | undefined;
    let detailTimer: ReturnType<typeof setTimeout> | undefined;
    let displayedMaximum: number | undefined, displayedWireframe: boolean | undefined;
    let deckReady = false, deckGeneration = 0;
    let renderingError: string | undefined;
    let tileset: TerrainTileset | undefined;
    let grids: TerrainHeightGrid[] = [];
    let detail: GlobeTerrainDetail | undefined, selectionSignature = '', detailCameraSignature = '';
    const abort = new AbortController();
    /** Coalesce worker completions and camera updates without rebuilding source data. */
    function schedule(): void {
        if (!disposed && !animationFrame) animationFrame = requestAnimationFrame(() => {animationFrame = 0; updateLayers();});
    }
    /** Create one owned device, with a controlled GlobeView. */
    function createDeck(): Deck<GlobeView> {
        const generation = ++deckGeneration;
        deckReady = false;
        return new Deck({parent: container, width: '100%', height: '100%', views: new GlobeView({id: 'globe-terrain', controller: true}), viewState: camera,
            deviceProps: device === 'webgpu' ? {type: 'webgpu', adapters: [webgpuAdapter]} : {type: 'webgl'},
            onViewStateChange: ({viewState}) => {
                camera = {...viewState, zoom: Math.min(12, viewState.zoom), maxZoom: 12}; deck.setProps({viewState: camera});
                // Navigation stays immediate; select new source detail once motion settles.
                clearTimeout(detailTimer);
                detailTimer = setTimeout(() => {detailTimer = undefined; schedule();}, 120);
                schedule();
            },
            onError: error => {if (!disposed && generation === deckGeneration) {renderingError = error.message; status.textContent = `Rendering error: ${error.message}`;}},
            onClick: information => {
                const viewport = information.viewport ?? deck.getViewports()[0];
                const hit = viewport && layer?.pickTerrain(viewport, [information.x, information.y]);
                output.textContent = hit ? `${hit.coordinate[0].toFixed(4)}, ${hit.coordinate[1].toFixed(4)} — ${hit.coordinate[2].toFixed(1)} physical m` : 'Outside loaded terrain';
            }, onLoad: () => {if (!disposed && generation === deckGeneration) {deckReady = true; schedule();}}});
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
        const dataChanged = grids.length !== nextGrids.length || grids.some((grid, index) => grid !== nextGrids[index]);
        if (dataChanged) grids = nextGrids;
        const currentExaggeration = Number(exaggeration.value);
        if (!layer || dataChanged || displayedMaximum !== currentExaggeration || displayedWireframe !== wireframe.checked) {
            layer = new GlobeTerrainLayer({id: 'globe-terrain', data: grids, globeTerrainExaggeration: currentExaggeration, wireframe: wireframe.checked});
            displayedMaximum = currentExaggeration; displayedWireframe = wireframe.checked;
        }
        deck.setProps({layers: [layer]});
        const statistics = tileset.getStatistics();
        const effective = getGlobeTerrainExaggeration(getGlobeScreenRatio(viewport), Number(exaggeration.value));
        const highest = Math.max(0, ...drawable.map(tile => tile.coordinate.zoom));
        status.textContent = `${device === 'webgpu' ? 'WebGPU' : 'WebGL 2'} · ${drawable.length} tiles · z${highest} detail · ${effective.toFixed(1)}× displayed · ${(statistics.bytes / 1000000).toFixed(1)} / ${(statistics.byteLimit / 1000000).toFixed(0)} MB cached${statistics.active || statistics.queued ? ` · ${statistics.active} active / ${statistics.queued} queued` : ''}${detail.limited ? ' · detail budget/source limit' : ''}${statistics.failed ? ` · ${statistics.failed} failed: ${statistics.failure} — retry available` : ''}${renderingError ? ` · Rendering error: ${renderingError}` : ''}`;
    }
    tileset = new TerrainTileset({minZoom: 1, maxZoom: source.maxZoom, hierarchical: true, maxResidentBytes: 256 * 1024 * 1024, maxCachedTiles: 48, maxCachedBytes: 64 * 1024 * 1024, fetch: (tile, signal) => source.fetchTile(tile, signal),
        decode: (bytes, tile, error, signal) => decodeTerrainInWorker(workerUrl.href, bytes, getTerrainTileBounds(tile.zoom, tile.column, tile.row), error, signal, source.noData), onChange: schedule});
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
    detailControl.addEventListener('change', () => {
        parameters.set('detail', detailControl.value); options.onParametersChange?.(new URLSearchParams(parameters)); clearTimeout(detailTimer); detailTimer = undefined; detailCameraSignature = ''; schedule();
    }, {signal: abort.signal});
    element('retry').addEventListener('click', () => tileset?.retry(), {signal: abort.signal});
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
    return {ready: tileset.waitForIdle().then(() => {updateLayers();}), destroy() {
        if (disposed) return; disposed = true; clearTimeout(detailTimer); abort.abort(); observer.disconnect(); cancelAnimationFrame(animationFrame); tileset?.destroy(); destroyCard(); deck.finalize(); root.remove();
    }};
}
