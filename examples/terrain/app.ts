// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Deck, MapView, WebMercatorViewport, LightingEffect, AmbientLight, DirectionalLight, type MapViewState} from '@deck.gl/core';
import {TerrainLayer} from '@deck.gl/geo-layers';
import {webgpuAdapter} from '@luma.gl/webgpu';
import {createCollapsibleInfoCard} from '../deck/info-card.js';
import {TerrainScreenQuery, type TerrainScreenHit} from './picking';
import {terrainMarkup} from './view';
import {TerrainDecoderPool} from './decoder-pool';
import {formatTerrainDecoderStatus} from './decoder-status';
import {selectTerrainTiles, getTerrainTileKey, getTerrainTileBounds} from './tile-selection';
import {TerrainTileset} from './terrain-tileset';
import {buildTerrainRenderMesh, terrainGridsTouch, type TerrainRenderMesh} from './terrain-mesh';
import {sampleTerrainAnchor} from './ground-following';
import {selectTerrainDetail} from './terrain-detail';
import {createMapterhornTerrainSource, validateTerrainImageSource, type TerrainImageSource} from './terrain-source';

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
  /** One immutable Terrarium source per mount; bytes and attribution never mix across sources. */
  source?: TerrainImageSource;
  /** Hard source/decoded-array cache cap; draw/query/GPU allocations are separate. */
  maxResidentBytes?: number;
}): TerrainExample {
  const workerUrl = new URL(options.workerUrl, location.href).href;
  if (new URL(workerUrl).origin !== location.origin) throw new Error('Terrain worker must be same-origin');
  if (options.maxVisibleTiles !== undefined && (!Number.isSafeInteger(options.maxVisibleTiles) || options.maxVisibleTiles < 1 || options.maxVisibleTiles > 25)) throw new Error('Invalid terrain visible tile budget');
  if (options.maxResidentBytes !== undefined && (!Number.isSafeInteger(options.maxResidentBytes) || options.maxResidentBytes < 0)) throw new Error('Invalid terrain resident byte budget');
  const source = options.source ?? createMapterhornTerrainSource();
  validateTerrainImageSource(source);
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
  const detail = element<HTMLSelectElement>('tile-detail');
  const follow = element<HTMLInputElement>('follow-terrain');
  const clearance = element<HTMLSelectElement>('clearance');
  const container = element<HTMLDivElement>('map');
  const attribution = element<HTMLParagraphElement>('attribution');
  attribution.replaceChildren(document.createTextNode('Elevation: '));
  source.credits.forEach((credit, index) => {
    if (index) attribution.append(document.createTextNode(' · '));
    const link = document.createElement('a'); link.textContent = credit.label; link.href = credit.url; link.rel = 'noopener noreferrer'; attribution.append(link);
  });
  const bounds = getTerrainTileBounds(11, 1068, 728);
  let camera: MapViewState = {longitude: (bounds[0] + bounds[2]) / 2, latitude: (bounds[1] + bounds[3]) / 2, position: [0, 0, 2500], zoom: 11.7, pitch: 60, bearing: -25};
  let freeAnchorHeight = 2500;
  let anchorAvailable = false;
  let deviceType = parameters.get('device') === 'webgl' ? 'webgl' : parameters.get('device') === 'webgpu' || navigator.gpu ? 'webgpu' : 'webgl';
  const abort = new AbortController();
  let disposed = false;
  let animationFrame = 0;
  let signature = '';
  let revision = 0;
  let detailZoom: number | undefined;
  let detailLimited = false;
  let tileset: TerrainTileset | undefined;
  const decoder = new TerrainDecoderPool(workerUrl);
  /** Only drawable meshes are retained; off-screen payloads remain in the bounded source cache. */
  const geometry = new Map<string, {signature: string; mesh: TerrainRenderMesh; bounds: [number, number, number, number]; revision: number; query: TerrainScreenQuery}>();
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
  /** Follow the MapView target, not an avatar; missing terrain retains the previous elevation. */
  function updateAnchor(): boolean {
    if (!follow.checked) {anchorAvailable = false; return false;}
    const height = sampleTerrainAnchor([...geometry.values()].map(tile => tile.mesh.loaded), [camera.longitude, camera.latitude], Number(clearance.value));
    anchorAvailable = height !== null;
    if (height === null || Math.abs((camera.position?.[2] ?? 0) - height) < 1e-4) return false;
    camera = {...camera, position: [camera.position?.[0] ?? 0, camera.position?.[1] ?? 0, height]};
    return true;
  }
  function createDeck(): Deck<MapView> {
    return new Deck({
      parent: container, width: '100%', height: '100%', useDevicePixels: true,
      views: new MapView({id: 'terrain', controller: {dragRotate: true, touchRotate: true}}),
      viewState: camera,
      onViewStateChange: ({viewState}) => {camera = {...viewState, position: viewState.position ?? camera.position}; if (!follow.checked) freeAnchorHeight = camera.position?.[2] ?? 0; updateAnchor(); deck.setProps({viewState: camera}); schedule();},
      deviceProps: deviceType === 'webgpu' ? {type: 'webgpu', adapters: [webgpuAdapter]} : {type: 'webgl'},
      effects: [new LightingEffect({ambient: new AmbientLight({intensity: 1}), sun: new DirectionalLight({direction: [-1, -2, -3], intensity: 2})})],
      onError: exception => {if (!disposed) status.textContent = `Rendering error: ${exception.message}`;},
      onClick: information => {
        const viewport = information.viewport || deck.getViewports()[0];
        let nearest: TerrainScreenHit | null = null;
        for (const tile of geometry.values()) {
          const hit = tile.query.pick(viewport, [information.x, information.y]);
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
    const resolved = selectTerrainDetail(viewport, {targetTilePixels: Number(detail.value), minZoom: source.minZoom, maxZoom: source.maxZoom, previousZoom: detailZoom});
    detailZoom = resolved.zoom; detailLimited = resolved.limited;
    const selected = selectTerrainTiles(viewport, options.maxVisibleTiles ?? 9, detailZoom);
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
      const neighbors = drawable.filter(neighbor => neighbor.key !== tile.key && neighbor.data && terrainGridsTouch(data.grid, neighbor.data.grid)).sort((first, second) => first.key.localeCompare(second.key)).flatMap(neighbor => neighbor.data ? [neighbor.data.grid] : []);
      const meshSignature = `${payloadId(data)}:${neighbors.map(payloadId).join(',')}:${skirts.checked}`;
      let cached = geometry.get(tile.key);
      if (!cached || cached.signature !== meshSignature) {
        const mesh = buildTerrainRenderMesh(data, neighbors, skirts.checked ? 250 : 0);
        cached = {signature: meshSignature, mesh, bounds: getTerrainTileBounds(tile.coordinate.zoom, tile.coordinate.column, tile.coordinate.row), revision: ++revision, query: new TerrainScreenQuery(mesh.loaded.mesh)};
        geometry.set(tile.key, cached);
      }
      const mesh = cached.mesh.renderMesh;
      triangles += (mesh.indices?.value.length ?? 0) / 3;
      layers.push(new TerrainLayer({id: `terrain-${tile.key}`, elevationData: `terrain://${tile.key}?revision=${cached.revision}`, bounds: cached.bounds, wireframe: wireframe.checked, color: [145, 178, 150], material: {ambient: 0.3, diffuse: 0.8, shininess: 16}, fetch: async () => mesh}));
    }
    if (updateAnchor()) schedule();
    deck.setProps({layers, viewState: camera});
    const statistics = tileset.getStatistics();
    element('decoder-status').textContent = formatTerrainDecoderStatus(decoder.getStatistics(), statistics);
    status.textContent = `${deviceType === 'webgpu' ? 'WebGPU' : 'WebGL 2'} · ${drawable.length} tiles · ${triangles} triangles · data z${detailZoom}${detailLimited ? ' (source/footprint limit)' : ''} · ${statistics.active} active / ${statistics.queued} queued · ${(statistics.bytes / 1000000).toFixed(1)} / ${(statistics.byteLimit / 1000000).toFixed(1)} MB cached${follow.checked ? ` · terrain anchor ${anchorAvailable ? `${camera.position?.[2].toFixed(1)} m` : 'waiting — height held'}` : ''}${statistics.failed ? ` · ${statistics.failed} failed: ${statistics.failure?.slice(0, 200)} — retry available` : ''}`;
  }
  tileset = new TerrainTileset({
    fetch: (tile, signal) => source.fetchTile(tile, signal), minZoom: source.minZoom, maxZoom: source.maxZoom,
    decode: (bytes, tile, meshMaxError, signal) => decoder.decodeMesh(bytes, getTerrainTileBounds(tile.zoom, tile.column, tile.row), meshMaxError, signal, source.noData),
    onChange: schedule, maxResidentBytes: options.maxResidentBytes
  });
  const observer = new ResizeObserver(() => {if (!disposed) {deck.setProps({width: container.clientWidth, height: container.clientHeight}); schedule();}});
  observer.observe(container);
  error.addEventListener('change', () => {updateSelection(); schedule();}, {signal: abort.signal});
  wireframe.addEventListener('change', schedule, {signal: abort.signal});
  skirts.addEventListener('change', schedule, {signal: abort.signal});
  detail.addEventListener('change', () => {detailZoom = undefined; updateSelection(); schedule();}, {signal: abort.signal});
  follow.addEventListener('change', () => {
    if (!follow.checked) camera = {...camera, position: [camera.position?.[0] ?? 0, camera.position?.[1] ?? 0, freeAnchorHeight]};
    updateAnchor(); deck.setProps({viewState: camera}); schedule();
  }, {signal: abort.signal});
  clearance.addEventListener('change', () => {updateAnchor(); deck.setProps({viewState: camera}); schedule();}, {signal: abort.signal});
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
    disposed = true; abort.abort(); cancelAnimationFrame(animationFrame); tileset?.destroy(); decoder.destroy(); geometry.clear(); observer.disconnect(); destroyCard(); deck.finalize(); root.remove();
  }};
}
