// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {commands} from 'vitest/browser';
import {RenderingHarness, coloredPixels, changedPixels, DEVICE_TYPE} from './harness';
import {createOpenMapTilesScene, createOpenMapTilesUrl, getOpenMapTilesAnchor} from './openmaptiles-scene';

let harness: RenderingHarness | undefined;
beforeEach(() => commands.startRenderingDiagnostics());
afterEach(async () => {
  try {
    expect(harness?.errors || []).toEqual([]);
    expect(await commands.renderingDiagnostics()).toEqual([]);
    if (harness) await commands.saveRenderingArtifact(expect.getState().currentTestName || 'openmaptiles',
      harness.canvas.toDataURL('image/png'));
  } finally {
    vi.useRealTimers();
    harness?.destroy();
    harness = undefined;
  }
});

/** Count the blue label pixels separately from cyan roads and orange buildings. */
function countLabelPixels(image: ImageData) {
  let count = 0;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    if (image.data[offset + 2] > image.data[offset + 1] + 40 && image.data[offset + 2] > 100) count++;
  }
  return count;
}

for (const kind of ['flat', 'perspective', 'globe', 'first-person'] as const) {
  for (const mode of ['mono', 'stereo-preview'] as const) {
    test(`${DEVICE_TYPE}: OpenMapTiles ${kind} ${mode} renders decoded MVT in the scene worker`, async () => {
      harness = new RenderingHarness(kind, mode);
      const dataZoom = kind === 'globe' ? 3 : kind === 'first-person' ? 13 : 14;
      // Globe and first-person views derive style scale differently from MapView.
      harness.presentation.setViewState({...getOpenMapTilesAnchor(dataZoom), zoom: kind === 'globe' ? 5 : 15});
      await harness.initialize(createOpenMapTilesScene(createOpenMapTilesUrl(dataZoom), false, true, true, dataZoom));
      await harness.settle();
      const pixels = await harness.pixels();
      expect(coloredPixels(pixels)).toBeGreaterThan(100);
      expect(harness.getTileLods().length).toBeGreaterThan(0);
      expect(new Set(harness.getTileLods().map(tile => tile.dataZoom))).toEqual(new Set([dataZoom]));
      if (mode === 'stereo-preview') {
        expect(coloredPixels(pixels, 0, pixels.width / 2)).toBeGreaterThan(50);
        expect(coloredPixels(pixels, pixels.width / 2)).toBeGreaterThan(50);
      }
    });
  }
}

test(`${DEVICE_TYPE}: OpenMapTiles height fields, names and traffic time affect rendered pixels`, async () => {
  harness = new RenderingHarness('perspective');
  harness.presentation.setViewState({...getOpenMapTilesAnchor(), zoom: 15});
  const url = createOpenMapTilesUrl();
  await harness.initialize(createOpenMapTilesScene(url));
  await harness.settle();
  const extruded = await harness.pixels();
  expect(countLabelPixels(extruded)).toBeGreaterThan(20);
  // Label placement needs frames during a rebuild, as in the examples' render loop.
  await harness.renderer.load(createOpenMapTilesScene(url, false, false, true), {blocking: false});
  await harness.settle();
  const unextruded = await harness.pixels();
  expect(countLabelPixels(unextruded)).toBeGreaterThan(20);
  expect(changedPixels(extruded, unextruded)).toBeGreaterThan(100);
  await harness.renderer.load(createOpenMapTilesScene(url, false, false, false), {blocking: false});
  await harness.settle();
  const flat = await harness.pixels();
  expect(countLabelPixels(flat)).toBe(0);
  expect(changedPixels(extruded, flat)).toBeGreaterThan(100);
  vi.useFakeTimers({toFake: ['Date']});
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  await harness.renderer.load(createOpenMapTilesScene(url, true, false, false), {blocking: false});
  await harness.settle();
  const before = await harness.pixels();
  vi.setSystemTime(new Date('2026-01-01T00:00:00.650Z'));
  expect(changedPixels(before, await harness.pixels())).toBeGreaterThan(50);
  harness.presentation.setViewState({zoom: 18});
  await harness.settle();
  expect(harness.getTileLods().every(tile => tile.dataZoom === 14)).toBe(true);
  expect(coloredPixels(await harness.pixels())).toBeGreaterThan(100);
});
