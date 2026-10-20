// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {readFileSync} from 'node:fs';
import {expect, test, vi} from 'vitest';
import {createExpression, validateStyleMin} from '@maplibre/maplibre-gl-style-spec';
import {STREETS_COLORS, STREETS_MAJOR_ROAD_CLASSES, createStreetsRoadWidths} from '../examples/deck/streets-cartography';
import {createComparisonStyle, getComparisonLimitation, normalizeComparisonCamera} from '../examples/deck/comparison-style';
import {connectComparisonCamera, mountMapLibreComparison, type ComparisonMap} from '../examples/deck/maplibre-comparison';
import {BLUE_MARBLE_URL} from '../examples/classic/app/nasa-basemap.js';
import {readComparisonPreference, writeComparisonPreference} from '../examples/deck/comparison-settings';

test.each(['mapFlat', 'mapPerspective', 'globe'])('%s Streets reference preserves the intended flat cartography', viewMode => {
  const style = createComparisonStyle('streetsVector', viewMode);
  expect(validateStyleMin(style)).toEqual([]);
  expect(style.layers.find(layer => layer.id === 'water')?.paint).toEqual({'fill-color': STREETS_COLORS.water});
  expect(style.layers.find(layer => layer.id === 'waterways')?.paint).toEqual({'line-color': STREETS_COLORS.waterway, 'line-width': 1});
  expect(style.layers.find(layer => layer.id === 'buildings')).toMatchObject({type: 'fill', minzoom: 13,
    paint: {'fill-color': STREETS_COLORS.building}});
  expect(style.layers.map(layer => layer.type)).not.toContain('fill-extrusion');
  expect(style.layers.map(layer => layer.id).slice(-4)).toEqual(['roads-outline', 'roads', 'major-roads-outline', 'major-roads']);
});

test.each([false, true])('road widths preserve Tangram stop values and two-sided casings; major=%s', major => {
  const layers = createComparisonStyle('streetsVector', 'mapPerspective').layers;
  for (const outline of [false, true]) {
    const layer = layers.find(candidate => candidate.id === `${major ? 'major-roads' : 'roads'}${outline ? '-outline' : ''}`);
    if (layer?.type !== 'line') throw new Error('Missing road reference');
    const expression = createExpression(layer.paint?.['line-width'], 'layers.roads.paint.line-width');
    if (expression.result !== 'success') throw new Error(JSON.stringify(expression.value));
    for (const [zoom, pixels] of createStreetsRoadWidths(major)) {
      expect(expression.value.evaluate({zoom: zoom - 1}, null)).toBe(Number.parseFloat(pixels) + (outline ? 2 : 0));
    }
    expect(layer.filter).toEqual(major
      ? ['in', ['get', 'class'], ['literal', [...STREETS_MAJOR_ROAD_CLASSES]]]
      : ['!', ['in', ['get', 'class'], ['literal', [...STREETS_MAJOR_ROAD_CLASSES]]]]);
  }
  const stops = createStreetsRoadWidths(major); stops[0][1] = '999px';
  expect(createStreetsRoadWidths(major)[0][1]).not.toBe('999px');
});

test('static reference improvements leave TRON shader/extrusion semantics independent', () => {
  const style = createComparisonStyle('tron', 'globe');
  expect(validateStyleMin(style)).toEqual([]);
  expect(style.layers.find(layer => layer.id === 'buildings')?.type).toBe('fill-extrusion');
  const runtime = readFileSync(new URL('../examples/deck/app-runtime.js', import.meta.url), 'utf8');
  expect(runtime).toContain("style: portable ? 'lines' : 'roads-glow'");
  expect(runtime).toContain("style: portable ? 'tron-portable-traffic' : 'fast-traffic-animation-twoways'");
  expect(runtime).toContain("style: portable ? 'polygons' : 'water-later'");
});

test.each(['mapFlat', 'mapPerspective', 'globe'])('%s offers same-provider references, not unsupported Nextzen shaders', viewMode => {
  for (const basemap of ['streetsVector', 'tron', 'blueMarbleRaster']) {
    expect(getComparisonLimitation(viewMode, basemap)).toBeNull();
    const style = createComparisonStyle(basemap, viewMode);
    expect(style.projection).toEqual({type: viewMode === 'globe' ? 'vertical-perspective' : 'mercator'});
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
  expect(runtime).toContain('comparisonRequested = readComparisonPreference(searchParams);');
  expect(runtime).toContain('writeComparisonPreference(comparisonRequested);');
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

test('comparison starts off and remembers an explicit choice across examples and reloads', () => {
  const values = new Map<string, string>();
  const storage = {getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => {values.set(key, value);}};
  expect(readComparisonPreference(new URLSearchParams(), storage)).toBe(false);
  writeComparisonPreference(true, storage);
  expect(readComparisonPreference(new URLSearchParams(), storage)).toBe(true);
  writeComparisonPreference(false, storage);
  expect(readComparisonPreference(new URLSearchParams(), storage)).toBe(false);
});

test('explicit comparison bookmarks override the saved setting only for that page', () => {
  const storage = {getItem: vi.fn(() => 'true'), setItem: vi.fn()};
  expect(readComparisonPreference(new URLSearchParams('compare=none'), storage)).toBe(false);
  expect(readComparisonPreference(new URLSearchParams('compare=maplibre'), storage)).toBe(true);
  expect(storage.getItem).not.toHaveBeenCalled();
  expect(storage.setItem).not.toHaveBeenCalled();
});

test('denied storage does not break the current-page comparison control', () => {
  const storage = {getItem: () => {throw new Error('Storage denied');}, setItem: () => {throw new Error('Storage denied');}};
  expect(readComparisonPreference(new URLSearchParams(), storage)).toBe(false);
  expect(readComparisonPreference(new URLSearchParams('compare=maplibre'), storage)).toBe(true);
  expect(() => writeComparisonPreference(true, storage)).not.toThrow();
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
