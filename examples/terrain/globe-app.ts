// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Deck, _GlobeView as GlobeView, type GlobeViewState} from '@deck.gl/core';
import {webgpuAdapter} from '@luma.gl/webgpu';
import {GlobeTerrainLayer, getGlobeScreenRatio} from '@vis.gl/tangram-layers/experimental/terrain';
import {getGlobeTerrainExaggeration, type TerrainHeightGrid} from '@vis.gl/tangram-renderer/map-logic';
import {createCollapsibleInfoCard} from '../deck/info-card.js';
import {TerrainTileset} from './terrain-tileset';
import {getTerrainTileBounds} from './tile-selection';
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
    const requested = Number(parameters.get('exaggeration') ?? 100);
    const maximum = Number.isFinite(requested) && requested >= 0 && requested <= 200 ? Math.round(requested) : 100;
    let currentMaximum = maximum;
    const root = document.createElement('div');
    root.className = 'mounted-example terrain-example';
    root.innerHTML = `<div data-example="map"></div><aside data-example="controls">
      <h1>Globe terrain</h1><p data-example="status" role="status">Loading global elevation…</p>
      <label class="control"><span>Maximum globe exaggeration <output data-example="exaggeration-value"></output></span><input data-example="exaggeration" type="range" min="0" max="200" step="1"></label>
      <label class="control checkbox-control"><input data-example="wireframe" type="checkbox"> Wireframe</label>
      <button data-example="retry" type="button">Retry failed tiles</button>
      <output data-example="terrain-hit" aria-live="polite">Click terrain for physical elevation</output>
      <p class="hint">Drag to rotate; scroll/pinch to zoom. Exaggerated relief fades to 1× over two apparent-diameter doublings; 0× stays flat.</p>
      <p class="hint">Experimental global z2 DEM preview, not high-detail terrain or basemap draping. Source pixels stay warm while rotating and zooming. Polar regions outside ±85.05° and no-data areas have no terrain. Elevations retain the source datum; displayed mountains are exaggerated, returned meters are not.</p>
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
    let deckReady = false, deckGeneration = 0;
    let renderingError: string | undefined;
    let tileset: TerrainTileset | undefined;
    let grids: TerrainHeightGrid[] = [];
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
            onViewStateChange: ({viewState}) => {camera = {...viewState, zoom: Math.min(12, viewState.zoom), maxZoom: 12}; deck.setProps({viewState: camera}); schedule();},
            onError: error => {if (!disposed && generation === deckGeneration) {renderingError = error.message; status.textContent = `Rendering error: ${error.message}`;}},
            onClick: information => {
                const viewport = information.viewport ?? deck.getViewports()[0];
                const hit = viewport && layer?.pickTerrain(viewport, [information.x, information.y]);
                output.textContent = hit ? `${hit.coordinate[0].toFixed(4)}, ${hit.coordinate[1].toFixed(4)} — ${hit.coordinate[2].toFixed(1)} physical m` : 'Outside loaded terrain';
            }, onLoad: () => {if (!disposed && generation === deckGeneration) {deckReady = true; schedule();}}});
    }
    let deck = createDeck();
    /** Change display geometry only; fixed global source coverage survives zoom/rotation/device changes. */
    function updateLayers(): void {
        if (!tileset || disposed || !deckReady) return;
        // Swap the entire world together; never join unstitched coarse/fine boundaries.
        const records = [...tileset.records.values()];
        const fine = records.filter(tile => tile.coordinate.zoom === 2 && tile.data);
        const drawable = fine.length === 16 ? fine : records.filter(tile => tile.coordinate.zoom === 1 && tile.data);
        const nextGrids = drawable.flatMap(tile => tile.data ? [tile.data.grid] : []);
        if (grids.length !== nextGrids.length || grids.some((grid, index) => grid !== nextGrids[index])) grids = nextGrids;
        layer = new GlobeTerrainLayer({id: 'globe-terrain', data: grids, globeTerrainExaggeration: Number(exaggeration.value), wireframe: wireframe.checked});
        deck.setProps({layers: [layer]});
        const viewport = deck.getViewports()[0], statistics = tileset.getStatistics();
        const effective = viewport ? getGlobeTerrainExaggeration(getGlobeScreenRatio(viewport), Number(exaggeration.value)) : maximum;
        status.textContent = `${device === 'webgpu' ? 'WebGPU' : 'WebGL 2'} · ${drawable.length} tiles · ${effective.toFixed(1)}× displayed · ${(statistics.bytes / 1000000).toFixed(1)} MB cached${statistics.failed ? ` · ${statistics.failed} failed: ${statistics.failure} — retry available` : ''}${renderingError ? ` · Rendering error: ${renderingError}` : ''}`;
    }
    tileset = new TerrainTileset({minZoom: 0, maxZoom: 2, fetch: (tile, signal) => source.fetchTile(tile, signal),
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
    element('retry').addEventListener('click', () => tileset?.retry(), {signal: abort.signal});
    element('fullscreen').addEventListener('click', () => {if (document.fullscreenElement === root) void document.exitFullscreen(); else void root.requestFullscreen().catch(error => {status.textContent = `Fullscreen unavailable: ${error.message}`;});}, {signal: abort.signal});
    /** Preserve source/cache ownership when switching GPU devices. */
    function updateTabs(): void {
        for (const button of root.querySelectorAll<HTMLButtonElement>('[data-device-type]')) {button.classList.toggle('is-active', button.dataset.deviceType === device); button.setAttribute('aria-selected', String(button.dataset.deviceType === device));}
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-device-type]')) button.addEventListener('click', () => {
        if (button.dataset.deviceType === device) return;
        device = button.dataset.deviceType === 'webgpu' ? 'webgpu' : 'webgl'; renderingError = undefined; deck.finalize(); deck = createDeck(); updateTabs(); schedule();
        parameters.set('device', device); options.onParametersChange?.(new URLSearchParams(parameters));
    }, {signal: abort.signal});
    updateTabs();
    const destroyCard = createCollapsibleInfoCard(element('controls'));
    const coordinates = Array.from({length: 16}, (_, index) => ({zoom: 2, column: index % 4, row: Math.floor(index / 4)}));
    tileset.update(coordinates, 10000);
    return {ready: tileset.waitForIdle().then(() => {updateLayers();}), destroy() {
        if (disposed) return; disposed = true; abort.abort(); observer.disconnect(); cancelAnimationFrame(animationFrame); tileset?.destroy(); destroyCard(); deck.finalize(); root.remove();
    }};
}
