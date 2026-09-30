// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, it} from 'vitest';
import {getGlobeViewFrame} from '../src/tangram-layer';

const IDENTITY_MATRIX = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1
];

describe('getGlobeViewFrame', () => {
  it('copies host elevation bounds without replacing the camera altitude', () => {
    const visibleBounds = [-170, -80, 170, 80];
    const frame = getGlobeViewFrame(createViewport(0), {maxElevation: 3000, visibleBounds});
    visibleBounds[0] = 0;
    expect(frame.projection).toEqual({type: 'globe', visibleBounds: [-170, -80, 170, 80], maxElevation: 3000});
    expect(frame.camera.position).toEqual([12, -345, 6]);
    expect(getGlobeViewFrame(createViewport(0), {maxElevation: 0}).projection.maxElevation).toBe(0);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid maximum height %s', maxElevation => {
    expect(() => getGlobeViewFrame(createViewport(0), {maxElevation})).toThrow(/maxElevation/);
  });

  it('preserves deck globe matrices and geographic visibility', () => {
    const viewport = createViewport(40.7);

    const frame = getGlobeViewFrame(viewport);

    expect(frame.viewport).toEqual({width: 900, height: 600});
    expect(frame.view.longitude).toBe(-74);
    expect(frame.view.latitude).toBe(40.7);
    expect(frame.view.zoom).toBeCloseTo(
      4 - Math.log2(Math.PI * Math.cos((40.7 * Math.PI) / 180)) + 1
    );
    expect(frame.projection).toEqual({
      type: 'globe',
      visibleBounds: [-120, -35, 10, 72]
    });
    expect(frame.camera.view).toBeInstanceOf(Float64Array);
    expect(frame.camera.projection).toBeInstanceOf(Float32Array);
    expect(frame.camera.position).toEqual([12, -345, 6]);
    expect(frame.tileBuffer).toBe(0);
  });

  it('matches the latitude-dependent scale used by deck GlobeViewport', () => {
    const equatorFrame = getGlobeViewFrame(createViewport(0));
    const midLatitudeFrame = getGlobeViewFrame(createViewport(60));
    const northPoleFrame = getGlobeViewFrame(createViewport(90));
    const mercatorLimitFrame = getGlobeViewFrame(createViewport(85.05112878));
    const minimumZoomFrame = getGlobeViewFrame(createViewport(0, 0));

    expect(midLatitudeFrame.view.zoom - equatorFrame.view.zoom).toBeCloseTo(1);
    expect(northPoleFrame.view.zoom).toBeCloseTo(mercatorLimitFrame.view.zoom);
    expect(minimumZoomFrame.view.zoom).toBe(0);
  });

  it('rejects incomplete globe viewports', () => {
    expect(() => getGlobeViewFrame({})).toThrow(/matrices.*size.*visible bounds/);
    expect(() =>
      getGlobeViewFrame({
        width: 900,
        height: 600,
        cameraPosition: [0, 0, 0],
        viewMatrix: IDENTITY_MATRIX,
        projectionMatrix: IDENTITY_MATRIX,
        getBounds: () => [Number.NaN, -35, 10, 72]
      })
    ).toThrow(/finite geographic bounds/);
    expect(() =>
      getGlobeViewFrame({
        width: 900,
        height: 600,
        cameraPosition: [0, Number.NaN, 0],
        viewMatrix: IDENTITY_MATRIX,
        projectionMatrix: IDENTITY_MATRIX,
        getBounds: () => [-120, -35, 10, 72]
      })
    ).toThrow(/camera position/);
  });
});

function createViewport(latitude, zoom = 4) {
  return {
    width: 900,
    height: 600,
    longitude: -74,
    latitude,
    zoom,
    cameraPosition: [12, -345, 6],
    viewMatrix: IDENTITY_MATRIX,
    projectionMatrix: IDENTITY_MATRIX,
    getBounds: () => [-120, -35, 10, 72]
  };
}
