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
  it('preserves deck globe matrices and geographic visibility', () => {
    const viewport = {
      width: 900,
      height: 600,
      longitude: -74,
      latitude: 40.7,
      zoom: 4,
      cameraPosition: [12, -345, 6],
      viewMatrix: IDENTITY_MATRIX,
      projectionMatrix: IDENTITY_MATRIX,
      getBounds: () => [-120, -35, 10, 72]
    };

    const frame = getGlobeViewFrame(viewport);

    expect(frame.viewport).toEqual({width: 900, height: 600});
    expect(frame.view).toEqual({longitude: -74, latitude: 40.7, zoom: 5});
    expect(frame.projection).toEqual({
      type: 'globe',
      visibleBounds: [-120, -35, 10, 72]
    });
    expect(frame.camera.view).toBeInstanceOf(Float64Array);
    expect(frame.camera.projection).toBeInstanceOf(Float32Array);
    expect(frame.camera.position).toEqual([12, -345, 6]);
    expect(frame.tileBuffer).toBe(0);
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
