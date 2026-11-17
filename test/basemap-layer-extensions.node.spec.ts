// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test} from 'vitest';
import {
  getBuildingFilterValue,
  getCircle,
  NOT_A_BUILDING
} from '../examples/layers/basemap-layer-extensions/extension-props';

describe('getBuildingFilterValue', () => {
  test('returns the render height of a building', () => {
    expect(getBuildingFilterValue({properties: {layerName: 'building', render_height: 42}})).toBe(42);
  });

  test('returns 0 for a building without a height', () => {
    expect(getBuildingFilterValue({properties: {layerName: 'building'}})).toBe(0);
    expect(getBuildingFilterValue({properties: {layerName: 'building', render_height: null}})).toBe(0);
  });

  test('keeps all other features in the filter range', () => {
    expect(getBuildingFilterValue({properties: {layerName: 'transportation', render_height: 5}})).toBe(
      NOT_A_BUILDING
    );
    // The background sublayer has no features of a source layer.
    expect(getBuildingFilterValue({})).toBe(NOT_A_BUILDING);
    expect(getBuildingFilterValue(null)).toBe(NOT_A_BUILDING);
  });
});

describe('getCircle', () => {
  test('returns a closed ring at the radius around the center', () => {
    const ring = getCircle([0, 60], 1000);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    // At 60 degrees latitude, a degree of longitude is half as long as a degree of latitude.
    const east = ring[0];
    const north = ring[ring.length / 4 | 0];
    expect(east[0] / (north[1] - 60)).toBeCloseTo(2, 5);
    expect(north[1] - 60).toBeCloseTo(1000 / 111_320, 8);
  });
});
