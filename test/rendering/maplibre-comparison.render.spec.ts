// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, beforeEach, expect, test} from 'vitest';
import {commands} from 'vitest/browser';
import {mountMapLibreComparison} from '../../examples/deck/maplibre-comparison';
import type {ComparisonCamera} from '../../examples/deck/comparison-style';
import {RenderingHarness, readCanvasPixels, coloredPixels, DEVICE_TYPE} from './harness';
import {createRasterScene} from './scene';

let harness: RenderingHarness | undefined;
let comparison: Awaited<ReturnType<typeof mountMapLibreComparison>> | undefined;
let root: HTMLElement | undefined;
let exampleStylesheet: HTMLLinkElement | undefined;
beforeEach(() => commands.startRenderingDiagnostics());
afterEach(async () => {
  try {expect(await commands.renderingDiagnostics()).toEqual([]); expect(harness?.errors ?? []).toEqual([]);}
  finally {comparison?.destroy(); comparison = undefined; harness?.destroy(); harness = undefined; root?.remove(); root = undefined; exampleStylesheet?.remove(); exampleStylesheet = undefined;}
});

test.each(['perspective', 'globe'] as const)(`${DEVICE_TYPE}: optional MapLibre %s reference renders offline beside Tangram and releases its pane`, async kind => {
  const image = document.createElement('canvas'); image.width = image.height = 2;
  const context = image.getContext('2d'); if (!context) throw new Error('Missing fixture canvas context');
  context.fillStyle = '#ff0000'; context.fillRect(0, 0, 1, 2);
  context.fillStyle = '#0000ff'; context.fillRect(1, 0, 1, 2);
  const scene = createRasterScene(); scene.sources.fixture.url = `${image.toDataURL()}#/{z}/{x}/{y}`;
  harness = new RenderingHarness(kind); await harness.initialize(scene); await harness.settle();
  const tangramPixels = await harness.pixels();
  expect(coloredPixels(tangramPixels)).toBeGreaterThan(50);
  expect(countInterpolatedPixels(tangramPixels)).toBeGreaterThan(100);
  root = document.createElement('div'); root.style.cssText = 'position:relative;width:400px;height:320px'; document.body.append(root);
  // Match production ordering: vendor CSS loads after the example stylesheet.
  // MapLibre's position:relative must not override the split pane's absolute layout.
  exampleStylesheet = document.createElement('link'); exampleStylesheet.rel = 'stylesheet';
  exampleStylesheet.href = new URL('../../examples/deck/main.css', import.meta.url).href;
  const stylesheetReady = new Promise<void>((resolve, reject) => {
    exampleStylesheet?.addEventListener('load', () => resolve(), {once: true});
    exampleStylesheet?.addEventListener('error', () => reject(new Error('Example stylesheet failed to load')), {once: true});
  });
  document.head.append(exampleStylesheet); await stylesheetReady;
  const stylesheet = new URL('../../examples/dist/maplibre.css', import.meta.url).href;
  const raster = scene.sources.fixture.url;
  const errors: string[] = [];
  const moves: ComparisonCamera[] = [];
  comparison = await mountMapLibreComparison({container: root, camera: {longitude: 0, latitude: 0, zoom: kind === 'globe' ? 2 : 15},
    viewMode: kind === 'globe' ? 'globe' : 'mapPerspective', stylesheetUrl: stylesheet, preserveDrawingBuffer: true,
    workerUrl: new URL('../../examples/dist/maplibre-worker.js', import.meta.url).href,
    style: {version: 8, projection: {type: kind === 'globe' ? 'globe' : 'mercator'}, sources: {
      imagery: {type: 'raster', tiles: [raster], tileSize: 256, attribution: 'Offline fixture imagery'}
    }, layers: [{id: 'imagery', type: 'raster', source: 'imagery', paint: {'raster-fade-duration': 0}}]},
    onChange: camera => {moves.push(camera); harness?.presentation.setViewState(camera);}, onError: error => errors.push(error.message)
  });
  const canvas = root.querySelector('canvas'); if (!canvas) throw new Error('Missing MapLibre canvas');
  const stylesheetLink = Array.from(document.querySelectorAll('link')).find(link => link.href === new URL(stylesheet, window.location.href).href);
  expect(stylesheetLink?.isConnected).toBe(true);
  await expect.poll(() => Boolean(stylesheetLink?.sheet) && Boolean(exampleStylesheet?.sheet)).toBe(true);
  const pane = root.querySelector('.maplibre-comparison-pane'); if (!pane) throw new Error('Missing comparison pane');
  expect(getComputedStyle(pane).position).toBe('absolute');
  expect(pane.getBoundingClientRect().height).toBeGreaterThan(100);
  await expect.poll(async () => {expect(errors).toEqual([]); return coloredPixels(await readCanvasPixels(canvas));}, {timeout: 15000}).toBeGreaterThan(50);
  expect(countInterpolatedPixels(await readCanvasPixels(canvas))).toBeGreaterThan(100);
  expect(root.textContent).toContain('Offline fixture imagery');
  await commands.dragMapLibreComparison();
  await expect.poll(() => moves.some(camera => Math.abs(camera.longitude) > 0.0000001)).toBe(true);
  const originalWidth = canvas.clientWidth;
  root.style.width = '320px';
  await expect.poll(() => canvas.clientWidth).toBeLessThan(originalWidth);
  comparison.updateCamera({longitude: 0.002, latitude: 0, zoom: kind === 'globe' ? 2.25 : 15.25});
  await harness.settle(); expect(coloredPixels(await harness.pixels())).toBeGreaterThan(50);
  comparison.destroy(); comparison.destroy();
  expect(root.querySelector('canvas')).toBeNull();
  expect(stylesheetLink?.isConnected).toBe(false);
  expect(errors).toEqual([]);
}, 45000);

/** Linear resampling creates purple pixels; nearest sampling contains only red and blue. */
function countInterpolatedPixels(image: ImageData): number {
  const pixels = image.data;
  let count = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset] > 30 && pixels[offset] < 225 && pixels[offset + 1] < 10 &&
      pixels[offset + 2] > 30 && pixels[offset + 2] < 225) count++;
  }
  return count;
}

test.each([256, 512])(`${DEVICE_TYPE}: globe normalizes %s-pixel source detail once`, async tileSize => {
  harness = new RenderingHarness('globe');
  harness.presentation.setViewState({longitude: 0, latitude: 40.7, zoom: 3});
  const scene = createRasterScene();
  await harness.initialize({...scene, sources: {fixture: {...scene.sources.fixture, tile_size: tileSize}}});
  await harness.settle();
  // The same source pyramids as MapLibre's zoom + log2(512 / tileSize).
  const expectedZoom = 3 + Math.log2(512 / tileSize);
  expect(harness.getTileLods().length).toBeGreaterThan(0);
  expect(new Set(harness.getTileLods().map(tile => tile.dataZoom))).toEqual(new Set([expectedZoom]));
  expect(coloredPixels(await harness.pixels())).toBeGreaterThan(100);
});
