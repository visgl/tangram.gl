// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Deck, MapView, FirstPersonView, WebMercatorViewport, LightingEffect, AmbientLight, DirectionalLight, type MapViewState} from '@deck.gl/core';
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
import {getTerrainEyeCoordinate, constrainTerrainEye, constrainTerrainMotion} from './first-person';
import {selectTerrainDetail} from './terrain-detail';
import {createMapterhornTerrainSource, validateTerrainImageSource, type TerrainImageSource} from './terrain-source';
import {createDrapedBasemap} from './draped-basemap';
import type {SceneDefinition, TerrainDrapingOptions} from '@vis.gl/tangram-renderer/core';
import {TerrainSurfaceCollection} from '@vis.gl/tangram-renderer/core';
import {TerrainResourceBudget, TerrainHeightField, type TerrainHeightGrid} from '@vis.gl/tangram-renderer/map-logic';
import {getConfiguredAttributions, updateAttribution} from '../classic/app/attribution.js';

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
  /** Select a MapView target or FirstPerson eye; either uses the same bounded source pipeline. */
  view?: 'map' | 'first-person';
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
  /** Optional offline scene for host conformance, or false to disable basemap integration. */
  basemap?: SceneDefinition | false;
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
  const firstPerson = (options.view ?? parameters.get('view')) === 'first-person';
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
  const draping = element<HTMLInputElement>('draping');
  draping.checked = options.basemap !== false;
  draping.disabled = options.basemap === false;
  const detail = element<HTMLSelectElement>('tile-detail');
  const follow = element<HTMLInputElement>('follow-terrain');
  const clearance = element<HTMLSelectElement>('clearance');
  const container = element<HTMLDivElement>('map');
  const attribution = element<HTMLParagraphElement>('attribution');
  if (firstPerson) {
    element('title').textContent = 'FirstPerson terrain';
    element('follow-label').textContent = 'Keep eye above terrain';
    element('clearance-label').textContent = 'Minimum eye clearance (meters)';
    element('detail-label').textContent = 'Local source detail';
    for (const option of detail.options) option.textContent = option.value === '256' ? 'z12 — finer' : option.value === '1024' ? 'z10 — coarser' : 'z11 — balanced';
    follow.checked = true; clearance.value = '20';
    element<HTMLButtonElement>('land-eye').hidden = false;
    element('navigation-hint').textContent = 'Drag to look; Shift-drag to move sideways/up; arrow keys to walk; scroll to move forward. Focus the canvas for keyboard controls.';
    element('limitations').textContent = 'A bounded local tile window follows the actual eye, including XY meter offsets. Source detail is fixed by the detail selector, not a certified horizon/error policy. Draped ground drawing, picking and clearance share the admitted triangle surface and morph clock. Missing heights hold the eye. No avatar volume, walls, tunnels or gravity.';
  }
  attribution.replaceChildren(document.createTextNode('Elevation: '));
  source.credits.forEach((credit, index) => {
    if (index) attribution.append(document.createTextNode(' · '));
    const link = document.createElement('a'); link.textContent = credit.label; link.href = credit.url; link.rel = 'noopener noreferrer'; attribution.append(link);
  });
  const basemapCredits = document.createElement('span');
  basemapCredits.append(document.createTextNode(' · Basemap: '));
  const creditValue = document.createElement('span'); basemapCredits.append(creditValue);
  attribution.append(basemapCredits); basemapCredits.hidden = !draping.checked;
  const basemapScene = options.basemap || createDrapedBasemap();
  updateAttribution(creditValue, getConfiguredAttributions(basemapScene));
  let BasemapLayer: typeof import('@vis.gl/tangram-layers').TangramLayer | undefined;
  let fieldSignature = '';
  let terrain: TerrainDrapingOptions = {grids: [], transitionDuration: 200};
  const resourceBudget = new TerrainResourceBudget(512 * 1024 * 1024);
  let navigationGrids: readonly TerrainHeightGrid[] = [], navigationField = new TerrainHeightField([]);
  let activeBasemap: InstanceType<typeof import('@vis.gl/tangram-layers').TangramLayer> | undefined;
  let basemapError = '';
  let lastDrapingStatus = 0;
  const bounds = getTerrainTileBounds(11, 1068, 728);
  let camera: MapViewState & {position: [number, number, number]} = {longitude: (bounds[0] + bounds[2]) / 2, latitude: (bounds[1] + bounds[3]) / 2, position: [0, 0, firstPerson ? 3500 : 2500], zoom: 11.7, pitch: firstPerson ? 25 : 60, bearing: -25};
  let freeAnchorHeight = 2500;
  let anchorAvailable = false;
  let deviceType = parameters.get('device') === 'webgl' ? 'webgl' : parameters.get('device') === 'webgpu' || navigator.gpu ? 'webgpu' : 'webgl';
  const abort = new AbortController();
  let disposed = false;
  let deckGeneration = 0;
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
  /** While draping is enabled, an unavailable ground display is a hole, not permission to query another mesh. */
  function displayedSurface() {
    return draping.checked ? activeBasemap?.getDrapedTerrainSurface() ?? new TerrainSurfaceCollection('web-mercator', []) : undefined;
  }
  /** Follow a MapView target or clamp a FirstPerson point eye, never a swept avatar volume. */
  function updateAnchor(): boolean {
    if (!follow.checked) {anchorAvailable = false; return false;}
    if (firstPerson) {
      const result = constrainTerrainEye(camera, [...geometry.values()].map(tile => tile.mesh.loaded), Number(clearance.value), camera.position[2], displayedSurface());
      anchorAvailable = result.available;
      if (result.state.position[2] === camera.position[2]) return false;
      camera = {...camera, position: result.state.position};
      return true;
    }
    const height = sampleTerrainAnchor([...geometry.values()].map(tile => tile.mesh.loaded), [camera.longitude, camera.latitude], Number(clearance.value), displayedSurface());
    anchorAvailable = height !== null;
    if (height === null || Math.abs((camera.position?.[2] ?? 0) - height) < 1e-4) return false;
    camera = {...camera, position: [camera.position?.[0] ?? 0, camera.position?.[1] ?? 0, height]};
    return true;
  }
  function createDeck(): Deck<MapView | FirstPersonView> {
    const generation = ++deckGeneration;
    return new Deck({
      parent: container, width: '100%', height: '100%', useDevicePixels: true,
      views: firstPerson ? new FirstPersonView({id: 'terrain', near: 0.1, far: 20000, controller: {dragRotate: true, touchRotate: true, keyboard: true}}) : new MapView({id: 'terrain', controller: {dragRotate: true, touchRotate: true}}),
      viewState: camera,
      onViewStateChange: ({viewState}) => {
        if (disposed || generation !== deckGeneration) return;
        const previousCamera = camera;
        const position = viewState.position ?? camera.position;
        camera = {...camera, ...viewState, longitude: viewState.longitude ?? camera.longitude, latitude: viewState.latitude ?? camera.latitude, position: [position[0], position[1], position[2]]};
        if (firstPerson && follow.checked) {
          const result = constrainTerrainMotion(previousCamera, camera, [...geometry.values()].map(tile => tile.mesh.loaded), Number(clearance.value), displayedSurface(), {radius: 0.3, clearance: Math.min(1.7, Number(clearance.value)), field: navigationField});
          camera = {...camera, position: result.state.position}; anchorAvailable = result.available;
          camera.longitude = result.state.longitude; camera.latitude = result.state.latitude;
          if (result.blocked) selection.textContent = result.available ? 'Movement blocked by loaded terrain; looking remains enabled' : 'Waiting for loaded terrain; eye translation held';
        } else updateAnchor();
        if (!follow.checked) freeAnchorHeight = camera.position[2];
        deck.setProps({viewState: camera}); schedule();
      },
      deviceProps: deviceType === 'webgpu' ? {type: 'webgpu', adapters: [webgpuAdapter]} : {type: 'webgl'},
      effects: [new LightingEffect({ambient: new AmbientLight({intensity: 1}), sun: new DirectionalLight({direction: [-1, -2, -3], intensity: 2})})],
      onAfterRender: () => {
        if (disposed || generation !== deckGeneration) return;
        if (draping.checked && follow.checked && updateAnchor()) {deck.setProps({viewState: camera}); schedule();}
        if (performance.now() - lastDrapingStatus < 250) return;
        lastDrapingStatus = performance.now();
        const statistics = activeBasemap?.getTerrainDrapingStatistics();
        const query = activeBasemap?.getDrapedTerrainSurface()?.getStatistics();
        element('draping-status').textContent = draping.checked && statistics ? `Basemap: ${statistics.meshes} meshes · ${statistics.vertices} vertices · ${(statistics.gridBytes / 1000000).toFixed(1)} MB grid copies · ${(statistics.meshBytes / 1000000).toFixed(1)} MB draw / ${(statistics.queryBytes / 1000000).toFixed(1)} MB query inputs / ${(statistics.stagedMeshBytes / 1000000).toFixed(1)} MB staged · slowest worker ${statistics.maximumPreparationMs.toFixed(1)} ms${query ? ` · frame queries ${(query.projectedBytes / 1000000).toFixed(1)} MB / ${query.projectionBuilds} projection builds / ${query.queryMs.toFixed(1)} ms traversal` : ''}${basemapError ? ` · ${basemapError}` : ''}` : basemapError;
      },
      onError: exception => {if (!disposed && generation === deckGeneration) status.textContent = `Rendering error: ${exception.message}`;},
      onClick: information => {
        if (disposed || generation !== deckGeneration) return;
        const viewport = information.viewport || deck.getViewports()[0];
        let nearest: TerrainScreenHit | null = null;
        if (draping.checked) {
          const hit = activeBasemap?.getTerrainAt({x: information.x, y: information.y});
          selection.textContent = hit ? `${hit.coordinate[0].toFixed(5)}, ${hit.coordinate[1].toFixed(5)} — ${hit.coordinate[2].toFixed(1)} m (displayed ground)` : 'Outside the admitted draped ground';
          return;
        }
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
    if (firstPerson) {
      const coordinate = getTerrainEyeCoordinate(camera);
      // Explicit bounded local detail, not MapView footprint or horizon enumeration.
      const zoom = Math.max(source.minZoom, Math.min(source.maxZoom, Number(detail.value) === 256 ? 12 : Number(detail.value) === 1024 ? 10 : 11));
      detailZoom = zoom; detailLimited = true;
      const selected = selectTerrainTiles({longitude: coordinate[0], latitude: coordinate[1], zoom}, options.maxVisibleTiles ?? 9, zoom);
      const next = `${selected.map(getTerrainTileKey).join(',')}:${error.value}`;
      if (next !== signature) {signature = next; tileset.update(selected, Number(error.value));}
      return;
    }
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
    const selectedGrids = drawable.flatMap(tile => tile.data ? [tile.data.grid] : []);
    if (firstPerson && (selectedGrids.length !== navigationGrids.length || selectedGrids.some((grid, index) => grid !== navigationGrids[index]))) {
      navigationGrids = selectedGrids; navigationField = new TerrainHeightField(selectedGrids);
    }
    const visible = new Set(drawable.map(tile => tile.key));
    for (const key of geometry.keys()) if (!visible.has(key)) geometry.delete(key);
    const layers: (TerrainLayer | InstanceType<typeof import('@vis.gl/tangram-layers').TangramLayer>)[] = [];
    if (!draping.checked) activeBasemap = undefined;
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
      if (!draping.checked || !BasemapLayer) layers.push(new TerrainLayer({id: `terrain-${tile.key}`, elevationData: `terrain://${tile.key}?revision=${cached.revision}`, bounds: cached.bounds, wireframe: wireframe.checked, color: [145, 178, 150], material: {ambient: 0.3, diffuse: 0.8, shininess: 16}, fetch: async () => mesh}));
    }
    if (draping.checked && BasemapLayer) {
      const grids = drawable.flatMap(tile => tile.data ? [tile.data.grid] : []);
      // Mesh-error changes decode new topology from the same immutable bytes.
      // Their DEM values are unchanged; do not rebuild every styled basemap tile.
      const next = drawable.flatMap(tile => tile.data ? [`${tile.key}:${payloadId(tile.bytes ?? tile.data.grid)}`] : []).sort().join(',');
      if (next !== fieldSignature) {
        fieldSignature = next;
        terrain = {grids, transitionDuration: 200, maxSegmentLength: 250, groundMeshResolution: 32, querySurfaceStyles: ['ground'], occludeAnnotations: true};
      }
      activeBasemap = new BasemapLayer({id: 'draped-basemap', scene: basemapScene, terrain, terrainResourceBudget: resourceBudget, terrainExaggeration: 1, tileBuffer: 1,
        maxConcurrentTileLoadsPerWorker: 2, tileResources: {maxConcurrentBuilds: 2},
        firstPersonMaxGroundExtent: 20000,
        firstPersonElevationRange: [0, 10000],
        onAttributionChange: (credits: string[]) => {if (!disposed) updateAttribution(creditValue, credits);},
        onSceneError: (exception: unknown) => {if (!disposed) {basemapError = `Basemap error: ${exception instanceof Error ? exception.message : String(exception)}`; element('draping-status').textContent = basemapError;}}});
      layers.push(activeBasemap);
    }
    if (updateAnchor()) schedule();
    deck.setProps({layers, viewState: camera});
    const statistics = tileset.getStatistics();
    element('decoder-status').textContent = formatTerrainDecoderStatus(decoder.getStatistics(), statistics);
    status.textContent = `${deviceType === 'webgpu' ? 'WebGPU' : 'WebGL 2'} · ${drawable.length} tiles · ${triangles} triangles · data z${detailZoom}${firstPerson ? ' (local window)' : detailLimited ? ' (source/footprint limit)' : ''} · ${statistics.active} active / ${statistics.queued} queued · ${(statistics.bytes / 1000000).toFixed(1)} / ${(statistics.byteLimit / 1000000).toFixed(1)} MB cached${follow.checked ? ` · terrain ${firstPerson ? 'eye' : 'anchor'} ${anchorAvailable ? `${camera.position[2].toFixed(1)} m` : 'waiting — height held'}` : ''}${statistics.failed ? ` · ${statistics.failed} failed: ${statistics.failure?.slice(0, 200)} — retry available` : ''}`;
  }
  tileset = new TerrainTileset({
    fetch: (tile, signal) => source.fetchTile(tile, signal), minZoom: source.minZoom, maxZoom: source.maxZoom,
    decode: (bytes, tile, meshMaxError, signal) => decoder.decodeMesh(bytes, getTerrainTileBounds(tile.zoom, tile.column, tile.row), meshMaxError, signal, source.noData),
    onChange: schedule, maxResidentBytes: options.maxResidentBytes, resourceBudget
  });
  const observer = new ResizeObserver(() => {if (!disposed) {deck.setProps({width: container.clientWidth, height: container.clientHeight}); schedule();}});
  observer.observe(container);
  error.addEventListener('change', () => {updateSelection(); schedule();}, {signal: abort.signal});
  wireframe.addEventListener('change', schedule, {signal: abort.signal});
  skirts.addEventListener('change', schedule, {signal: abort.signal});
  draping.addEventListener('change', () => {basemapCredits.hidden = !draping.checked; wireframe.disabled = draping.checked; skirts.disabled = draping.checked; schedule();}, {signal: abort.signal});
  wireframe.disabled = draping.checked; skirts.disabled = draping.checked;
  detail.addEventListener('change', () => {detailZoom = undefined; updateSelection(); schedule();}, {signal: abort.signal});
  follow.addEventListener('change', () => {
    if (!follow.checked && !firstPerson) camera = {...camera, position: [camera.position[0], camera.position[1], freeAnchorHeight]};
    updateAnchor(); deck.setProps({viewState: camera}); schedule();
  }, {signal: abort.signal});
  clearance.addEventListener('change', () => {updateAnchor(); deck.setProps({viewState: camera}); schedule();}, {signal: abort.signal});
  element('land-eye').addEventListener('click', () => {
    if (!firstPerson) return;
    const coordinate = getTerrainEyeCoordinate(camera);
    const height = sampleTerrainAnchor([...geometry.values()].map(tile => tile.mesh.loaded), [coordinate[0], coordinate[1]], Number(clearance.value), displayedSurface());
    if (height === null) {selection.textContent = 'No loaded top triangle under the eye; height held'; return;}
    camera = {...camera, position: [camera.position[0], camera.position[1], height]};
    freeAnchorHeight = height; deck.setProps({viewState: camera}); schedule();
  }, {signal: abort.signal});
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
  const basemapReady = options.basemap === false ? Promise.resolve() : import('@vis.gl/tangram-layers').then(module => {
    if (!disposed) {BasemapLayer = module.TangramLayer; schedule();}
  }).catch(exception => {if (!disposed) {draping.checked = false; basemapCredits.hidden = true; selection.textContent = `Basemap unavailable: ${String(exception)}`; schedule();}});
  const ready = Promise.all([tileset.waitForIdle(), basemapReady]).then(() => {if (!disposed) updateLayers();});
  return {ready, destroy() {
    if (disposed) return;
    disposed = true; abort.abort(); cancelAnimationFrame(animationFrame); tileset?.destroy(); decoder.destroy(); geometry.clear(); observer.disconnect(); destroyCard(); deck.finalize();
    navigationGrids = []; navigationField = new TerrainHeightField([]); terrain = {grids: []}; activeBasemap = undefined; root.remove();
  }};
}
