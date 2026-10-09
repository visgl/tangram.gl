// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {FirstPersonViewport} from '@deck.gl/core';
import {describe, expect, test} from 'vitest';
import {getFirstPersonViewFrame} from '../src/tangram-layer';
import {Matrix4} from '@math.gl/core';
import {calculatePlanarGroundBounds} from '@vis.gl/tangram-renderer/core';

function createViewport({latitude = 40.705319, longitude = -74.009764, pitch = 60} = {}) {
  return new FirstPersonViewport({
    width: 800,
    height: 600,
    longitude,
    latitude,
    position: [0, 0, 600],
    bearing: 0,
    pitch,
    far: 20000
  });
}

describe('getFirstPersonViewFrame', () => {
  test.each([0, 60])('elevation slab retains sky-facing buildings at latitude %s without changing the eye', latitude => {
    const viewport = createViewport({pitch: -80, latitude});
    const ground = getFirstPersonViewFrame(viewport);
    const elevated = getFirstPersonViewFrame(viewport, {elevationRange: [0, 1500]});
    expect(ground.projection.visibleBounds).toBeNull();
    expect(elevated.projection.visibleBounds).not.toBeNull();
    expect(elevated.camera).toEqual(ground.camera);
    expect(elevated.view.altitude).toBeCloseTo(ground.view.altitude, 6);
    expect(elevated.projection.visibleBounds.every(Number.isFinite)).toBe(true);
  });
  test('derives a Tangram frame from the visible ground footprint', () => {
    const frame = getFirstPersonViewFrame(createViewport());

    expect(frame.viewport).toEqual({width: 800, height: 600});
    expect(frame.view.altitude).toBeCloseTo(600, 6);
    expect(frame.view.zoom).toBeGreaterThan(14);
    expect(frame.camera.view).toHaveLength(16);
    expect(frame.camera.projection).toHaveLength(16);
  });

  test('uses projected Web Mercator meters for high-latitude LOD', () => {
    const equatorFrame = getFirstPersonViewFrame(createViewport({latitude: 0}));
    const highLatitudeFrame = getFirstPersonViewFrame(createViewport({latitude: 60}));

    expect(equatorFrame.view.zoom - highLatitudeFrame.view.zoom).toBeCloseTo(1, 2);
  });

  test.each([179.99, -179.99])('keeps a footprint crossing the antimeridian local at %s', longitude => {
    const ordinaryFrame = getFirstPersonViewFrame(createViewport({longitude: 0}));
    const antimeridianFrame = getFirstPersonViewFrame(createViewport({longitude}));

    expect(antimeridianFrame.view.zoom).toBeCloseTo(ordinaryFrame.view.zoom, 5);
    expect(Math.abs(antimeridianFrame.view.longitude)).toBeGreaterThan(179);
    expect(Math.abs(antimeridianFrame.view.longitude)).toBeLessThanOrEqual(180);
  });

  test.each([30, 0, -15])('bounds horizon-crossing footprints at pitch %s', pitch => {
    const frame = getFirstPersonViewFrame(createViewport({pitch}));
    expect(frame.projection.visibleBounds).not.toBeNull();
    expect(frame.projection.visibleBounds.every(Number.isFinite)).toBe(true);
    expect(frame.view.zoom).toBeGreaterThan(8);
    expect(frame.view.zoom).toBeLessThan(20);
  });

  test('supplies empty visibility when the finite frustum does not hit ground', () => {
    const frame = getFirstPersonViewFrame(createViewport({pitch: -80}));
    expect(frame.projection).toEqual({type: 'web-mercator', visibleBounds: null});
    expect(Number.isFinite(frame.view.zoom)).toBe(true);
  });

  test.each([0, -1, Number.NaN, Infinity])('rejects invalid ground extent %s', maxGroundExtent => {
    expect(() => getFirstPersonViewFrame(createViewport(), {maxGroundExtent})).toThrow(/maxGroundExtent/);
  });

  test.each([0, 60])('clips horizon bounds to a local-meter extent at latitude %s without altering matrices', latitude => {
    const viewport = createViewport({latitude, pitch: 0, longitude: 179.99});
    const originalView = Array.from(viewport.viewMatrix);
    const frame = getFirstPersonViewFrame(viewport, {maxGroundExtent: 1500});
    const bounds = calculatePlanarGroundBounds(frame.camera);
    const eye = new Matrix4().copy(frame.camera.view).invert().transformAsPoint([0, 0, 0]);
    const extent = 1500 / Math.cos(latitude * Math.PI / 180);
    const visibleBounds = frame.projection.visibleBounds;
    expect(visibleBounds[2] - visibleBounds[0]).toBeLessThan(0.06);
    const mercatorX = longitude => longitude / 180 * 20037508.342789244;
    expect(mercatorX(visibleBounds[0])).toBeGreaterThanOrEqual(eye[0] - extent - 1e-6);
    expect(mercatorX(visibleBounds[2])).toBeLessThanOrEqual(eye[0] + extent + 1e-6);
    expect(bounds.ne.x - bounds.sw.x).toBeGreaterThan(extent * 2);
    expect(Array.from(viewport.viewMatrix)).toEqual(originalView);
  });
});
