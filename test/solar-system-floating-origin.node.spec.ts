// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {
  MAX_STEP_PX,
  float32Spacing,
  isCameraIdle,
  shiftCameras,
  shouldRebase
} from '../examples/layers/basemap-solar-system/scene/floating-origin';
import type {V3} from '../examples/layers/basemap-solar-system/celestial';

test('float32 spacing is the float32 step next to a value', () => {
  expect(float32Spacing(1)).toBe(2 ** -23);
  expect(float32Spacing(1.999)).toBe(2 ** -23);
  expect(float32Spacing(2)).toBe(2 ** -22);
  expect(float32Spacing(-4500)).toBe(2 ** -11);
  expect(float32Spacing(0)).toBe(2 ** -149);
  for (const value of [3, 300, 4500, 0.37, 2 ** 20 - 1]) {
    const step = float32Spacing(value);
    expect(Math.fround(value + step) - Math.fround(value)).toBe(step);
  }
});

test('the camera is idle only when no gesture and no transition runs', () => {
  expect(isCameraIdle({})).toBe(true);
  expect(isCameraIdle({isDragging: false, isPanning: false, isRotating: false, isZooming: false, inTransition: false})).toBe(true);
  for (const flag of ['isDragging', 'isPanning', 'isRotating', 'isZooming', 'inTransition'] as const) {
    expect(isCameraIdle({[flag]: true})).toBe(false);
  }
});

test('the origin moves only when the camera is idle and float32 steps at the target are too large', () => {
  const pixelSize = 1e-6;
  // 1 unit from the origin: steps of 1.2e-7, 0.12 px, more than MAX_STEP_PX.
  expect(shouldRebase([1, 0, 0], pixelSize, true)).toBe(true);
  expect(shouldRebase([1, 0, 0], pixelSize, false)).toBe(false);
  // Close to the origin, or a large pixel: no rebase.
  expect(shouldRebase([0.1, 0, 0], pixelSize, true)).toBe(false);
  expect(shouldRebase([0, 0, 0], pixelSize, true)).toBe(false);
  expect(shouldRebase([1, 0, 0], 1, true)).toBe(false);
  // The largest component sets the step.
  expect(shouldRebase([0, 0, -1], pixelSize, true)).toBe(true);
  // The threshold is MAX_STEP_PX of a pixel.
  const offset = 3;
  const step = float32Spacing(offset);
  expect(shouldRebase([offset, 0, 0], (step / MAX_STEP_PX) * 1.01, true)).toBe(false);
  expect(shouldRebase([offset, 0, 0], (step / MAX_STEP_PX) * 0.99, true)).toBe(true);
});

test('a rebase shifts all cameras by the origin change and keeps absolute positions', () => {
  const origin: V3 = [10, -20, 5];
  const next: V3 = [12.5, -19, 4];
  const delta: V3 = [next[0] - origin[0], next[1] - origin[1], next[2] - origin[2]];
  const overview = {target: [3, 4, 5] as V3, zoom: 7, rotationOrbit: 30};
  const camera = {eye: [1, 2, 3] as V3, target: [4, 5, 6] as V3, up: [0, 0, 1] as V3};
  const shifted = shiftCameras(delta, overview, camera);
  const absolute = (p: V3, o: V3) => p.map((v, i) => v + o[i]);
  expect(absolute(shifted.overview.target, next)).toEqual(absolute(overview.target, origin));
  expect(absolute(shifted.camera!.eye, next)).toEqual(absolute(camera.eye, origin));
  expect(absolute(shifted.camera!.target, next)).toEqual(absolute(camera.target, origin));
  expect(shifted.camera!.up).toEqual(camera.up);
  expect(shifted.overview.zoom).toBe(7);
  expect(shiftCameras(delta, overview, null).camera).toBeNull();
  // The inputs do not change.
  expect(overview.target).toEqual([3, 4, 5]);
});

test('a rebase removes the transition props of the OrbitView state', () => {
  // A smooth wheel zoom leaves these props in the stored view state. Kept, deck.gl starts a
  // transition from the view state of the old frame to the shifted one.
  const overview = {target: [1, 2, 3] as V3, zoom: 2, transitionDuration: 250, transitionInterpolator: {}};
  const shifted = shiftCameras([1, 1, 1], overview, null).overview;
  expect('transitionDuration' in shifted).toBe(false);
  expect('transitionInterpolator' in shifted).toBe(false);
  expect(shifted).toEqual({target: [0, 1, 2], zoom: 2});
});
