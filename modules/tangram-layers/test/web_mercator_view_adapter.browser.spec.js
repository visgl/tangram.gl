// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, it} from 'vitest';
import WebMercatorViewAdapter from '../src/web_mercator_view_adapter';

const IDENTITY_MATRIX = new Float64Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1
]);

function createViewport(overrides = {}) {
  return {
    longitude: -122.4,
    latitude: 37.8,
    zoom: 10,
    bearing: 0,
    pitch: 0,
    width: 800,
    height: 600,
    viewMatrix: IDENTITY_MATRIX,
    projectionMatrix: IDENTITY_MATRIX,
    distanceScales: {unitsPerMeter: [1, 1, 1 / 1000]},
    ...overrides
  };
}

describe('WebMercatorViewAdapter', () => {
  it('validates the public geospatial viewport contract', () => {
    expect(WebMercatorViewAdapter.validateViewport(createViewport())).toBeNull();
    expect(
      WebMercatorViewAdapter.validateViewport(createViewport({isGeospatial: false}))?.message
    ).toBe('a Web Mercator viewport is required');
    expect(
      WebMercatorViewAdapter.validateViewport(createViewport({longitude: Number.NaN}))?.message
    ).toBe('a Web Mercator viewport is required');
  });

  it('validates geographic anchors independently of the projection adapter', () => {
    expect(
      WebMercatorViewAdapter.validateGeographicAnchor(
        createViewport({latitude: Number.NaN}),
        'GlobeViewport'
      )?.message
    ).toBe('GlobeViewport requires finite longitude, latitude, and zoom');
  });

  it('converts meter-space camera coordinates to deck common space', () => {
    const camera = WebMercatorViewAdapter.getCameraFrame(createViewport());

    expect(camera.view).toHaveLength(16);
    expect(camera.view[0]).toBeCloseTo(512 / (20037508.342789244 * 2));
    expect(camera.view[5]).toBeCloseTo(512 / (20037508.342789244 * 2));
    expect(camera.view[10]).toBe(1 / 1000);
    expect(camera.view[12]).toBe(256);
    expect(camera.view[13]).toBe(256);
    expect(camera.projection).toBeInstanceOf(Float32Array);
    expect(camera.position).toEqual([0, 0, 0]);
  });

  it('builds a Tangram map frame and buffers tiles as pitch increases', () => {
    const flatFrame = WebMercatorViewAdapter.getFrame(createViewport(), {
      width: 640,
      height: 480
    });
    const pitchedFrame = WebMercatorViewAdapter.getFrame(createViewport({pitch: 45}), {
      width: 640,
      height: 480
    });

    expect(flatFrame.viewport).toEqual({width: 640, height: 480});
    expect(flatFrame.view).toEqual({longitude: -122.4, latitude: 37.8, zoom: 11});
    expect(flatFrame.projection).toEqual({type: 'web-mercator'});
    expect(flatFrame.tileBuffer).toBe(0);
    expect(pitchedFrame.tileBuffer).toBe(3);
  });

  it('rejects missing camera matrices or meter scales', () => {
    expect(() => WebMercatorViewAdapter.getCameraFrame(createViewport({viewMatrix: null}))).toThrow(
      'deck viewport camera matrices and distance scales are required'
    );
    expect(() =>
      WebMercatorViewAdapter.getCameraFrame(
        createViewport({distanceScales: {unitsPerMeter: [1, 1, Number.NaN]}})
      )
    ).toThrow('deck viewport camera matrices and distance scales are required');
  });
});
