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
import type {ProjectedBasemapOptions} from '@vis.gl/tangram-renderer/core';

let harness: RenderingHarness | undefined;
let deck: Deck<OrthographicView> | undefined;
/** Dynamic layer factories do not yet emit a public subclass declaration. */
type FixtureProperties = {scene: Record<string, unknown>; projectedTileZoom: number; onSceneError: (error: Error) => void;
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
