// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {FirstPersonViewport} from '@deck.gl/core';
import {describe, expect, test} from 'vitest';
import {getFirstPersonViewFrame} from '../src/tangram-layer';

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
  test('derives a Tangram frame from the visible ground footprint', () => {
    const frame = getFirstPersonViewFrame(createViewport());

    expect(frame.viewport).toEqual({width: 800, height: 600});
    expect(frame.view.altitude).toBe(600);
    expect(frame.view.zoom).toBeGreaterThan(14);
    expect(frame.camera.view).toHaveLength(16);
    expect(frame.camera.projection).toHaveLength(16);
  });

  test('uses projected Web Mercator meters for high-latitude LOD', () => {
    const equatorFrame = getFirstPersonViewFrame(createViewport({latitude: 0}));
    const highLatitudeFrame = getFirstPersonViewFrame(createViewport({latitude: 60}));

    expect(equatorFrame.view.zoom - highLatitudeFrame.view.zoom).toBeCloseTo(1, 2);
  });

  test('keeps a footprint crossing the antimeridian local to the camera', () => {
    const ordinaryFrame = getFirstPersonViewFrame(createViewport({longitude: 0}));
    const antimeridianFrame = getFirstPersonViewFrame(createViewport({longitude: 179.99}));

    expect(antimeridianFrame.view.zoom).toBeCloseTo(ordinaryFrame.view.zoom, 5);
    expect(Math.abs(antimeridianFrame.view.longitude)).toBeGreaterThan(179);
    expect(Math.abs(antimeridianFrame.view.longitude)).toBeLessThanOrEqual(180);
  });

  test('rejects footprints that cross the camera horizon', () => {
    expect(() => getFirstPersonViewFrame(createViewport({pitch: 30}))).toThrow(
      /must intersect the ground plane/
    );
  });
});
