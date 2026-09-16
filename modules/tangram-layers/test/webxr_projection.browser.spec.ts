// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Matrix4} from '@math.gl/core';
import {describe, expect, it} from 'vitest';
import {
  WebXRInputAdapter,
  createXRPlacementMatrix,
  intersectXRGlobe,
  intersectXRMap,
  longitudeLatitudeToMeters,
  metersToLongitudeLatitude,
  unionGeographicBounds
} from '../src/experimental/webxr/index.js';

describe('experimental WebXR geospatial presentation', () => {
  it('round-trips Web Mercator coordinates at the equator and high latitudes', () => {
    for (const [longitude, latitude] of [[0, 0], [-74.009, 40.705], [179.9, 84.5]]) {
      const [x, y] = longitudeLatitudeToMeters(longitude, latitude);
      expect(metersToLongitudeLatitude(x, y)).toEqual([
        expect.closeTo(longitude, 8),
        expect.closeTo(latitude, 8),
        0
      ]);
    }
  });

  it('places and intersects bounded tabletop maps', () => {
    const placement = {
      type: 'map' as const,
      anchor: [-74, 40.7] as const,
      metersPerXRUnit: 1000,
      surface: {type: 'bounded' as const, width: 2, height: 1}
    };
    const placementMatrix = createXRPlacementMatrix(placement, {
      longitude: -74,
      latitude: 40.7
    });
    expect(placementMatrix).toBeInstanceOf(Matrix4);
    const inverse = new Matrix4(placementMatrix).invert();
    const anchor = longitudeLatitudeToMeters(-74, 40.7);
    const xrAnchor = new Matrix4(placementMatrix).transformAsPoint([anchor[0], anchor[1], 0]);
    const geographicPosition = intersectXRMap(
      {origin: [xrAnchor[0], xrAnchor[1] + 1, xrAnchor[2]], direction: [0, -1, 0]},
      placement,
      {longitude: -74, latitude: 40.7}
    );
    expect(inverse).toHaveLength(16);
    expect(geographicPosition?.[0]).toBeCloseTo(-74, 5);
    expect(geographicPosition?.[1]).toBeCloseTo(40.7, 5);
  });

  it('intersects a room-scale globe at its geographic anchor', () => {
    const result = intersectXRGlobe(
      {origin: [0, 0, 2], direction: [0, 0, -1]},
      {type: 'globe', anchor: [0, 0], radius: 1}
    );
    expect(result).not.toBeNull();
    expect(result?.every(Number.isFinite)).toBe(true);
    expect(result?.[0]).toBeCloseTo(0, 8);
    expect(result?.[1]).toBeCloseTo(0, 8);
  });

  it.each([[0, 0], [-74, 40.7], [150, -60]])('faces a globe anchor toward the viewer at %s, %s', (longitude, latitude) => {
    const result = intersectXRGlobe(
      {origin: [0, 0, 2], direction: [0, 0, -1]},
      {type: 'globe', anchor: [longitude, latitude], radius: 0.72}
    );
    expect(result?.[0]).toBeCloseTo(longitude, 8);
    expect(result?.[1]).toBeCloseTo(latitude, 8);
  });

  it.each([0, 40.7, 75])('preserves physical meter scale at latitude %s', (latitude) => {
    const anchor = longitudeLatitudeToMeters(-74, latitude);
    const mercatorScale = 1 / Math.cos(latitude * Math.PI / 180);
    const matrix = createXRPlacementMatrix({type: 'first-person', origin: [-74, latitude], position: [2, 3, 0]});
    const roomPosition = matrix.transformAsPoint([anchor[0] + 3 * mercatorScale,
      anchor[1] + 4 * mercatorScale, 1]);
    // Locomotion removes 2m east and 3m north; ENU maps to XR right/up/back.
    expect(roomPosition[0]).toBeCloseTo(1, 7);
    expect(roomPosition[1]).toBeCloseTo(1, 7);
    expect(roomPosition[2]).toBeCloseTo(-1, 7);
  });

  it('unions eye bounds around an antimeridian anchor', () => {
    expect(
      unionGeographicBounds(
        [
          [170, -10, 179, 10],
          [-179, -20, -170, 20]
        ],
        180
      )
    ).toEqual([170, -20, 190, 20]);
  });

  it('translates controller axes into time-scaled renderer-independent intents', () => {
    const adapter = new WebXRInputAdapter();
    expect(
      adapter.update(
        [
          {index: 0, handedness: 'left', gamepad: {axes: [0, 0, 0.5, -0.75]}},
          {index: 1, handedness: 'right', gamepad: {axes: [0, 0, 0.8, 0]}}
        ],
        0.5
      )
    ).toEqual([
      {type: 'navigate', action: 'move', delta: [0.25, 0.375], handedness: 'left'},
      {type: 'navigate', action: 'turn', delta: [15], handedness: 'right'}
    ]);
  });
});
