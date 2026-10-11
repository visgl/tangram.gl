// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Deck, MapView, LightingEffect, AmbientLight, DirectionalLight} from '@deck.gl/core';
import {TerrainLayer} from '@deck.gl/geo-layers';
import {webgpuAdapter} from '@luma.gl/webgpu';
import {createCollapsibleInfoCard} from '../deck/info-card.js';
import {getTerrainTileBounds, parseTerrainTile} from './load-terrain';
import {pickTerrainSurface} from './picking';

/** The reference deliberately loads one bounded tile, not a second tiled-terrain scheduler. */
const tile = {zoom: 11, column: 1068, row: 728};
const bounds = getTerrainTileBounds(tile.zoom, tile.column, tile.row);
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const selection = document.querySelector<HTMLOutputElement>('#terrain-hit')!;
const error = document.querySelector<HTMLSelectElement>('#mesh-error')!;
const wireframe = document.querySelector<HTMLInputElement>('#wireframe')!;
const container = document.querySelector<HTMLDivElement>('#terrain-map')!;
const deviceType = new URLSearchParams(location.search).get('device') || (navigator.gpu ? 'webgpu' : 'webgl');
const abort = new AbortController();
const url = `https://tiles.mapterhorn.com/${tile.zoom}/${tile.column}/${tile.row}.webp`;
let revision = 0;
let loaded: Awaited<ReturnType<typeof parseTerrainTile>> | undefined;
let bytes: ArrayBuffer | undefined;
let disposed = false;

const deck = new Deck({parent: container, width: '100%', height: '100%', useDevicePixels: true,
    views: new MapView({id: 'terrain', controller: {dragRotate: true, touchRotate: true}}),
    initialViewState: {longitude: (bounds[0] + bounds[2]) / 2, latitude: (bounds[1] + bounds[3]) / 2, position: [0, 0, 2500], zoom: 11.7, pitch: 60, bearing: -25},
    deviceProps: deviceType === 'webgpu' ? {type: 'webgpu', adapters: [webgpuAdapter]} : {type: 'webgl'},
    effects: [new LightingEffect({ambient: new AmbientLight({intensity: 1}), sun: new DirectionalLight({direction: [-1, -2, -3], intensity: 2})})],
    onError: exception => {status.textContent = `Rendering error: ${exception.message}`;},
    onClick: information => {
        if (!loaded || !information.viewport) return;
        const hit = pickTerrainSurface(information.viewport, loaded.mesh, [information.x, information.y]);
        selection.textContent = hit ? `${hit.coordinate[0].toFixed(5)}, ${hit.coordinate[1].toFixed(5)} — ${hit.coordinate[2].toFixed(1)} m (triangle ${hit.triangleIndex})` : 'Outside the loaded terrain mesh';
    }});

/** Reuse the downloaded bytes when changing simplification; never draw stale parse results. */
async function updateMesh(): Promise<void> {
    // An early selector change is just a requested setting. The completed
    // download will use it; there is not yet anything to parse or invalidate.
    if (!bytes || disposed) return;
    const currentRevision = ++revision;
    status.textContent = 'Building terrain with loaders.gl…';
    try {
        const result = await parseTerrainTile(bytes, bounds, Number(error.value));
        if (disposed || currentRevision !== revision) return;
        loaded = result;
        selection.textContent = 'Click the surface to query its rendered triangle';
        updateLayer();
        status.textContent = `${deviceType === 'webgpu' ? 'WebGPU' : 'WebGL 2'} · ${result.mesh.indices!.value.length / 3} triangles · physical heights, 1× scale`;
    } catch (exception) {
        if (!disposed && currentRevision === revision) status.textContent = `Terrain error: ${exception instanceof Error ? exception.message : String(exception)}`;
    }
}

/** TerrainLayer owns drawing; the custom fetch supplies the predecoded v5 mesh, not its v4 loader. */
function updateLayer(): void {
    if (!loaded) return;
    const mesh = loaded.mesh;
    deck.setProps({layers: [new TerrainLayer({id: `terrain-${revision}`, elevationData: url, bounds: [...bounds],
        wireframe: wireframe.checked, color: [145, 178, 150], material: {ambient: 0.3, diffuse: 0.8, shininess: 16},
        fetch: async () => mesh})]});
}

error.addEventListener('change', updateMesh);
wireframe.addEventListener('change', updateLayer);
const destroyCard = createCollapsibleInfoCard(document.querySelector('#controls'));
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-device-type]')) {
    button.classList.toggle('is-active', button.dataset.deviceType === deviceType);
    button.setAttribute('aria-selected', String(button.dataset.deviceType === deviceType));
    button.addEventListener('click', () => {const target = new URL(location.href); target.searchParams.set('device', button.dataset.deviceType!); location.href = target.href;});
}
document.querySelector('#example-fullscreen')?.addEventListener('click', () => {
    const request = document.fullscreenElement ? document.exitFullscreen() : document.querySelector('#deck-container')!.requestFullscreen();
    void request.catch(exception => {status.textContent = `Fullscreen unavailable: ${exception.message}`;});
});
window.addEventListener('pagehide', event => {
    // A bfcache-restored page resumes this same module and Deck instance.
    if (event.persisted || disposed) return;
    disposed = true; revision++; abort.abort(); destroyCard(); deck.finalize();
});
try {
    status.textContent = 'Loading Mapterhorn elevation…';
    const response = await fetch(url, {signal: abort.signal});
    if (!response.ok) throw new Error(`Mapterhorn HTTP ${response.status}`);
    bytes = await response.arrayBuffer();
    if (!disposed) await updateMesh();
} catch (exception) {
    if (!disposed) status.textContent = `Elevation unavailable: ${exception instanceof Error ? exception.message : String(exception)}`;
}
