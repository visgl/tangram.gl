// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Deck, MapView, LightingEffect, AmbientLight, DirectionalLight} from '@deck.gl/core';
import {TerrainLayer} from '@deck.gl/geo-layers';
import {webgpuAdapter} from '@luma.gl/webgpu';
import {createCollapsibleInfoCard} from '../deck/info-card.js';
import {getTerrainTileBounds, parseTerrainTile} from './load-terrain';
import {pickTerrainSurface} from './picking';
import {terrainMarkup} from './view';

/** One mounted reference owns its canvas, controls, requests and GPU resources. */
export interface TerrainExample {
  /** Resolve after the initial download and mesh preparation. */
  ready: Promise<void>;
  /** Abort outstanding work and release the instance; safe to call more than once. */
  destroy(): void;
}

/** Mount without document-global selectors or import-time browser side effects. */
export function mountTerrainExample(
  host: HTMLElement,
  options: {
    /** Initial URL settings, supplied by the host router. */
    parameters?: URLSearchParams;
    /** Let the host router persist settings without navigating out of the website. */
    onParametersChange?: (parameters: URLSearchParams) => void;
  } = {}
): TerrainExample {
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

  /** The reference deliberately loads one bounded tile, not a second tiled-terrain scheduler. */
  const tile = {zoom: 11, column: 1068, row: 728};
  const bounds = getTerrainTileBounds(tile.zoom, tile.column, tile.row);
  const status = element<HTMLParagraphElement>('status');
  const selection = element<HTMLOutputElement>('terrain-hit');
  const error = element<HTMLSelectElement>('mesh-error');
  const wireframe = element<HTMLInputElement>('wireframe');
  const container = element<HTMLDivElement>('map');
  let deviceType =
    parameters.get('device') === 'webgl'
      ? 'webgl'
      : parameters.get('device') === 'webgpu' || navigator.gpu
        ? 'webgpu'
        : 'webgl';
  const abort = new AbortController();
  const url = `https://tiles.mapterhorn.com/${tile.zoom}/${tile.column}/${tile.row}.webp`;
  let revision = 0;
  let loaded: Awaited<ReturnType<typeof parseTerrainTile>> | undefined;
  let bytes: ArrayBuffer | undefined;
  let disposed = false;

  function createDeck(): Deck<MapView> {
    return new Deck({
      parent: container,
      width: '100%',
      height: '100%',
      useDevicePixels: true,
      views: new MapView({id: 'terrain', controller: {dragRotate: true, touchRotate: true}}),
      initialViewState: {
        longitude: (bounds[0] + bounds[2]) / 2,
        latitude: (bounds[1] + bounds[3]) / 2,
        position: [0, 0, 2500],
        zoom: 11.7,
        pitch: 60,
        bearing: -25
      },
      deviceProps:
        deviceType === 'webgpu' ? {type: 'webgpu', adapters: [webgpuAdapter]} : {type: 'webgl'},
      effects: [
        new LightingEffect({
          ambient: new AmbientLight({intensity: 1}),
          sun: new DirectionalLight({direction: [-1, -2, -3], intensity: 2})
        })
      ],
      onError: (exception) => {
        if (!disposed) status.textContent = `Rendering error: ${exception.message}`;
      },
      onClick: (information) => {
        // GPU feature picking is not enabled on this mesh. Empty picking info
        // can omit its viewport; this single-view reference still has a camera.
        const viewport = information.viewport || deck.getViewports()[0];
        if (!loaded || !viewport) return;
        const hit = pickTerrainSurface(viewport, loaded.mesh, [information.x, information.y]);
        selection.textContent = hit
          ? `${hit.coordinate[0].toFixed(5)}, ${hit.coordinate[1].toFixed(5)} — ${hit.coordinate[2].toFixed(1)} m (triangle ${hit.triangleIndex})`
          : 'Outside the loaded terrain mesh';
      }
    });
  }
  let deck = createDeck();
  const observer = new ResizeObserver(() => {
    if (!disposed) deck.setProps({width: container.clientWidth, height: container.clientHeight});
  });
  observer.observe(container);

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
    } catch (exception) {
      if (!disposed && currentRevision === revision)
        status.textContent = `Terrain error: ${exception instanceof Error ? exception.message : String(exception)}`;
    }
  }

  /** TerrainLayer owns drawing; the custom fetch supplies the predecoded v5 mesh, not its v4 loader. */
  function updateLayer(): void {
    if (!loaded) return;
    const mesh = loaded.mesh;
    status.textContent = `${deviceType === 'webgpu' ? 'WebGPU' : 'WebGL 2'} · ${mesh.indices!.value.length / 3} triangles · physical heights, 1× scale`;
    deck.setProps({
      layers: [
        new TerrainLayer({
          id: `terrain-${revision}`,
          elevationData: url,
          bounds: [...bounds],
          wireframe: wireframe.checked,
          color: [145, 178, 150],
          material: {ambient: 0.3, diffuse: 0.8, shininess: 16},
          fetch: async () => mesh
        })
      ]
    });
  }

  error.addEventListener('change', updateMesh, {signal: abort.signal});
  wireframe.addEventListener('change', updateLayer, {signal: abort.signal});
  const destroyCard = createCollapsibleInfoCard(element('controls'));
  function updateDeviceTabs(): void {
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-device-type]')) {
      button.classList.toggle('is-active', button.dataset.deviceType === deviceType);
      button.setAttribute('aria-selected', String(button.dataset.deviceType === deviceType));
    }
  }
  updateDeviceTabs();
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-device-type]')) {
    button.addEventListener(
      'click',
      () => {
        const nextDevice = button.dataset.deviceType;
        if ((nextDevice !== 'webgl' && nextDevice !== 'webgpu') || nextDevice === deviceType)
          return;
        const viewState = deck.getViewports()[0];
        const camera =
          viewState &&
          'longitude' in viewState &&
          'latitude' in viewState &&
          'zoom' in viewState &&
          'pitch' in viewState &&
          'bearing' in viewState
            ? {
                longitude: Number(viewState.longitude),
                latitude: Number(viewState.latitude),
                zoom: Number(viewState.zoom),
                pitch: Number(viewState.pitch),
                bearing: Number(viewState.bearing),
                position: [0, 0, 2500]
              }
            : undefined;
        deck.finalize();
        deviceType = nextDevice;
        deck = createDeck();
        if (camera) deck.setProps({initialViewState: camera});
        updateDeviceTabs();
        updateLayer();
        parameters.set('device', deviceType);
        options.onParametersChange?.(new URLSearchParams(parameters));
      },
      {signal: abort.signal}
    );
  }
  element('fullscreen').addEventListener(
    'click',
    () => {
      const request =
        document.fullscreenElement === root ? document.exitFullscreen() : root.requestFullscreen();
      void request.catch((exception) => {
        status.textContent = `Fullscreen unavailable: ${exception.message}`;
      });
    },
    {signal: abort.signal}
  );
  async function load(): Promise<void> {
    try {
      status.textContent = 'Loading Mapterhorn elevation…';
      const response = await fetch(url, {signal: abort.signal});
      if (!response.ok) throw new Error(`Mapterhorn HTTP ${response.status}`);
      bytes = await response.arrayBuffer();
      if (!disposed) await updateMesh();
    } catch (exception) {
      if (!disposed)
        status.textContent = `Elevation unavailable: ${exception instanceof Error ? exception.message : String(exception)}`;
    }
  }
  return {
    ready: load(),
    destroy() {
      if (disposed) return;
      disposed = true;
      revision++;
      abort.abort();
      observer.disconnect();
      destroyCard();
      deck.finalize();
      root.remove();
    }
  };
}
