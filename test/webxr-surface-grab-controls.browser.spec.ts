// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import {Matrix4} from '@math.gl/core';
import {WebXRInputAdapter, WebXRViewManager, WebXRMapView, WebXRGlobeView, createXRPlacementMatrix,
  type XRMapPlacement, type XRPlacement} from '@vis.gl/tangram-layers/experimental/webxr';
import {createSurfaceGrabControls, bindReferenceSpaceReset} from '../examples/webxr/surface-grabbing.js';

test.each(['map', 'globe'] as const)('%s grab acquisition suppresses the entire frame of thumbstick navigation', type => {
  const controls = createSurfaceGrabControls();
  const adapter = new WebXRInputAdapter();
  const placement: XRPlacement = type === 'map'
    ? {type, anchor: [0, 0], metersPerXRUnit: 1000, pose: {position: [0, 0, -2]}}
    : {type, anchor: [0, 0], radius: 0.5, pose: {position: [0, 0, -2]}};
  const initialViewState = {longitude: 0, latitude: 0, zoom: 14, bearing: 0};
  const presentation = new WebXRViewManager({
    view: type === 'map' ? new WebXRMapView() : new WebXRGlobeView(),
    placement, viewState: initialViewState
  });
  const dispatchNavigation = vi.fn(intent => presentation.dispatchInteractionIntent(intent));
  const ray = type === 'map'
    ? new Matrix4().translate([0, 1, -2]).rotateX(-Math.PI / 2)
    : new Matrix4();
  const snapshot = (active: boolean, targetRayMatrix = ray) => ({
    index: 0, handedness: 'left', squeezeActive: active, targetRayMatrix,
    gamepad: {axes: [0.8, 0.6]}
  });
  const processFrame = (inputs: Parameters<typeof adapter.update>[0], reverse = false) => {
    const viewState = presentation.getViewState();
    const intents = adapter.update(inputs, 0.1);
    // A second controller's navigation can precede the acquiring controller's grab.
    controls.update(reverse ? [...intents].reverse() : intents,
      {placement, viewState, placementMatrix: createXRPlacementMatrix(placement, viewState)}, dispatchNavigation);
  };

  processFrame([snapshot(true)], true);
  expect(controls.isGrabbing()).toBe(true);
  expect(dispatchNavigation).not.toHaveBeenCalled();
  expect(presentation.getViewState()).toEqual(initialViewState);
  processFrame([snapshot(true)]);
  expect(dispatchNavigation).not.toHaveBeenCalled();
  expect(presentation.getViewState()).toEqual(initialViewState);

  processFrame([snapshot(false)]);
  expect(controls.isGrabbing()).toBe(false);
  expect(dispatchNavigation).toHaveBeenCalledTimes(1);
  expect(presentation.getViewState().longitude).toBeCloseTo(0.08);
  expect(presentation.getViewState().latitude).toBeCloseTo(-0.06);

  // A ray missing either surface does not consume navigation on a new squeeze.
  dispatchNavigation.mockClear();
  processFrame([snapshot(true, new Matrix4().translate([100, 0, 0]))]);
  expect(controls.isGrabbing()).toBe(false);
  expect(dispatchNavigation).toHaveBeenCalledTimes(1);
  expect(presentation.getViewState().longitude).toBeCloseTo(0.16);

  processFrame([snapshot(false)]);
  processFrame([snapshot(true)]);
  expect(controls.isGrabbing()).toBe(true);
  dispatchNavigation.mockClear();
  // Losing the owner cancels its grab; another controller may then navigate.
  processFrame([{...snapshot(false), index: 1}]);
  expect(controls.isGrabbing()).toBe(false);
  expect(dispatchNavigation).toHaveBeenCalledTimes(1);
  expect(presentation.getViewState().longitude).toBeCloseTo(0.32);
  presentation.finalize();
});

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
