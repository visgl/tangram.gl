// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, beforeEach, expect, test} from 'vitest';
import {commands} from 'vitest/browser';
import {Matrix4} from '@math.gl/core';
import {WebXRSurfaceGrabber, type XRFrameState, type XRInteractionIntent, type XRPlacement}
  from '@vis.gl/tangram-layers/experimental/webxr';
import {RenderingHarness, coloredPixels, changedPixels, DEVICE_TYPE} from './harness';

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

for (const kind of ['perspective', 'globe'] as const) {
  test(`${DEVICE_TYPE}: room-space ${kind} grab updates both mocked immersive eyes`, async () => {
    const current = new RenderingHarness(kind);
    harness = current;
    await current.initialize();
    const placement: XRPlacement = kind === 'globe'
      ? {type: 'globe', anchor: [0, 0], radius: 0.5, pose: {position: [0, 0.7, -2]}}
      : {type: 'map', anchor: [0, 0], metersPerXRUnit: 1000, pose: {position: [0, 0.7, -2]}};
    current.presentation.setPlacement(placement);
    const frameState: XRFrameState = {views: [-0.032, 0.032].map((horizontal, index) => ({
      index, eye: index === 0 ? 'left' : 'right', viewport: [index * 256, 0, 256, 320],
      viewMatrix: new Matrix4().lookAt({eye: [horizontal, 1.7, 0], center: [0, 0.7, -2], up: [0, 1, 0]}),
      projectionMatrix: new Matrix4().perspective({fovy: Math.PI / 3, aspect: 256 / 320, near: 0.05, far: 20})
    }))};
    // Submit fixed mocked headset matrices through the same real GPU path as other tests.
    current.frameState = frameState;
    await current.settle();
    const before = await current.pixels();
    expect(coloredPixels(before, 0, 256)).toBeGreaterThan(100);
    expect(coloredPixels(before, 256, 512)).toBeGreaterThan(100);
    const pointer = kind === 'globe'
      ? {origin: [0, 0.7, 0] as const, direction: [0, 0, -1] as const}
      : {origin: [0, 1.7, -2] as const, direction: [0, -1, 0] as const};
    const grabber = new WebXRSurfaceGrabber();
    const context = {placement, viewState: current.presentation.getViewState()};
    grabber.dispatchInteractionIntent({type: 'point', action: 'grab', pointer}, context);
    const moved: XRInteractionIntent = {type: 'point', action: 'hover', pointer: {...pointer,
      origin: [0.04, pointer.origin[1], pointer.origin[2]]}};
    const update = grabber.dispatchInteractionIntent(moved, context);
    expect(update).not.toBeNull();
    current.presentation.setPlacement(update!);
    await current.settle();
    const after = await current.pixels();
    expect(coloredPixels(after, 0, 256)).toBeGreaterThan(100);
    expect(coloredPixels(after, 256, 512)).toBeGreaterThan(100);
    expect(changedPixels(before, after, 0, 256)).toBeGreaterThan(50);
    expect(changedPixels(before, after, 256, 512)).toBeGreaterThan(50);
    expect(current.presentation.getViewState()).toEqual(context.viewState);
  });
}
