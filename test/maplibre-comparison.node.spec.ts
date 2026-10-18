// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {readFileSync} from 'node:fs';
import {expect, test, vi} from 'vitest';
import {createComparisonStyle, getComparisonLimitation, normalizeComparisonCamera} from '../examples/deck/comparison-style';
import {connectComparisonCamera, mountMapLibreComparison, type ComparisonMap} from '../examples/deck/maplibre-comparison';
import {BLUE_MARBLE_URL} from '../examples/classic/app/nasa-basemap.js';

test.each(['mapFlat', 'mapPerspective', 'globe'])('%s offers same-provider references, not unsupported Nextzen shaders', viewMode => {
  for (const basemap of ['streetsVector', 'tron', 'blueMarbleRaster']) {
    expect(getComparisonLimitation(viewMode, basemap)).toBeNull();
    const style = createComparisonStyle(basemap, viewMode);
    expect(style.projection).toEqual({type: viewMode === 'globe' ? 'globe' : 'mercator'});
    expect(style.sources.basemap).toMatchObject(basemap === 'blueMarbleRaster' ? {tiles: [BLUE_MARBLE_URL], maxzoom: 8} : {url: 'https://tiles.openfreemap.org/planet', maxzoom: 14});
    expect(style.sources.basemap).toHaveProperty('attribution');
  }
  expect(getComparisonLimitation(viewMode, 'tronNextzen')).toMatch(/Nextzen/);
});

test('unsupported modes reject instead of silently comparing a different camera', () => {
  for (const mode of ['firstPerson', 'projected', 'webxr', 'terrain', 'unknown']) {
    expect(getComparisonLimitation(mode, 'tron')).toMatch(/MapView/);
    expect(() => createComparisonStyle('tron', mode)).toThrow(/Unsupported/);
  }
  expect(createComparisonStyle('streetsVector', 'mapPerspective', 'carto').sources.basemap).toMatchObject({
    tiles: ['https://tiles-a.basemaps.cartocdn.com/vectortiles/carto.streets/v1/{z}/{x}/{y}.mvt']
  });
  const first = createComparisonStyle('tron', 'globe'), second = createComparisonStyle('tron', 'globe');
  expect(first.sources).not.toBe(second.sources);
});

test.each(['mapFlat', 'mapPerspective', 'globe'])('%s shares one camera without jumpTo feedback or teardown leaks', viewMode => {
  const listeners = new Set<() => void>();
  let center = {lng: 20, lat: 30}, zoom = 6, pitch = 25;
  const map: ComparisonMap = {
    on: (_event, listener) => listeners.add(listener), off: (_event, listener) => listeners.delete(listener),
    getCenter: () => center, getZoom: () => zoom, getPitch: () => pitch, getBearing: () => 12,
    jumpTo: vi.fn((camera: Parameters<ComparisonMap['jumpTo']>[0]) => {
      center = {lng: camera.center[0], lat: camera.center[1]}; zoom = camera.zoom; pitch = camera.pitch;
      for (const listener of listeners) listener();
    })
  };
  const change = vi.fn();
  const camera = connectComparisonCamera(map, viewMode, {longitude: 1, latitude: 2, zoom: 3}, change);
  expect(change).not.toHaveBeenCalled();
  camera.update({longitude: 10, latitude: 90, zoom: 30, pitch: 80});
  expect(change).not.toHaveBeenCalled();
  expect(zoom).toBe(20); expect(center.lat).toBeCloseTo(85.0511287798);
  center = {lng: 179, lat: 45}; zoom = 7; pitch = 20;
  vi.mocked(map.jumpTo).mockClear();
  for (const listener of listeners) listener();
  // A normal native move must not jumpTo itself and interrupt drag/zoom inertia.
  expect(map.jumpTo).toHaveBeenCalledTimes(viewMode === 'mapPerspective' ? 0 : 1);
  expect(change).toHaveBeenCalledTimes(1);
  expect(change).toHaveBeenLastCalledWith({longitude: 179, latitude: 45, zoom: 7, bearing: 12, pitch: viewMode === 'mapPerspective' ? 20 : 0});
  camera.destroy(); camera.destroy(); camera.update({longitude: 0, latitude: 0, zoom: 0});
  expect(listeners.size).toBe(0); expect(change).toHaveBeenCalledTimes(1);
});

test('camera defaults preserve wrapping and normalize only the shared supported domain', () => {
  expect(normalizeComparisonCamera({longitude: 370, latitude: -90, zoom: -2}, 'mapFlat')).toMatchObject({longitude: 370, latitude: -85.0511287798, zoom: 0, pitch: 0, bearing: 0});
});

test('an already canceled comparison never imports MapLibre or touches browser resources', async () => {
  const request = new AbortController(); request.abort();
  // The canceled path needs no browser DOM, proving cancellation precedes allocation.
  await expect(mountMapLibreComparison({get container(): HTMLElement {throw new Error('Must not acquire DOM for canceled work');}, camera: {longitude: 0, latitude: 0, zoom: 0},
    viewMode: 'globe', style: {version: 8, sources: {}, layers: []}, stylesheetUrl: '', workerUrl: '', signal: request.signal,
    onChange: vi.fn(), onError: vi.fn()})).rejects.toThrow(/abort/i);
});

test('MapLibre is example-only and dynamically imported, with local bundled styles', () => {
  for (const module of ['tangram-renderer', 'tangram-layers']) {
    const manifest = JSON.parse(readFileSync(new URL(`../modules/${module}/package.json`, import.meta.url), 'utf8'));
    expect(JSON.stringify(manifest)).not.toContain('maplibre');
  }
  const runtime = readFileSync(new URL('../examples/deck/app-runtime.js', import.meta.url), 'utf8');
  expect(runtime).toContain("import('./maplibre-comparison.ts')");
  expect(runtime).not.toMatch(/from ['"]maplibre/);
  expect(runtime).toContain("searchParams.get('compare') === 'maplibre'");
  expect(runtime).toContain('if (comparisonInput) comparisonInput.checked = false;');
  for (const entry of ['../examples/deck/index.html', '../website/src/components/DeckExample.js']) {
    const markup = readFileSync(new URL(entry, import.meta.url), 'utf8');
    expect(markup).toMatch(/<input id="maplibre-comparison" type="checkbox"\s*\/?\s*>/);
    expect(markup).not.toMatch(/id="maplibre-comparison"[^>]*(?:checked|defaultChecked)/);
  }
  const build = readFileSync(new URL('../scripts/build-examples.mjs', import.meta.url), 'utf8');
  expect(build).toContain("deckRequire.resolve('maplibre-gl/dist/maplibre-gl.css')");
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  expect(manifest.scripts['test-rendering:run']).toMatch(/^yarn build:examples && vitest/);
});

test('canceling during module loading cannot allocate a late reference pane', async () => {
  let release: () => void = () => {}, started: () => void = () => {};
  const waiting = new Promise<void>(resolve => {release = resolve;});
  const loading = new Promise<void>(resolve => {started = resolve;});
  const createMap = vi.fn();
  const setWorkerUrl = vi.fn();
  vi.doMock('maplibre-gl', async () => {started(); await waiting; return {Map: createMap, setWorkerUrl};});
  const request = new AbortController();
  try {
    const mounting = mountMapLibreComparison({get container(): HTMLElement {throw new Error('Late DOM allocation');},
      camera: {longitude: 0, latitude: 0, zoom: 0}, viewMode: 'globe', style: {version: 8, sources: {}, layers: []},
      stylesheetUrl: '', workerUrl: '', signal: request.signal, onChange: vi.fn(), onError: vi.fn()});
    await loading; request.abort(); release();
    await expect(mounting).rejects.toThrow(/abort/i);
    expect(createMap).not.toHaveBeenCalled();
    expect(setWorkerUrl).not.toHaveBeenCalled();
  } finally {release(); vi.doUnmock('maplibre-gl');}
});
