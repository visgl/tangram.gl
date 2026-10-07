// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, beforeEach, expect, test} from 'vitest';
import {commands} from 'vitest/browser';
import {Deck, OrthographicView, type Layer, type LayerProps} from '@deck.gl/core';
import {ProjectedBasemapLayer, createProjectedBasemapScene} from '@vis.gl/tangram-layers/experimental/projected-basemaps';
import {RenderingHarness, coloredPixels, readCanvasPixels, DEVICE_TYPE} from './harness';
import {createRasterScene} from './scene';
import type Scene from '../../modules/tangram-renderer/src/scene/scene';
import type {HostTileResourceOptions, ProjectedBasemapOptions, Renderer} from '@vis.gl/tangram-renderer/core';

let harness: RenderingHarness | undefined;
let deck: Deck<OrthographicView> | undefined;
/** Dynamic layer factories do not yet emit a public subclass declaration. */
type FixtureProperties = {scene: Record<string, unknown>; projectedTileZoom: number; onSceneError: (error: Error) => void;
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

test.each(['equal-earth', 'albers', 'equirectangular', 'mercator', 'web-mercator'] as const)(
  `${DEVICE_TYPE}: projected %s polygons and raster use the packaged worker and OrthographicView`, async type => {
    harness = new RenderingHarness();
    await harness.initializeDevice();
    const errors = harness.errors;
    const canvas = harness.canvas;
    const workerUrl = new URL('/modules/tangram-renderer/dist/projected-basemaps-worker.js', location.href).href;
    const createLayer = (raster: boolean) => new FixtureLayer({id: 'projected-fixture', projectedTileZoom: 2,
      scene: createProjectedBasemapScene(raster ? createRasterScene() : createPolygonScene(), {type}, workerUrl),
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

test.each([false, true])(`${DEVICE_TYPE}: projection switches reuse decoded tiles and workers (raster=%s)`, async raster => {
  harness = new RenderingHarness();
  await harness.initializeDevice();
  const errors = harness.errors;
  const canvas = harness.canvas;
  const scene = createProjectedBasemapScene(raster ? createRasterScene() : createPolygonScene(), {type: 'equal-earth'},
    new URL('/modules/tangram-renderer/dist/projected-basemaps-worker.js', location.href).href);
  let loadedScene: Scene | undefined;
  let completedProjection = '';
  let loadCount = 0;
  const createLayer = (type: ProjectedBasemapOptions['type']) => new FixtureLayer({id: 'warm-projected-fixture',
    scene, projectedTileZoom: 2, projectedProjection: {type},
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
  if (!loadedScene) throw new Error('Expected a loaded projected scene');
  const initialScene = loadedScene;
  const workers = Reflect.get(initialScene, 'workers');
  await expect.poll(async () => (await initialScene.getTileSourceStatistics())
    .reduce((count, value) => count + value.loadingTiles + value.queuedTiles, 0), {timeout: 20000}).toBe(0);
  const statistics = await initialScene.getTileSourceStatistics();
  for (const type of ['albers', 'mercator', 'web-mercator', 'equirectangular', 'equal-earth'] as const) {
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
  }
});

test(`${DEVICE_TYPE}: source detail round trips retain style zoom, workers and warm tile meshes`, async () => {
  harness = new RenderingHarness();
  await harness.initializeDevice();
  const errors = harness.errors;
  const canvas = harness.canvas;
  const scene = createProjectedBasemapScene(createPolygonScene(), {type: 'equal-earth'},
    new URL('/modules/tangram-renderer/dist/projected-basemaps-worker.js', location.href).href);
  let loadedScene: Scene | undefined;
  let loads = 0;
  const createLayer = (detail: number) => new FixtureLayer({id: 'detail-fixture', scene,
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
    // Force style zoom 2 over data zoom 1 to check packed extrusion overzoom.
    const scene = createProjectedBasemapScene(createRoadScene(1), {type},
      new URL('/modules/tangram-renderer/dist/projected-basemaps-worker.js', location.href).href);
    const createLayer = (projection: ProjectedBasemapOptions['type']) => new FixtureLayer({id: 'projected-road-fixture',
      scene, projectedTileZoom: 2, projectedProjection: {type: projection},
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
    if (!loadedScene) throw new Error('Road scene did not load');
    const firstScene = loadedScene;
    const acquisitions = (await firstScene.getTileSourceStatistics()).map(value => value.acquisitions);
    const next = type === 'equal-earth' ? 'web-mercator' : 'equal-earth';
    deck.setProps({layers: [createLayer(next)]});
    await expect.poll(() => completed, {timeout: 20000}).toBe(next);
    await waitForRoads();
    expect(loadedScene).toBe(firstScene);
    expect((await firstScene.getTileSourceStatistics()).map(value => value.acquisitions)).toEqual(acquisitions);
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
