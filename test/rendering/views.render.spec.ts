// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {commands} from 'vitest/browser';
import {WebMercatorViewport} from '@deck.gl/core';
import {RenderingHarness, coloredPixels, changedPixels, eyeDifference, DEVICE_TYPE, type ViewKind} from './harness';
import {createRasterScene} from './scene';

let harness: RenderingHarness | undefined;
beforeEach(() => commands.startRenderingDiagnostics());
afterEach(async () => {
  try {
    expect(harness?.errors || []).toEqual([]);
    expect(await commands.renderingDiagnostics()).toEqual([]);
  } finally {
    try {
      if (harness) await commands.saveRenderingArtifact(expect.getState().currentTestName || 'view',
        harness.canvas.toDataURL('image/png'));
    } finally {
      vi.useRealTimers();
      harness?.destroy();
      harness = undefined;
    }
  }
});

for (const kind of ['flat', 'perspective', 'globe', 'first-person'] as const) {
  for (const mode of ['mono', 'stereo-preview'] as const) {
    test(`${DEVICE_TYPE}: ${kind} ${mode} draws geometry`, async () => {
      harness = new RenderingHarness(kind, mode);
      await harness.initialize();
      await harness.settle();
      const pixels = await harness.pixels();
      expect(coloredPixels(pixels)).toBeGreaterThan(100);
      if (mode === 'stereo-preview') {
        expect(coloredPixels(pixels, 0, pixels.width / 2)).toBeGreaterThan(50);
        expect(coloredPixels(pixels, pixels.width / 2)).toBeGreaterThan(50);
      }
    });
  }
}

test('street-level zoom, resize, and style reload retain visible geometry', async () => {
  harness = new RenderingHarness();
  await harness.initialize();
  await harness.settle();
  const before = await harness.pixels();
  for (const zoom of [17, 19, 15]) {
    harness.presentation.setViewState({zoom});
    await harness.settle();
    expect(coloredPixels(await harness.pixels())).toBeGreaterThan(100);
  }
  await harness.reload('#ff4020');
  expect(changedPixels(before, await harness.pixels())).toBeGreaterThan(100);
  harness.resize(640, 360);
  await harness.settle();
  const resized = await harness.pixels();
  expect([resized.width, resized.height]).toEqual([640, 360]);
  expect(coloredPixels(resized)).toBeGreaterThan(100);
});

test('raster tiles render and can switch back to vector geometry', async () => {
  harness = new RenderingHarness();
  await harness.initialize();
  await harness.renderer.load(createRasterScene());
  await harness.settle();
  const raster = await harness.pixels();
  expect(coloredPixels(raster)).toBeGreaterThan(raster.width * raster.height * 0.5);
  await harness.reload('#20d0b0');
  const vector = await harness.pixels();
  expect(coloredPixels(vector)).toBeGreaterThan(100);
  expect(changedPixels(raster, vector)).toBeGreaterThan(1000);
});

test(DEVICE_TYPE === 'webgl' ? 'WebGL selection returns the rendered building'
  : 'WebGPU selection explicitly reports its current unsupported result', async () => {
  harness = new RenderingHarness('flat');
  await harness.initialize();
  await harness.settle();
  const viewport = new WebMercatorViewport({width: 512, height: 320,
    longitude: 0, latitude: 0, zoom: 15, pitch: 0});
  const [x, y] = viewport.project([0.001, 0.001, 80]);
  const result = await harness.pick(x, y);
  if (DEVICE_TYPE === 'webgl') {
    expect(result?.error).toBeUndefined();
    expect(result?.feature?.properties?.name).toBe('fixture-building');
  } else {
    expect(result).toBeUndefined();
  }
  expect(coloredPixels(await harness.pixels())).toBeGreaterThan(100);
});

test.each(['mono', 'stereo-preview'] as const)('%s: shader time changes road pixels', async mode => {
  harness = new RenderingHarness('perspective', mode);
  await harness.initialize();
  vi.useFakeTimers({toFake: ['Date']});
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  await harness.reload('#20d0b0', true);
  const before = await harness.pixels();
  vi.setSystemTime(new Date('2026-01-01T00:00:00.650Z'));
  const after = await harness.pixels();
  expect(coloredPixels(before)).toBeGreaterThan(100);
  expect(changedPixels(before, after)).toBeGreaterThan(50);
  if (mode === 'stereo-preview') {
    expect(changedPixels(before, after, 0, before.width / 2)).toBeGreaterThan(50);
    expect(changedPixels(before, after, before.width / 2)).toBeGreaterThan(50);
  }
});

test('stereo cameras coincide at zero IPD and diverge at physical IPD', async () => {
  harness = new RenderingHarness('perspective', 'stereo-preview');
  await harness.initialize();
  harness.interpupillaryDistance = 0;
  await harness.settle();
  const zero = await harness.pixels();
  expect(coloredPixels(zero, 0, zero.width / 2)).toBeGreaterThan(100);
  expect(eyeDifference(zero)).toBeLessThan(10);
  harness.interpupillaryDistance = 0.064;
  const stereo = await harness.pixels();
  expect(coloredPixels(stereo, 0, stereo.width / 2)).toBeGreaterThan(100);
  expect(coloredPixels(stereo, stereo.width / 2)).toBeGreaterThan(100);
  expect(eyeDifference(stereo)).toBeGreaterThan(50);
});

test.each(['perspective', 'globe', 'first-person'] as const)(
  '%s: two-finger trackpad pan does not become zoom in either eye', async kind => {
  harness = new RenderingHarness(kind, 'stereo-preview');
  await harness.initialize();
  await harness.settle();
  for (const side of ['left', 'right'] as const) {
    const before = {...harness.presentation.getViewState()};
    await commands.panRenderingCanvas(side);
    await expect.poll(() => harness!.presentation.getViewState()).not.toEqual(before);
    const after = harness.presentation.getViewState();
    if (kind === 'globe') {
      // GlobeController compensates zoom for latitude while retaining eye distance.
      const effectiveZoom = (state: Record<string, unknown>) => Number(state.zoom) -
        Math.log2(Math.cos(Number(state.latitude) * Math.PI / 180));
      expect(effectiveZoom(after)).toBeCloseTo(effectiveZoom(before), 6);
    } else if (kind === 'first-person') {
      expect(after.position).not.toEqual(before.position);
      expect([after.pitch, after.bearing]).toEqual([before.pitch, before.bearing]);
    } else {
      expect(after.zoom).toBe(before.zoom);
    }
    await harness.settle();
    expect(coloredPixels(await harness.pixels())).toBeGreaterThan(100);
  }
});

test('touch pinch zooms and rotates the shared stereo map', async () => {
  harness = new RenderingHarness('perspective', 'stereo-preview');
  await harness.initialize();
  await harness.settle();
  const before = {...harness.presentation.getViewState()};
  await commands.pinchRenderingCanvas();
  await harness.settle();
  expect(harness.presentation.getViewState().zoom).toBeGreaterThan(Number(before.zoom));
  expect(harness.presentation.getViewState().bearing).not.toBe(before.bearing);
  expect(coloredPixels(await harness.pixels())).toBeGreaterThan(100);
});

test.each(['perspective', 'globe', 'first-person'] satisfies ViewKind[])(
  '%s: dragging either stereo eye updates shared state and rendered pixels', async kind => {
    harness = new RenderingHarness(kind, 'stereo-preview');
    await harness.initialize();
    await harness.settle();
    for (const side of ['left', 'right'] as const) {
      const state = {...harness.presentation.getViewState()};
      const before = await harness.pixels();
      await commands.dragRenderingCanvas(side);
      await harness.settle();
      expect(harness.presentation.getViewState()).not.toEqual(state);
      const after = await harness.pixels();
      expect(changedPixels(before, after)).toBeGreaterThan(50);
      expect(coloredPixels(after, 0, after.width / 2)).toBeGreaterThan(50);
      expect(coloredPixels(after, after.width / 2)).toBeGreaterThan(50);
    }
  }
);

test('mono/stereo mode changes and resize keep controllers and drawing aligned', async () => {
  harness = new RenderingHarness('perspective');
  await harness.initialize();
  for (const mode of ['stereo-preview', 'mono', 'stereo-preview'] as const) {
    harness.presentation.setMode(mode);
    harness.resize(640, 360);
    await harness.settle();
    const before = await harness.pixels();
    await commands.dragRenderingCanvas('right');
    await harness.settle();
    const after = await harness.pixels();
    expect([after.width, after.height]).toEqual([640, 360]);
    expect(coloredPixels(after)).toBeGreaterThan(100);
    expect(changedPixels(before, after)).toBeGreaterThan(50);
  }
});
