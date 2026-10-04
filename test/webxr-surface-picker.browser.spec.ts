// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, expect, test, vi} from 'vitest';
import {Matrix4} from '@math.gl/core';
import {WebXRPresentation, WebXRMapView, WebXRInputAdapter, createXRPlacementMatrix,
  type XRSurfacePickingOptions} from '@vis.gl/tangram-layers/experimental/webxr';
import {createSurfacePicker} from '../examples/webxr/surface-picking.js';

afterEach(() => vi.restoreAllMocks());

test('either CSS-pixel stereo half selects the same surface without intercepting navigation', () => {
  const canvas = document.createElement('canvas');
  canvas.width = 1600;
  canvas.height = 800;
  const output = document.createElement('p');
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 50, 800, 400));
  const presentation = new WebXRPresentation({view: new WebXRMapView(), mode: 'stereo-preview',
    viewState: {longitude: -74, latitude: 40, zoom: 14, pitch: 45}});
  const frame = presentation.createFrame({width: 800, height: 400});
  const context = {placement: presentation.placement, frame};
  const picker = createSurfacePicker({canvas, output, getContext: () => context});
  for (const clientX of [300, 700]) {
    const event = new MouseEvent('click', {clientX, clientY: 250, cancelable: true});
    expect(canvas.dispatchEvent(event)).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(output.textContent).toContain('40.00000°, -74.00000°');
  }
  picker.destroy();
  output.textContent = 'Disposed';
  canvas.dispatchEvent(new MouseEvent('click', {clientX: 300, clientY: 250}));
  expect(output.textContent).toBe('Disposed');
});

test('XR select uses the actual animated room placement snapshot; desktop clicks are ignored in VR', () => {
  const canvas = document.createElement('canvas');
  const output = document.createElement('p');
  const placement = {type: 'map' as const, anchor: [0, 0] as const, metersPerXRUnit: 1000};
  const presentation = new WebXRPresentation({view: new WebXRMapView(), placement,
    viewState: {longitude: 0, latitude: 0, zoom: 14}});
  const frame = presentation.createFrame({width: 800, height: 400});
  frame.mode = 'immersive-vr';
  const context = {placement, frame, placementMatrix: new Matrix4().translate([3, 0, 0])
    .multiplyRight(createXRPlacementMatrix(placement))};
  const picker = createSurfacePicker({canvas, output, getContext: () => context});
  const intents = new WebXRInputAdapter().update([{index: 0, handedness: 'left', selectActive: true,
    targetRayMatrix: new Matrix4().translate([3, 1, 0]).rotateX(-Math.PI / 2)}]);
  const selectedIntent = intents.find(intent => intent.type === 'point' && intent.action === 'select');
  if (selectedIntent?.type !== 'point') throw new Error('Expected a controller select intent');
  expect(picker.select(selectedIntent.pointer)?.coordinate[0]).toBeCloseTo(0, 7);
  const selected = output.textContent;
  canvas.dispatchEvent(new MouseEvent('click', {clientX: 0, clientY: 0}));
  expect(output.textContent).toBe(selected);
  picker.destroy();
});

test('missing frames, misses, and optional readout are safe; state is supplied afresh', () => {
  let context: Omit<XRSurfacePickingOptions, 'pointer'> | null = null;
  const output = document.createElement('p');
  const picker = createSurfacePicker({canvas: document.createElement('canvas'), output,
    getContext: () => context});
  expect(picker.select({x: 20, y: 20})).toBeNull();
  expect(output.textContent).toBe('No basemap surface at this pointer.');
  context = {placement: {type: 'map', anchor: [20, 30], metersPerXRUnit: 1000}};
  expect(picker.select({origin: [0, 1, 0], direction: [0, -1, 0]})?.coordinate[0]).toBeCloseTo(20, 7);
  expect(output.textContent).toContain('30.00000°, 20.00000°');
  expect(picker.select({origin: [0, 1, 0], direction: [0, 1, 0]})).toBeNull();
  const invisible = createSurfacePicker({canvas: document.createElement('canvas'), output: null,
    getContext: () => context});
  expect(invisible.select({origin: [0, 1, 0], direction: [0, -1, 0]})).not.toBeNull();
  invisible.destroy();
  picker.destroy();
});
