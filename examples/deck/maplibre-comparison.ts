// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {StyleSpecification, ErrorEvent as MapLibreErrorEvent} from 'maplibre-gl';
import {normalizeComparisonCamera, type ComparisonCamera} from './comparison-style';
import {createComparisonCameraOptions} from './comparison-camera';

/** Compare orientation without resetting navigation for whole-turn bearing differences. */
function hasEquivalentBearing(first = 0, second = 0): boolean {
  const difference = ((first - second) % 360 + 540) % 360 - 180;
  return Math.abs(difference) < 1e-9;
}

/** Finish layout before constructing the map, and cancel a pending stylesheet with its pane. */
function loadComparisonStylesheet(stylesheet: HTMLLinkElement, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stylesheet.removeEventListener('load', loaded);
      stylesheet.removeEventListener('error', failed);
      signal?.removeEventListener('abort', aborted);
    };
    const loaded = () => {cleanup(); resolve();};
    const failed = () => {cleanup(); reject(new Error('MapLibre comparison stylesheet failed to load'));};
    const aborted = () => {cleanup(); reject(signal?.reason ?? new DOMException('Comparison canceled', 'AbortError'));};
    stylesheet.addEventListener('load', loaded, {once: true});
    stylesheet.addEventListener('error', failed, {once: true});
    signal?.addEventListener('abort', aborted, {once: true});
    if (signal?.aborted) aborted();
    else document.head.append(stylesheet);
  });
}

/** Small camera boundary used by real MapLibre and deterministic test fixtures. */
export interface ComparisonMap {
  /** Subscribe to camera movement. */
  on(event: 'move', listener: () => void): unknown;
  /** Release the matching listener. */
  off(event: 'move', listener: () => void): unknown;
  /** Update the reference without starting an independent camera transition. */
  jumpTo(camera: {center: [number, number]; zoom: number; bearing: number; pitch: number}): unknown;
  /** Current geographic center. */
  getCenter(): {lng: number; lat: number};
  /** Current map zoom. */
  getZoom(): number;
  /** Current heading in degrees. */
  getBearing(): number;
  /** Current camera tilt. */
  getPitch(): number;
}

/** One logical camera with reentrancy protection; neither renderer owns the other renderer's resources. */
export function connectComparisonCamera(map: ComparisonMap, viewMode: string, initial: ComparisonCamera,
  onChange: (camera: ComparisonCamera) => void): {update(camera: ComparisonCamera): void; destroy(): void} {
  let synchronizing = false, destroyed = false;
  const readCamera = (): ComparisonCamera => {
    const center = map.getCenter();
    return {longitude: center.lng, latitude: center.lat, zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch()};
  };
  const update = (camera: ComparisonCamera) => {
    if (destroyed || synchronizing) return;
    const normalized = normalizeComparisonCamera(camera, viewMode);
    const current = readCamera();
    if (normalized.longitude === current.longitude && normalized.latitude === current.latitude && normalized.zoom === current.zoom &&
        hasEquivalentBearing(normalized.bearing, current.bearing) && normalized.pitch === current.pitch) return;
    synchronizing = true;
    try {map.jumpTo({center: [normalized.longitude, normalized.latitude], zoom: normalized.zoom,
      bearing: normalized.bearing ?? 0, pitch: normalized.pitch ?? 0});}
    finally {synchronizing = false;}
  };
  const move = () => {
    if (destroyed || synchronizing) return;
    const camera = normalizeComparisonCamera(readCamera(), viewMode);
    // Clamp either input to the same domain without feeding jumpTo's move event back into deck.
    update(camera); onChange(camera);
  };
  map.on('move', move); update(initial);
  return {update, destroy() {if (!destroyed) {destroyed = true; map.off('move', move);}}};
}

/** Optional reference pane; loaded only after the comparison control is enabled. */
export async function mountMapLibreComparison(options: {
  /** Root example canvas container, separate from the controls. */
  container: HTMLElement;
  /** Same geographic state used by deck.gl. */
  camera: ComparisonCamera;
  /** Supported deck example view. */
  viewMode: string;
  /** Reference style; production callers use the same tile provider as Tangram. */
  style: StyleSpecification;
  /** Locally bundled npm stylesheet, resolved under the site's base URL. */
  stylesheetUrl: string;
  /** Same-origin worker bundled from the matching installed npm release. */
  workerUrl: string;
  /** Cancel pending imports when the pane is disabled or the example unmounts. */
  signal?: AbortSignal;
  /** Retain pixels for snapshot/readback tools; ordinary comparison avoids that extra cost. */
  preserveDrawingBuffer?: boolean;
  /** Shared navigation callback for input on the MapLibre half. */
  onChange(camera: ComparisonCamera): void;
  /** Report reference errors independently of Tangram scene readiness. */
  onError(error: Error): void;
}) {
  options.signal?.throwIfAborted();
  const {Map: MapLibreMap, LngLat, setWorkerUrl} = await import('maplibre-gl');
  options.signal?.throwIfAborted();
  setWorkerUrl(options.workerUrl);
  const pane = document.createElement('section'); pane.className = 'maplibre-comparison-pane';
  pane.setAttribute('aria-label', 'MapLibre GL JS comparison map');
  const label = document.createElement('span'); label.className = 'comparison-map-label'; label.textContent = 'MapLibre GL JS · WebGL';
  const stylesheet = document.createElement('link'); stylesheet.rel = 'stylesheet'; stylesheet.href = options.stylesheetUrl;
  options.container.append(pane);
  let map: InstanceType<typeof MapLibreMap>;
  try {
    await loadComparisonStylesheet(stylesheet, options.signal);
    options.signal?.throwIfAborted();
    map = new MapLibreMap({container: pane, style: options.style,
      ...createComparisonCameraOptions(options.camera, options.viewMode, (longitude, latitude) => new LngLat(longitude, latitude)),
      canvasContextAttributes: {preserveDrawingBuffer: options.preserveDrawingBuffer ?? false},
      attributionControl: {compact: false}, trackResize: true});
  } catch (error) {pane.remove(); stylesheet.remove(); throw error;}
  pane.append(label);
  const camera = connectComparisonCamera(map, options.viewMode, options.camera, options.onChange);
  const error = (event: MapLibreErrorEvent) => options.onError(event.error instanceof Error ? event.error : new Error(event.error.message));
  map.on('error', error);
  // MapLibre observes its container and releases that observer in remove(). A
  // second synchronous observer can trigger resize-observer notification loops.
  let destroyed = false;
  return {
    /** Keep the reference camera aligned when deck input drives the shared state. */
    updateCamera: camera.update,
    /** Switch reference data without recreating the map or its input handlers. */
    setStyle(style: StyleSpecification) {if (!destroyed) map.setStyle(style);},
    /** Release listeners, workers, WebGL context, DOM and example-owned stylesheet once. */
    destroy() {
      if (destroyed) return; destroyed = true;
      camera.destroy(); map.off('error', error); map.remove(); pane.remove(); stylesheet.remove();
    }
  };
}
