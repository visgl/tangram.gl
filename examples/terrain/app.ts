// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Deck, MapView, WebMercatorViewport, LightingEffect, AmbientLight, DirectionalLight, type MapViewState} from '@deck.gl/core';
import {TerrainLayer} from '@deck.gl/geo-layers';
import {webgpuAdapter} from '@luma.gl/webgpu';
import {createCollapsibleInfoCard} from '../deck/info-card.js';
import {getTerrainTileBounds} from './load-terrain';
import {pickTerrainSurface} from './picking';
import {terrainMarkup} from './view';
import {decodeTerrainInWorker} from './worker-client';
import {selectTerrainTiles, getTerrainTileKey} from './tile-selection';
import {TerrainTileset} from './terrain-tileset';
import {buildTerrainRenderMesh, type TerrainRenderMesh} from './terrain-mesh';

/** One mounted example owns its canvas, controls, workers and GPU resources. */
export interface TerrainExample {
  /** Resolve after the initial bounded batch, including any reported failures. */
  ready: Promise<void>;
  /** Cancel actual fetch/decode work and release resources; safe to repeat. */
  destroy(): void;
}

/** Mount streamed terrain without document-global selectors or import-time side effects. */
export function mountTerrainExample(host: HTMLElement, options: {
  /** Explicit same-origin worker asset, supplied by the website or standalone host. */
  workerUrl: string;
  /** Initial URL settings. */
  parameters?: URLSearchParams;
  /** Persist settings without navigating away. */
  onParametersChange?: (parameters: URLSearchParams) => void;
  /** Bound visible detail; primarily useful for deterministic host tests. */
  maxVisibleTiles?: number;
}): TerrainExample {
  const workerUrl = new URL(options.workerUrl, location.href).href;
  if (new URL(workerUrl).origin !== location.origin) throw new Error('Terrain worker must be same-origin');
  if (options.maxVisibleTiles !== undefined && (!Number.isSafeInteger(options.maxVisibleTiles) || options.maxVisibleTiles < 1 || options.maxVisibleTiles > 25)) throw new Error('Invalid terrain visible tile budget');
  const root = document.createElement('div');
  root.className = 'mounted-example terrain-example';
  root.innerHTML = terrainMarkup;
  host.append(root);
  const parameters = new URLSearchParams(options.parameters);
  const element = <T extends HTMLElement>(name: string): T => {
    const value = root.querySelector<T>(`[data-example="${name}"]`);
    if (!value) throw new Error(`Missing terrain control: ${name}`);
    return value;
  };
  const status = element<HTMLParagraphElement>('status');
  const selection = element<HTMLOutputElement>('terrain-hit');
  const error = element<HTMLSelectElement>('mesh-error');
  const wireframe = element<HTMLInputElement>('wireframe');
  const skirts = element<HTMLInputElement>('skirts');
  const container = element<HTMLDivElement>('map');
  const bounds = getTerrainTileBounds(11, 1068, 728);
  let camera: MapViewState = {longitude: (bounds[0] + bounds[2]) / 2, latitude: (bounds[1] + bounds[3]) / 2, position: [0, 0, 2500], zoom: 11.7, pitch: 60, bearing: -25};
  let deviceType = parameters.get('device') === 'webgl' ? 'webgl' : parameters.get('device') === 'webgpu' || navigator.gpu ? 'webgpu' : 'webgl';
  const abort = new AbortController();
  let disposed = false;
  let animationFrame = 0;
  let signature = '';
  let revision = 0;
  let tileset: TerrainTileset | undefined;
  /** Only drawable meshes are retained; off-screen payloads remain in the bounded source cache. */
  const geometry = new Map<string, {signature: string; mesh: TerrainRenderMesh; bounds: [number, number, number, number]; revision: number}>();
  const payloadIds = new WeakMap<object, number>();
  /** Give immutable worker payloads an identity without retaining evicted data. */
  function payloadId(value: object): number {
    let identity = payloadIds.get(value);
    if (identity === undefined) {identity = ++revision; payloadIds.set(value, identity);}
    return identity;
  }
  /** Coalesce cache/camera notifications; camera movement does not rebuild unchanged meshes. */
  function schedule(): void {
    if (!disposed && !animationFrame) animationFrame = requestAnimationFrame(() => {animationFrame = 0; updateSelection(); updateLayers();});
  }
  function createDeck(): Deck<MapView> {
    return new Deck({
      parent: container, width: '100%', height: '100%', useDevicePixels: true,
      views: new MapView({id: 'terrain', controller: {dragRotate: true, touchRotate: true}}),
      viewState: camera,
      onViewStateChange: ({viewState}) => {camera = viewState; deck.setProps({viewState: camera}); schedule();},
      deviceProps: deviceType === 'webgpu' ? {type: 'webgpu', adapters: [webgpuAdapter]} : {type: 'webgl'},
      effects: [new LightingEffect({ambient: new AmbientLight({intensity: 1}), sun: new DirectionalLight({direction: [-1, -2, -3], intensity: 2})})],
      onError: exception => {if (!disposed) status.textContent = `Rendering error: ${exception.message}`;},
      onClick: information => {
        const viewport = information.viewport || deck.getViewports()[0];
        let nearest: ReturnType<typeof pickTerrainSurface> = null;
        for (const tile of geometry.values()) {
          const hit = pickTerrainSurface(viewport, tile.mesh.loaded.mesh, [information.x, information.y]);
          if (hit && (!nearest || hit.rayParameter < nearest.rayParameter)) nearest = hit;
        }
        selection.textContent = nearest ? `${nearest.coordinate[0].toFixed(5)}, ${nearest.coordinate[1].toFixed(5)} — ${nearest.coordinate[2].toFixed(1)} m (triangle ${nearest.triangleIndex})` : 'Outside the loaded terrain surface';
      }
    });
  }
  let deck = createDeck();
  /** Select at most nine detail tiles and their immediate coarse parents. */
  function updateSelection(): void {
    if (!tileset || disposed) return;
    const viewport = new WebMercatorViewport({...camera, width: Math.max(1, container.clientWidth), height: Math.max(1, container.clientHeight)});
    const selected = selectTerrainTiles(viewport, options.maxVisibleTiles ?? 9);
    const next = `${selected.map(getTerrainTileKey).join(',')}:${error.value}`;
    if (next !== signature) {signature = next; tileset.update(selected, Number(error.value));}
  }
  /** Loaders.gl prepares topology; TerrainLayer draws it without invoking its older loader. */
  function updateLayers(): void {
    if (!tileset || disposed) return;
    const drawable = tileset.getDrawableTiles();
    const visible = new Set(drawable.map(tile => tile.key));
    for (const key of geometry.keys()) if (!visible.has(key)) geometry.delete(key);
    const layers: TerrainLayer[] = [];
    let triangles = 0;
    for (const tile of drawable) {
      if (!tile.data) continue;
      const data = tile.data;
      const neighbors = drawable.filter(neighbor => neighbor.key !== tile.key && neighbor.coordinate.zoom === tile.coordinate.zoom && Math.abs(neighbor.coordinate.column - tile.coordinate.column) <= 1 && Math.abs(neighbor.coordinate.row - tile.coordinate.row) <= 1).sort((first, second) => first.coordinate.row - second.coordinate.row || first.coordinate.column - second.coordinate.column).flatMap(neighbor => neighbor.data ? [neighbor.data.grid] : []);
      const meshSignature = `${payloadId(data)}:${neighbors.map(payloadId).join(',')}:${skirts.checked}`;
      let cached = geometry.get(tile.key);
      if (!cached || cached.signature !== meshSignature) {
        cached = {signature: meshSignature, mesh: buildTerrainRenderMesh(data, neighbors, skirts.checked ? 250 : 0), bounds: getTerrainTileBounds(tile.coordinate.zoom, tile.coordinate.column, tile.coordinate.row), revision: ++revision};
        geometry.set(tile.key, cached);
      }
      const mesh = cached.mesh.renderMesh;
      triangles += (mesh.indices?.value.length ?? 0) / 3;
      layers.push(new TerrainLayer({id: `terrain-${tile.key}`, elevationData: `terrain://${tile.key}?revision=${cached.revision}`, bounds: cached.bounds, wireframe: wireframe.checked, color: [145, 178, 150], material: {ambient: 0.3, diffuse: 0.8, shininess: 16}, fetch: async () => mesh}));
    }
    deck.setProps({layers});
    const statistics = tileset.getStatistics();
    status.textContent = `${deviceType === 'webgpu' ? 'WebGPU' : 'WebGL 2'} · ${drawable.length} tiles · ${triangles} triangles · ${statistics.active} active / ${statistics.queued} queued · ${(statistics.bytes / 1024 / 1024).toFixed(1)} MB cached${statistics.failed ? ` · ${statistics.failed} failed — retry available` : ''}`;
  }
  tileset = new TerrainTileset({
    async fetch(tile, signal) {
      const response = await fetch(`https://tiles.mapterhorn.com/${getTerrainTileKey(tile)}.webp`, {signal});
      if (!response.ok) throw new Error(`Mapterhorn HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 8 * 1024 * 1024) throw new Error('Terrain image exceeds compressed byte limit');
      return bytes;
    },
    decode: (bytes, tile, meshMaxError, signal) => decodeTerrainInWorker(workerUrl, bytes, getTerrainTileBounds(tile.zoom, tile.column, tile.row), meshMaxError, signal),
    onChange: schedule
  });
  const observer = new ResizeObserver(() => {if (!disposed) {deck.setProps({width: container.clientWidth, height: container.clientHeight}); schedule();}});
  observer.observe(container);
  error.addEventListener('change', () => {updateSelection(); schedule();}, {signal: abort.signal});
  wireframe.addEventListener('change', schedule, {signal: abort.signal});
  skirts.addEventListener('change', schedule, {signal: abort.signal});
  element('retry').addEventListener('click', () => tileset?.retry(), {signal: abort.signal});
  const destroyCard = createCollapsibleInfoCard(element('controls'));
  function updateDeviceTabs(): void {
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-device-type]')) {
      button.classList.toggle('is-active', button.dataset.deviceType === deviceType);
      button.setAttribute('aria-selected', String(button.dataset.deviceType === deviceType));
    }
  }
  updateDeviceTabs();
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-device-type]')) button.addEventListener('click', () => {
    const next = button.dataset.deviceType;
    if ((next !== 'webgl' && next !== 'webgpu') || next === deviceType) return;
    deck.finalize(); deviceType = next; deck = createDeck(); updateDeviceTabs(); updateLayers();
    parameters.set('device', deviceType); options.onParametersChange?.(new URLSearchParams(parameters));
  }, {signal: abort.signal});
  element('fullscreen').addEventListener('click', () => {
    const request = document.fullscreenElement === root ? document.exitFullscreen() : root.requestFullscreen();
    void request.catch(exception => {if (!disposed) status.textContent = `Fullscreen unavailable: ${exception.message}`;});
  }, {signal: abort.signal});
  updateSelection();
  const ready = tileset.waitForIdle().then(() => {if (!disposed) updateLayers();});
  return {ready, destroy() {
    if (disposed) return;
    disposed = true; abort.abort(); cancelAnimationFrame(animationFrame); tileset?.destroy(); geometry.clear(); observer.disconnect(); destroyCard(); deck.finalize(); root.remove();
  }};
}
