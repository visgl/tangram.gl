// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, beforeEach, expect, test} from 'vitest';
import {commands} from 'vitest/browser';
import {Deck, OrthographicView, type Layer, type LayerProps} from '@deck.gl/core';
import {ProjectedBasemapLayer, createProjectedBasemapScene, ProjectedBasemapNavigation,
  selectProjectedTileDetail} from '@vis.gl/tangram-layers/experimental/projected-basemaps';
import {RenderingHarness, coloredPixels, readCanvasPixels, DEVICE_TYPE} from './harness';
import {createRasterScene} from './scene';
import type Scene from '../../modules/tangram-renderer/src/scene/scene';
import type {HostTileResourceOptions, ProjectedBasemapOptions, Renderer} from '@vis.gl/tangram-renderer/core';
import type {ProjectionEngine} from '@math.gl/projection/types';
import {createProjectedExampleProjectionEngine} from '../../examples/projected/projection-engine.js';

let harness: RenderingHarness | undefined;
let deck: Deck<OrthographicView> | undefined;
/** Dynamic layer factories do not yet emit a public subclass declaration. */
type FixtureProperties = {scene: Record<string, unknown>; projectedTileZoom: number; onSceneError: (error: Error) => void;
  projectionEngine?: ProjectionEngine;
  projectedVisibleBounds?: readonly [number, number, number, number];
  projectedStyleZoom?: number; projectedMaxTiles?: number; tileResources?: HostTileResourceOptions;
  projectedProjection?: ProjectedBasemapOptions; onProjectionChange?: () => void; onSceneLoad?: (scene: Scene) => void};
const FixtureLayer = ProjectedBasemapLayer as unknown as new (properties: FixtureProperties & LayerProps) => Layer;

/** Offline continental polygon, including tile boundaries and a hole in the projected surface. */
function createPolygonScene() {
  const fixture = {type: 'FeatureCollection', features: [{type: 'Feature', properties: {}, geometry: {
    type: 'Polygon', coordinates: [
      [[-140, 15], [-60, 15], [-60, 60], [-140, 60], [-140, 15]],
      [[-110, 30], [-110, 45], [-90, 45], [-90, 30], [-110, 30]]
    ]
  }}]};
  return {scene: {background: {color: '#000000'}}, sources: {fixture: {type: 'GeoJSON',
    url: `data:application/json,${encodeURIComponent(JSON.stringify(fixture))}`, max_zoom: 6}},
  layers: {ground: {data: {source: 'fixture'}, draw: {polygons: {order: 0, color: '#20d0b0'}}}}};
}

/** Offline bent roads cross source-tile boundaries and exercise all standard caps and joins. */
function createRoadScene(maximumSourceZoom = 6) {
  const features = ['round', 'square', 'butt'].map((cap, index) => ({type: 'Feature', properties: {cap}, geometry: {
    type: 'LineString', coordinates: [[-150, 20 + index * 12], [-95, 35 + index * 8], [-50, 20 + index * 12]]
  }}));
  return {scene: {background: {color: '#000000'}}, sources: {roads: {type: 'GeoJSON',
    url: `data:application/json,${encodeURIComponent(JSON.stringify({type: 'FeatureCollection', features}))}`,
    max_zoom: maximumSourceZoom}}, layers: Object.fromEntries(['round', 'square', 'butt'].map((cap, index) => [cap, {
      data: {source: 'roads'}, filter: {cap}, draw: {lines: {order: 3 + index, width: '180000m',
        color: ['#ff2020', '#20ff20', '#ff8020'][index], cap, join: ['round', 'bevel', 'miter'][index]}}
    }]))};
}

beforeEach(() => commands.startRenderingDiagnostics());

test.each(['equal-earth', 'albers', 'equirectangular', 'mercator', 'web-mercator'] as const)(
  `${DEVICE_TYPE}: projected %s annotations retain pixel size and render attached/standalone atlas text`, async type => {
    harness = new RenderingHarness();
    await harness.initializeDevice();
    const engine = createProjectedExampleProjectionEngine();
    const navigation = new ProjectedBasemapNavigation(engine);
    const target = await navigation.projectPosition([-100, 40], type);
    const source = {type: 'FeatureCollection', features: [{type: 'Feature', properties: {name: 'Ground label'},
      geometry: {type: 'Point', coordinates: [-100, 40]}}]};
    const scene = createProjectedBasemapScene({scene: {background: {color: '#000'}},
      styles: {markers: {base: 'points', draw: {collide: false, text: {collide: false}}}},
      sources: {annotations: {type: 'GeoJSON',
        url: `data:application/json,${encodeURIComponent(JSON.stringify(source))}`}},
      layers: {annotations: {data: {source: 'annotations'}, draw: {
        markers: {order: 10, size: '20px', color: '#00ff00',
          text: {text_source: 'name', anchor: 'top', offset: [0, -20],
            font: {family: 'sans-serif', size: '18px', fill: '#ffffff'}}},
        text: {order: 11, text_source: 'name', collide: false, offset: [0, 25],
          font: {family: 'sans-serif', size: '18px', fill: '#ff0000'}}
      }}}}, {type, cacheProjectedMeshes: true},
    new URL('/modules/tangram-renderer/dist/projected-basemaps-worker.js', location.href).href);
    const errors = harness.errors, canvas = harness.canvas;
    deck = new Deck({canvas, device: harness.device, width: 512, height: 320,
      useDevicePixels: false, views: new OrthographicView({id: 'projected', flipY: false}),
      viewState: {target, zoom: 1}, _animate: true, onError: error => errors.push(error.message),
      layers: [new FixtureLayer({id: 'annotations', scene, projectionEngine: engine,
        projectedTileZoom: 2, projectedStyleZoom: 6, projectedVisibleBounds: [-130, 20, -70, 60],
        onSceneError: error => errors.push(error.message)})]});
    const counts = async () => {
      expect(errors).toEqual([]);
      const pixels = (await readCanvasPixels(canvas)).data;
      const result = {green: 0, white: 0, red: 0};
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const red = pixels[offset], green = pixels[offset + 1], blue = pixels[offset + 2];
        if (green > 80 && red < 40 && blue < 40) result.green++;
        if (red > 80 && green > 80 && blue > 80) result.white++;
        if (red > 80 && green < 40 && blue < 40) result.red++;
      }
      return result;
    };
    await expect.poll(async () => (await counts()).green, {timeout: 20000}).toBeGreaterThan(150);
    await expect.poll(async () => (await counts()).white, {timeout: 20000}).toBeGreaterThan(100);
    await expect.poll(async () => (await counts()).red, {timeout: 20000}).toBeGreaterThan(100);
    const before = await counts();
    deck.setProps({viewState: {target, zoom: 3}});
    await expect.poll(async () => Math.abs((await counts()).green - before.green)).toBeLessThan(40);
    expect(errors).toEqual([]);
  });

test(`${DEVICE_TYPE}: projected pixel roads keep CSS width across zoom, with outlines, dashes and animated traffic`, async () => {
  harness = new RenderingHarness();
  await harness.initializeDevice();
  const errors = harness.errors, canvas = harness.canvas;
  const source = {type: 'FeatureCollection', features: [{type: 'Feature', properties: {}, geometry: {
    type: 'LineString', coordinates: [[-125, 40], [-75, 40]]}}]};
  const engine = createProjectedExampleProjectionEngine();
  const navigation = new ProjectedBasemapNavigation(engine);
  const target = await navigation.projectPosition([-100, 40], 'equal-earth');
  let sceneLoads = 0;
  let loadedScene: Scene | undefined;
  const createScene = (animated: boolean, dashed: boolean) => createProjectedBasemapScene({
    scene: {background: {color: '#000000'}}, styles: {traffic: {base: 'lines', animated}},
    sources: {roads: {type: 'GeoJSON', url: `data:application/json,${encodeURIComponent(JSON.stringify(source))}`, max_zoom: 6}},
    layers: {roads: {data: {source: 'roads'}, draw: {traffic: {width: [[4, '6px'], [6, '12px'], [8, '18px']],
      offset: [[4, '1px'], [6, '2px']], color: '#20d0b0',
      order: 2, outline: {width: [[4, '1px'], [6, '2px']] , color: '#f08020'}, ...(dashed ? {dash: [3, 2]} : {})}}}}
  }, {type: 'equal-earth', maxProjectedError: 0.5},
  new URL('/modules/tangram-renderer/dist/projected-basemaps-worker.js', location.href).href);
  const layer = (scene: Record<string, unknown>) => new FixtureLayer({id: 'pixel-roads', scene, projectionEngine: engine,
    projectedTileZoom: 4, projectedStyleZoom: 6, projectedVisibleBounds: [-130, 30, -70, 50],
    onSceneLoad: value => {loadedScene = value; sceneLoads++;},
    onSceneError: error => errors.push(error.message)});
  deck = new Deck({canvas, device: harness.device, width: 512, height: 320, useDevicePixels: false,
    views: new OrthographicView({id: 'projected', flipY: false}), viewState: {target, zoom: 1},
    onError: error => errors.push(error.message), _animate: true, layers: [layer(createScene(false, false))]});
  const thickness = async () => {
    const pixels = (await readCanvasPixels(canvas)).data;
    let count = 0;
    for (let row = 0; row < 320; row++) {
      const offset = (row * 512 + 256) * 4;
      if (pixels[offset] + pixels[offset + 1] + pixels[offset + 2] > 100) count++;
    }
    return count;
  };
  await expect.poll(thickness, {timeout: 20000}).toBeGreaterThan(8);
  const before = await thickness();
  expect(before).toBeLessThanOrEqual(20);
  deck.setProps({viewState: {target, zoom: 3}});
  await expect.poll(thickness).toBeGreaterThan(8);
  expect(Math.abs(await thickness() - before)).toBeLessThanOrEqual(2);
  const greenPixels = async () => {
    const pixels = (await readCanvasPixels(canvas)).data;
    let count = 0;
    for (let index = 0; index < pixels.length; index += 4) if (pixels[index + 1] > 80 && pixels[index + 1] > pixels[index] * 1.5) count++;
    return count;
  };
  const solidPixels = await greenPixels();
  expect(solidPixels).toBeGreaterThan(500);
  deck.setProps({layers: [layer(createScene(false, true))]});
  await expect.poll(() => sceneLoads, {timeout: 20000}).toBe(2);
  // Static gaps must remove substantial road area; animation alone cannot satisfy this.
  await expect.poll(async () => {
    const count = await greenPixels();
    return count > solidPixels * 0.1 && count < solidPixels * 0.8;
  }, {timeout: 20000, message: 'Static dashes must render visible strokes and gaps, not a loading frame'}).toBe(true);
  deck.setProps({layers: [layer(createScene(true, true))]});
  await expect.poll(() => sceneLoads, {timeout: 20000}).toBe(3);
  await expect.poll(async () => coloredPixels(await readCanvasPixels(canvas)), {timeout: 20000}).toBeGreaterThan(100);
  await expect.poll(() => {
    const resources = loadedScene?.tile_manager.getResourceStatistics();
    return resources ? resources.activeBuilds + resources.queuedBuilds : -1;
  }, {timeout: 20000}).toBe(0);
  // Capture only after the animated scene has loaded and finished building;
  // replacing the static scene must not count as shader animation.
  const previous = (await readCanvasPixels(canvas)).data;
  await expect.poll(async () => {
    const current = (await readCanvasPixels(canvas)).data;
    let changed = 0;
    for (let index = 0; index < current.length; index++) if (current[index] !== previous[index]) changed++;
    return changed;
  }, {timeout: 10000}).toBeGreaterThan(20);
  expect(errors).toEqual([]);
  navigation.dispose();
});
afterEach(async () => {
  try {
    expect(harness?.errors || []).toEqual([]);
    expect(await commands.renderingDiagnostics()).toEqual([]);
  } finally {
    try {
      if (harness) await commands.saveRenderingArtifact(expect.getState().currentTestName || 'projected',
        harness.canvas.toDataURL('image/png'));
    } finally {
      deck?.finalize();
      deck = undefined;
      harness?.destroy();
      harness = undefined;
    }
  }
});

test.each(['equal-earth', 'albers'] as const)(`${DEVICE_TYPE}: %s fit, inverse probe and camera detail keep one warm scene`, async type => {
  harness = new RenderingHarness();
  await harness.initializeDevice();
  const errors = harness.errors;
  const canvas = harness.canvas;
  const projectionEngine = createProjectedExampleProjectionEngine();
  const navigation = new ProjectedBasemapNavigation(projectionEngine);
  const bounds = [-170, 5, -40, 75] as const;
  const fitted = await navigation.fitBounds(bounds, {width: 512, height: 320}, type);
  const scene = createProjectedBasemapScene(createPolygonScene(), {type},
    new URL('/modules/tangram-renderer/dist/projected-basemaps-worker.js', location.href).href);
  let loadedScene: Scene | undefined;
  let loads = 0;
  const createLayer = (detail: number, visibleBounds: readonly [number, number, number, number] = bounds, visible = true) => new FixtureLayer({id: 'navigate-projected-fixture', scene, projectionEngine,
    projectedTileZoom: detail, projectedStyleZoom: 6, projectedMaxTiles: 256, projectedVisibleBounds: visibleBounds, visible,
    onSceneLoad: value => {loadedScene = value; loads++;}, onSceneError: error => errors.push(error.message)});
  deck = new Deck({canvas, device: harness.device, width: 512, height: 320, useDevicePixels: false,
    views: new OrthographicView({id: 'projected', flipY: false, controller: true}), viewState: fitted,
    onError: error => {errors.push(error.message);}, _animate: true, layers: [createLayer(1)]});
  try {
    const waitForGround = async () => expect.poll(async () => {
      expect(errors).toEqual([]);
      return coloredPixels(await readCanvasPixels(canvas));
    }, {timeout: 20000}).toBeGreaterThan(500);
    await waitForGround();
    if (!loadedScene) throw new Error('Projected scene did not load');
    const initialScene = loadedScene;
    const workers = Reflect.get(initialScene, 'workers');
    const viewport = deck.getViewports()[0];
    const focus = await navigation.projectPosition([-125, 35], type);
    const screen = viewport.project(focus);
    const geographic = await navigation.unprojectScreenPosition(viewport, [screen[0], screen[1]], type);
    expect(geographic?.[0]).toBeCloseTo(-125, 6);
    expect(geographic?.[1]).toBeCloseTo(35, 6);
    const options = {visibleBounds: bounds, minZoom: 1, maxZoom: 3, maxTiles: 256, targetTilePixels: 512};
    const coarse = await selectProjectedTileDetail(navigation, viewport, type, options);
    deck.setProps({viewState: {target: focus, zoom: fitted.zoom + 2}});
    await expect.poll(() => deck?.getViewports()[0].zoom).toBeCloseTo(fitted.zoom + 2);
    const fine = await selectProjectedTileDetail(navigation, deck.getViewports()[0], type, options);
    expect(fine.tileZoom).toBeGreaterThan(coarse.tileZoom);
    expect(fine.candidateCount).toBeLessThanOrEqual(256);
    const coverage = await navigation.getCameraCoverage(deck.getViewports()[0], type, bounds);
    if (!coverage.bounds) throw new Error('Expected visible projected coverage');
    expect(coverage.domainFallback).toBe(false);
    expect(coverage.bounds[2] - coverage.bounds[0]).toBeLessThan(bounds[2] - bounds[0]);
    deck.setProps({layers: [createLayer(fine.tileZoom, coverage.bounds)]});
    await waitForGround();
    // Off-domain cameras hide the layer without destroying its warm renderer and workers.
    deck.setProps({layers: [createLayer(fine.tileZoom, coverage.bounds, false)]});
    await expect.poll(async () => coloredPixels(await readCanvasPixels(canvas))).toBe(0);
    deck.setProps({viewState: fitted, layers: [createLayer(1)]});
    await waitForGround();
    expect(loadedScene).toBe(initialScene);
    expect(Reflect.get(initialScene, 'workers')).toBe(workers);
    expect(loads).toBe(1);
  } finally {
    navigation.dispose();
  }
});

test.each(['equal-earth', 'albers', 'equirectangular', 'mercator', 'web-mercator'] as const)(
  `${DEVICE_TYPE}: projected %s polygons and raster use the packaged worker and OrthographicView`, async type => {
    harness = new RenderingHarness();
    await harness.initializeDevice();
    const errors = harness.errors;
    const canvas = harness.canvas;
    const workerUrl = new URL('/modules/tangram-renderer/dist/projected-basemaps-worker.js', location.href).href;
    const createLayer = (raster: boolean) => new FixtureLayer({id: 'projected-fixture', projectedTileZoom: 2,
      scene: createProjectedBasemapScene(raster ? createRasterScene() : createPolygonScene(), {type, maxProjectedError: 2}, workerUrl),
      onSceneError: error => errors.push(error.message)});
    deck = new Deck({canvas, device: harness.device, width: 512, height: 320, useDevicePixels: false,
      views: new OrthographicView({id: 'projected', flipY: false}),
      initialViewState: {target: [0, 0, 0], zoom: type === 'albers' ? -1 : -2},
      onError: error => {errors.push(error.message);}, _animate: true, layers: [createLayer(false)]});
    await expect.poll(async () => {
      expect(errors).toEqual([]);
      return coloredPixels(await readCanvasPixels(canvas));
    }, {timeout: 20000, interval: 100}).toBeGreaterThan(500);
    deck.setProps({layers: [createLayer(true)]});
    await expect.poll(async () => {
      expect(errors).toEqual([]);
      const image = await readCanvasPixels(canvas);
      let orange = 0;
      for (let offset = 0; offset < image.data.length; offset += 4) {
        if (image.data[offset] > 140 && image.data[offset + 1] < 160 && image.data[offset + 2] < 100) orange++;
      }
      return orange;
    }, {timeout: 20000, interval: 100}).toBeGreaterThan(500);
  }
);

test.each([
  {raster: false, injected: false, cached: false}, {raster: true, injected: false, cached: false},
  {raster: false, injected: true, cached: false}, {raster: true, injected: true, cached: false},
  {raster: false, injected: false, cached: true}, {raster: true, injected: true, cached: true}
])(`${DEVICE_TYPE}: projection switches retain tiles/workers (raster=$raster, injected=$injected, cached=$cached)`, async ({raster, injected, cached}) => {
  harness = new RenderingHarness();
  await harness.initializeDevice();
  const errors = harness.errors;
  const canvas = harness.canvas;
  const scene = createProjectedBasemapScene(raster ? createRasterScene() : createPolygonScene(), {type: 'equal-earth', cacheProjectedMeshes: cached},
    new URL('/modules/tangram-renderer/dist/projected-basemaps-worker.js', location.href).href);
  let loadedScene: Scene | undefined;
  let completedProjection = '';
  let loadCount = 0;
  const engine = createProjectedExampleProjectionEngine();
  const compiledTypes: unknown[] = [];
  const projectionEngine: ProjectionEngine | undefined = injected ? {
    createProjection: options => engine.createProjection(options),
    createProjectionAsync: options => {compiledTypes.push(options); return engine.createProjectionAsync(options);}
  } : undefined;
  const createLayer = (type: ProjectedBasemapOptions['type']) => new FixtureLayer({id: 'warm-projected-fixture',
    scene, projectedTileZoom: 2, projectedProjection: {type, cacheProjectedMeshes: cached}, projectionEngine,
    onSceneLoad: value => {loadedScene = value; loadCount++;},
    onProjectionChange: () => {completedProjection = type;}, onSceneError: error => errors.push(error.message)});
  deck = new Deck({canvas, device: harness.device, width: 512, height: 320, useDevicePixels: false,
    views: new OrthographicView({id: 'projected', flipY: false}),
    initialViewState: {target: [0, 0, 0], zoom: -2},
    onError: error => {errors.push(error.message);}, _animate: true, layers: [createLayer('equal-earth')]});
  await expect.poll(async () => {
    expect(errors).toEqual([]);
    return coloredPixels(await readCanvasPixels(canvas));
  }, {timeout: 20000, interval: 100}).toBeGreaterThan(500);
  await expect.poll(() => completedProjection).toBe('equal-earth');
  if (injected) expect(compiledTypes).toHaveLength(1);
  if (!loadedScene) throw new Error('Expected a loaded projected scene');
  const initialScene = loadedScene;
  const workers = Reflect.get(initialScene, 'workers');
  await expect.poll(async () => (await initialScene.getTileSourceStatistics())
    .reduce((count, value) => count + value.loadingTiles + value.queuedTiles, 0), {timeout: 20000}).toBe(0);
  const statistics = await initialScene.getTileSourceStatistics();
  // Eight raster tiles per worker across five projections exceed the 32-entry LRU.
  // Check a short warm round trip before intentionally exercising eviction.
  const sequence = cached
    ? ['albers', 'equal-earth', 'mercator', 'web-mercator', 'equirectangular', 'equal-earth'] as const
    : ['albers', 'mercator', 'web-mercator', 'equirectangular', 'equal-earth'] as const;
  for (const type of sequence) {
    deck.setProps({layers: [createLayer(type)]});
    await expect.poll(() => completedProjection, {timeout: 20000}).toBe(type);
    await expect.poll(async () => {
      expect(errors).toEqual([]);
      return coloredPixels(await readCanvasPixels(canvas));
    }, {timeout: 20000, interval: 100}).toBeGreaterThan(500);
    expect(loadedScene).toBe(initialScene);
    expect(loadCount).toBe(1);
    expect(Reflect.get(initialScene, 'workers')).toBe(workers);
    expect((await initialScene.getTileSourceStatistics()).map(value => value.acquisitions))
      .toEqual(statistics.map(value => value.acquisitions));
    const preparation = (await initialScene.getTileSourceStatistics()).map(value => value.projectionPreparation);
    expect(preparation.every(value => value && value.entries <= 64 && value.bytes <= 16 * 1024 * 1024)).toBe(true);
    if (cached) expect(preparation.every(value => !value?.projectedResults ||
      (value.projectedResults.entries <= 32 && value.projectedResults.bytes <= 16 * 1024 * 1024))).toBe(true);
  }
  const finalStatistics = await initialScene.getTileSourceStatistics();
  expect(finalStatistics.every(value => value.projectionWork !== undefined && value.projectionWork.failedMeshes === 0)).toBe(true);
  expect(finalStatistics.reduce((count, value) => count + (value.projectionWork?.completedMeshes ?? 0), 0))
    .toBeGreaterThan(statistics.reduce((count, value) => count + (value.projectionWork?.completedMeshes ?? 0), 0));
  expect(finalStatistics.reduce((hits, value) => hits + (value.projectionPreparation?.hits ?? 0), 0))
    .toBeGreaterThan(statistics.reduce((hits, value) => hits + (value.projectionPreparation?.hits ?? 0), 0));
  if (injected) expect(compiledTypes).toHaveLength(5);
  if (cached) expect(finalStatistics.reduce((hits, value) => hits + (value.projectionPreparation?.projectedResults?.hits ?? 0), 0),
    JSON.stringify(finalStatistics.map(value => value.projectionPreparation))).toBeGreaterThan(0);
});

test.each([false, true])(`${DEVICE_TYPE}: source detail round trips retain style zoom, workers and warm tile meshes (injected %s)`, async injected => {
  harness = new RenderingHarness();
  await harness.initializeDevice();
  const errors = harness.errors;
  const canvas = harness.canvas;
  const scene = createProjectedBasemapScene(createPolygonScene(), {type: 'equal-earth'},
    new URL('/modules/tangram-renderer/dist/projected-basemaps-worker.js', location.href).href);
  const projectionEngine = injected ? createProjectedExampleProjectionEngine() : undefined;
  let loadedScene: Scene | undefined;
  let loads = 0;
  const createLayer = (detail: number) => new FixtureLayer({id: 'detail-fixture', scene, projectionEngine,
    projectedTileZoom: detail, projectedStyleZoom: 4, projectedMaxTiles: 16,
    projectedVisibleBounds: [-170, 5, -40, 75],
    tileResources: {maxConcurrentBuilds: 2, maxCachedTiles: 16, maxCachedMeshBytes: 32 * 1024 * 1024},
    onSceneLoad: value => {loadedScene = value; loads++;}, onSceneError: error => errors.push(error.message)});
  deck = new Deck({canvas, device: harness.device, width: 512, height: 320, useDevicePixels: false,
    views: new OrthographicView({id: 'projected', flipY: false}), initialViewState: {target: [0, 0, 0], zoom: -2},
    onError: error => {errors.push(error.message);}, _animate: true, layers: [createLayer(1)]});
  await expect.poll(() => loadedScene, {timeout: 20000}).toBeDefined();
  if (!loadedScene) throw new Error('Expected a loaded detail scene');
  const initialScene = loadedScene;
  const workers = Reflect.get(initialScene, 'workers');
  /** Observe real scene tiles without widening its public API solely for a fixture. */
  const getVisibleTiles = () => Object.values(initialScene.tile_manager.tiles).filter(tile => tile.visible);
  /** Wait for installed detail and every scheduled build, not only a fallback's first pixel. */
  const waitForDetail = async (detail: number) => {
    // Auto-tiled GeoJSON uses 512px tiles: normalized data is one level below logical detail.
    const sourceZoom = Math.max(0, detail - 1);
    await expect.poll(() => {
      const tiles = getVisibleTiles();
      return tiles.length > 0 && tiles.every(tile => Reflect.get(tile, 'coords').z === sourceZoom && tile.built && Reflect.get(tile, 'style_z') === 4);
    }, {timeout: 20000}).toBe(true);
    await expect.poll(() => {
      const resources = initialScene.tile_manager.getResourceStatistics();
      return resources.activeBuilds + resources.queuedBuilds;
    }, {timeout: 20000}).toBe(0);
    await expect.poll(async () => coloredPixels(await readCanvasPixels(canvas)), {timeout: 20000}).toBeGreaterThan(500);
    expect(errors).toEqual([]);
    expect(initialScene.view.zoom).toBe(4);
    const resources = initialScene.tile_manager.getResourceStatistics();
    expect(resources.activeBuilds).toBeLessThanOrEqual(2);
    expect(resources.cachedTiles).toBeLessThanOrEqual(16);
    expect(resources.cachedMeshBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
  };
  await waitForDetail(1);
  const coarse = getVisibleTiles().map(tile => ({tile, meshes: tile.meshes, generation: tile.generation}));
  deck.setProps({layers: [createLayer(2)]});
  await waitForDetail(2);
  expect(getVisibleTiles().every(tile => !coarse.some(value => value.tile === tile))).toBe(true);
  deck.setProps({layers: [createLayer(1)]});
  await waitForDetail(1);
  expect(getVisibleTiles()).toHaveLength(coarse.length);
  for (const {tile, meshes, generation} of coarse) {
    expect(getVisibleTiles()).toContain(tile);
    expect(tile.meshes).toBe(meshes);
    expect(tile.generation).toBe(generation);
  }
  expect(loadedScene).toBe(initialScene);
  expect(Reflect.get(initialScene, 'workers')).toBe(workers);
  expect(loads).toBe(1);
});

test.each(['equal-earth', 'albers', 'equirectangular', 'mercator', 'web-mercator'] as const)(
  `${DEVICE_TYPE}: projected %s road ribbons render through packaged worker and preserve warm sources`, async type => {
    harness = new RenderingHarness();
    await harness.initializeDevice();
    const errors = harness.errors;
    const canvas = harness.canvas;
    let loadedScene: Scene | undefined;
    let completed = '';
    const engine = createProjectedExampleProjectionEngine();
    let engineCompilations = 0;
    const projectionEngine: ProjectionEngine | undefined = type === 'albers' ? {
      createProjection: options => engine.createProjection(options),
      createProjectionAsync: options => {engineCompilations++; return engine.createProjectionAsync(options);}
    } : undefined;
    // Force style zoom 2 over data zoom 1 to check packed extrusion overzoom.
    const scene = createProjectedBasemapScene(createRoadScene(1), {type},
      new URL('/modules/tangram-renderer/dist/projected-basemaps-worker.js', location.href).href);
    const createLayer = (projection: ProjectedBasemapOptions['type']) => new FixtureLayer({id: 'projected-road-fixture',
      scene, projectedTileZoom: 2, projectedProjection: {type: projection}, projectionEngine,
      projectedVisibleBounds: [-170, 5, -40, 75],
      onSceneLoad: value => {loadedScene = value;}, onProjectionChange: () => {completed = projection;},
      onSceneError: error => errors.push(error.message)});
    deck = new Deck({canvas, device: harness.device, width: 512, height: 320, useDevicePixels: false,
      views: new OrthographicView({id: 'projected', flipY: false}),
      initialViewState: {target: [0, 0, 0], zoom: type === 'albers' ? -1 : -2},
      onError: error => {errors.push(error.message);}, _animate: true, layers: [createLayer(type)]});
    const waitForRoads = async () => {
      for (const road of ['round', 'square', 'butt']) await expect.poll(async () => {
        expect(errors).toEqual([]);
        const pixels = await readCanvasPixels(canvas);
        let matchingRoad = 0;
        for (let offset = 0; offset < pixels.data.length; offset += 4) {
          const red = pixels.data[offset], green = pixels.data[offset + 1], blue = pixels.data[offset + 2];
          if (blue < 70 && (road === 'round' ? red > 150 && green < 70 :
            road === 'square' ? green > 150 && red < 70 : red > 150 && green > 70 && green < 170)) matchingRoad++;
        }
        return matchingRoad;
      }, {timeout: 20000, interval: 100, message: `${type}: ${road} road must render independently`}).toBeGreaterThan(15);
    };
    await waitForRoads();
    await expect.poll(() => completed).toBe(type);
    if (projectionEngine) expect(engineCompilations).toBe(1);
    if (!loadedScene) throw new Error('Road scene did not load');
    const firstScene = loadedScene;
    const acquisitions = (await firstScene.getTileSourceStatistics()).map(value => value.acquisitions);
    const next = type === 'equal-earth' ? 'web-mercator' : 'equal-earth';
    deck.setProps({layers: [createLayer(next)]});
    await expect.poll(() => completed, {timeout: 20000}).toBe(next);
    await waitForRoads();
    expect(loadedScene).toBe(firstScene);
    expect((await firstScene.getTileSourceStatistics()).map(value => value.acquisitions)).toEqual(acquisitions);
    if (projectionEngine) expect(engineCompilations).toBe(2);
  });

test(`${DEVICE_TYPE}: a worker refinement failure rejects and a queued projection correction renders`, async () => {
  harness = new RenderingHarness();
  await harness.initializeDevice();
  const errors = harness.errors;
  const canvas = harness.canvas;
  const layer = new FixtureLayer({id: 'recover-projected-fixture', projectedTileZoom: 2,
    scene: createProjectedBasemapScene(createRasterScene(), {type: 'equal-earth'},
      new URL('/modules/tangram-renderer/dist/projected-basemaps-worker.js', location.href).href),
    onSceneError: error => errors.push(error.message)});
  deck = new Deck({canvas, device: harness.device, width: 512, height: 320, useDevicePixels: false,
    views: new OrthographicView({id: 'projected', flipY: false}),
    initialViewState: {target: [0, 0, 0], zoom: -2},
    onError: error => {errors.push(error.message);}, _animate: true, layers: [layer]});
  await expect.poll(async () => coloredPixels(await readCanvasPixels(canvas)),
    {timeout: 20000, interval: 100}).toBeGreaterThan(500);
  const state = Reflect.get(layer, 'state') as {tangramRecord: {renderer: Renderer}};
  const renderer = state.tangramRecord.renderer;
  const failed = renderer.setProjectedBasemapProjection({type: 'equal-earth', maxAdditionalVertices: 0});
  // Queue the original configuration immediately, before the worker replies.
  // It must rebuild even though the failed update restores those same options.
  const correction = renderer.setProjectedBasemapProjection({type: 'equal-earth'});
  await expect(failed).rejects.toThrow(/budget/);
  await correction;
  await expect.poll(async () => coloredPixels(await readCanvasPixels(canvas)),
    {timeout: 20000, interval: 100}).toBeGreaterThan(500);
  expect(errors).toEqual([]);
  const diagnostics = await commands.renderingDiagnostics();
  expect(diagnostics.length).toBeGreaterThan(0);
  for (const diagnostic of diagnostics) expect(diagnostic).toMatch(/budget/);
  // Only the deliberately induced and asserted failure is cleared. Teardown
  // still checks for unrelated errors or errors emitted after recovery.
  await commands.startRenderingDiagnostics();
});
