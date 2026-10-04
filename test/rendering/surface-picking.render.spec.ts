// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, beforeEach, expect, test} from 'vitest';
import {commands} from 'vitest/browser';
import {Matrix4} from '@math.gl/core';
import {pickXRSurface} from '@vis.gl/tangram-layers/experimental/webxr';
import {RenderingHarness, coloredPixels, DEVICE_TYPE} from './harness';

let harness: RenderingHarness | undefined;
beforeEach(() => commands.startRenderingDiagnostics());
afterEach(async () => {
  try {
    expect(harness?.errors || []).toEqual([]);
    expect(await commands.renderingDiagnostics()).toEqual([]);
  } finally {
    harness?.destroy();
    harness = undefined;
  }
});

for (const kind of ['perspective', 'globe', 'first-person'] as const) {
  for (const mode of ['mono', 'stereo-preview'] as const) {
    test(`${DEVICE_TYPE}: ${kind} ${mode} surface picks match the submitted eye cameras`, async () => {
      harness = new RenderingHarness(kind, mode);
      await harness.initialize();
      await harness.settle();
      expect(coloredPixels(await harness.pixels())).toBeGreaterThan(100);
      const frame = harness.presentation.createFrame({width: harness.canvas.width,
        height: harness.canvas.height, interpupillaryDistance: harness.interpupillaryDistance});
      for (const view of frame.renderViews) {
        const viewport = view.viewport!;
        const x = (viewport.x || 0) + viewport.width / 2;
        const y = (viewport.y || 0) + viewport.height / 2;
        const hit = pickXRSurface({pointer: {x, y}, frame, placement: harness.presentation.placement});
        expect(hit).not.toBeNull();
        expect(hit!.renderViewId).toBe(view.id);
        expect(hit!.coordinate.every(Number.isFinite)).toBe(true);
        expect(hit!.coordinate[2]).toBe(0);
        if (kind === 'globe') expect(Math.hypot(...hit!.position)).toBeCloseTo(256, 7);
        else expect(hit!.position[2]).toBeCloseTo(0, 7);
        // The same camera is submitted to the real renderer above. Reproject
        // the picked common-space surface through it, without a logical-eye substitute.
        const clip = new Matrix4().copy(view.camera.projection);
        if (kind !== 'globe') clip.multiplyRight(view.camera.view);
        const point = clip.transform([...hit!.position, 1]);
        expect(point[0] / point[3]).toBeCloseTo(0, 6);
        expect(point[1] / point[3]).toBeCloseTo(0, 6);
        expect(Math.abs(point[2] / point[3])).toBeLessThanOrEqual(1);
      }
    });
  }
}
