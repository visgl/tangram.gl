// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, it} from 'vitest';
import {getGlobeViewFrame} from '../src/tangram-layer';
import {_GlobeViewport as GlobeViewport, WebMercatorViewport} from '@deck.gl/core';

const IDENTITY_MATRIX = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1
];

describe('getGlobeViewFrame', () => {
  it('forwards an optional global preload level without changing style zoom', () => {
    const ordinary = getGlobeViewFrame(createViewport(0));
    const preloaded = getGlobeViewFrame(createViewport(0), {preloadZoom: 2});
    expect(ordinary.globePreloadZoom).toBeUndefined();
    expect(preloaded.globePreloadZoom).toBe(2);
    expect(preloaded.view).toEqual(ordinary.view);
    expect(preloaded.camera).toEqual(ordinary.camera);
  });

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
    expect(frame.view.zoom).toBe(5);
    expect(frame.projection).toEqual({
      type: 'globe',
      visibleBounds: [-120, -35, 10, 72]
    });
    expect(frame.camera.view).toBeInstanceOf(Float64Array);
    expect(frame.camera.projection).toBeInstanceOf(Float32Array);
    expect(frame.camera.position).toEqual([12, -345, 6]);
    expect(frame.tileBuffer).toBe(0);
  });

  it.each([0, 40.7, 60, 85])('matches actual deck center magnification at latitude %s', latitude => {
    const options = {width: 900, height: 600, longitude: -74, latitude, zoom: 4};
    const globe = new GlobeViewport(options);
    const planar = new WebMercatorViewport(options);
    const offset = [-73.99999, latitude];
    const globeCenter = globe.project([-74, latitude]);
    const planarCenter = planar.project([-74, latitude]);
    const globeOffset = globe.project(offset);
    const planarOffset = planar.project(offset);
    expect(globeOffset[0] - globeCenter[0]).toBeCloseTo(planarOffset[0] - planarCenter[0], 5);
    expect(getGlobeViewFrame(globe).view.zoom).toBe(5);
  });

  it.each([-3, -1, 0, 3.25, 15])('preserves the source-pyramid zoom at deck zoom %s', zoom => {
    for (const latitude of [0, 60, 90]) {
      expect(getGlobeViewFrame(createViewport(latitude, zoom)).view.zoom).toBe(Math.max(0, zoom + 1));
    }
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
