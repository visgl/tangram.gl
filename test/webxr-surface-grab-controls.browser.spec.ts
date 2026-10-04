// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {Matrix4} from '@math.gl/core';
import {WebXRInputAdapter, createXRPlacementMatrix,
  type XRMapPlacement} from '@vis.gl/tangram-layers/experimental/webxr';
import {createSurfaceGrabControls, bindReferenceSpaceReset} from '../examples/webxr/surface-grabbing.js';

test('mocked controller frames preserve accepted room placement through release and clear it at session teardown', () => {
  const controls = createSurfaceGrabControls();
  const adapter = new WebXRInputAdapter();
  const placement: XRMapPlacement = {type: 'map', anchor: [0, 0], metersPerXRUnit: 1000,
    pose: {position: [0, 0.7, -2]}};
  const context = {placement, placementMatrix: createXRPlacementMatrix(placement)};
  const snapshot = (horizontal: number, active: boolean) => ({index: 0, handedness: 'left',
    squeezeActive: active, targetRayMatrix: new Matrix4().translate([horizontal, 1.7, -2]).rotateX(-Math.PI / 2)});
  expect(controls.getPlacement()).toBeNull();
  controls.update(adapter.update([snapshot(0, true)]), context);
  expect(controls.isGrabbing()).toBe(true);
  expect(controls.getPlacement()).toBe(placement);
  const moved = controls.update(adapter.update([snapshot(0.3, true)]), context);
  expect(moved?.pose?.position?.[0]).toBeCloseTo(0.3, 7);
  controls.update(adapter.update([snapshot(0.3, false)]), context);
  expect(controls.isGrabbing()).toBe(false);
  expect(controls.getPlacement()?.pose?.position?.[0]).toBeCloseTo(0.3, 7);
  controls.reset();
  adapter.reset();
  expect(controls.getPlacement()).toBeNull();
  expect(controls.isGrabbing()).toBe(false);
});

test('desktop navigation and selection intents do not acquire placement or freeze animation', () => {
  const controls = createSurfaceGrabControls();
  const context = {placement: {type: 'globe', anchor: [0, 0], radius: 0.5}};
  controls.update([{type: 'navigate', action: 'rotate', delta: [5, 3]},
    {type: 'point', action: 'select', pointer: {x: 100, y: 100}}], context);
  expect(controls.getPlacement()).toBeNull();
  expect(controls.isGrabbing()).toBe(false);
});

test('reference-space resets clear the accepted pose, cannot re-grab held squeeze, and detach at session end', () => {
  const controls = createSurfaceGrabControls();
  const adapter = new WebXRInputAdapter();
  const referenceSpace = new EventTarget();
  const removeListener = bindReferenceSpaceReset(referenceSpace, () => controls.reset());
  const context = {placement: {type: 'map', anchor: [0, 0], metersPerXRUnit: 1000}};
  const input = {index: 0, squeezeActive: true,
    targetRayMatrix: new Matrix4().translate([0, 1, 0]).rotateX(-Math.PI / 2)};
  controls.update(adapter.update([input]), context);
  expect(controls.isGrabbing()).toBe(true);
  referenceSpace.dispatchEvent(new Event('reset'));
  expect(controls.getPlacement()).toBeNull();
  controls.update(adapter.update([input]), context);
  expect(controls.isGrabbing()).toBe(false);
  adapter.update([{...input, squeezeActive: false}]);
  controls.update(adapter.update([input]), context);
  expect(controls.isGrabbing()).toBe(true);
  removeListener();
  referenceSpace.dispatchEvent(new Event('reset'));
  expect(controls.isGrabbing()).toBe(true);
  controls.reset();
  bindReferenceSpaceReset(null, () => controls.reset())();
});
