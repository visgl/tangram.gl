// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {
  CIRCUMFERENCE_METERS,
  HALF_CIRCUMFERENCE_METERS,
  MERCATOR_RADIUS,
  TILE_SIZE,
  latLngToMeters,
  metersForTile,
  metersPerPixel,
  metersPerTile,
  metersToLatLng,
  tileForMeters,
  wrapTile
} from '@tangram.gl/map-utils/web-mercator';
import {describe, expect, test} from 'vitest';

describe('Web Mercator', () => {
  test('matches the reference radius, tile size and zoom scales', () => {
    expect(MERCATOR_RADIUS).toBe(6378137);
    expect(TILE_SIZE).toBe(256);
    expect(HALF_CIRCUMFERENCE_METERS).toBe(20037508.342789244);
    expect(CIRCUMFERENCE_METERS).toBe(40075016.68557849);
    expect(metersPerPixel(0)).toBe(156543.03392804097);
    expect(metersPerPixel(3)).toBe(19567.87924100512);
    expect(metersPerTile(0)).toBe(40075016.68557849);
    expect(metersPerTile(3)).toBe(5009377.085697311);
    expect(metersPerPixel(4.5)).toBeCloseTo(6918.290052377097, 10);
    expect(metersPerTile(4.5)).toBeCloseTo(1771082.2534085368, 8);
  });

  test.each([
    [{x: 0, y: 0, z: 0}, {x: -20037508.342789244, y: 20037508.342789244}],
    [{x: 1, y: 1, z: 1}, {x: 0, y: -0}],
    [{x: 7, y: 2, z: 3}, {x: 15028131.257091936, y: 10018754.171394622}],
    [{x: 11, y: -2, z: 3}, {x: 35065639.59988117, y: 30056262.514183864}]
  ])('converts tile %j to and from its northwest corner', (tile, meters) => {
    expect(metersForTile(tile)).toStrictEqual(meters);
    expect(tileForMeters([meters.x, meters.y], tile.z)).toEqual(tile);
    expect(tileForMeters([meters.x + 1, meters.y - 1], tile.z)).toEqual(tile);
  });

  test('accepts Tangram world extent overrides', () => {
    const tile = {x: 3, y: -1, z: 2};
    expect(metersPerTile(2, 32)).toBe(8);
    expect(metersForTile(tile, 32, 20)).toEqual({x: 4, y: 28});
    expect(tileForMeters([4, 28], 2, 32, 20)).toEqual(tile);
  });

  test('wraps negative and overflow tile indices on the requested axes', () => {
    const tile = {x: -9, y: 9, z: 3};
    expect(wrapTile(tile)).toEqual({x: 7, y: 9, z: 3});
    expect(wrapTile(tile, {x: false, y: true})).toEqual({x: -9, y: 1, z: 3});
    expect(wrapTile(tile, {x: true, y: true})).toEqual({x: 7, y: 1, z: 3});
    expect(wrapTile(tile, {x: false, y: false})).toEqual(tile);
    expect(wrapTile({x: 8, y: -1, z: 3})).toEqual({x: 0, y: -1, z: 3});
    expect(wrapTile({x: -10, y: 10, z: 0}, {x: true, y: true})).toEqual({x: 0, y: 0, z: 0});
    expect(tile).toEqual({x: -9, y: 9, z: 3});
  });

  test('projects an interior position and inverts it without mutating the inputs', () => {
    const lngLat = [-122.4194, 37.7749] as const;
    const meters = latLngToMeters(lngLat);
    expect(meters[0]).toBeCloseTo(-13627665.271218073, 7);
    expect(meters[1]).toBeCloseTo(4547675.354340557, 7);
    const roundTrip = metersToLatLng(meters);
    expect(roundTrip[0]).toBeCloseTo(lngLat[0], 12);
    expect(roundTrip[1]).toBeCloseTo(lngLat[1], 12);
    expect(lngLat).toEqual([-122.4194, 37.7749]);
    expect(meters).toEqual(latLngToMeters(lngLat));
  });

  test('preserves tile-edge rounding and unwrapped world copies', () => {
    const equator = latLngToMeters([540, 0]);
    expect(equator[0]).toBe(60112525.028367735);
    expect(equator[1]).toBeCloseTo(-7.081154551613623e-10, 19);
    expect(metersToLatLng(equator)).toEqual([540, 0]);
    expect(latLngToMeters([180, 85.0511287798066])[0]).toBe(20037508.342789244);
    expect(tileForMeters(latLngToMeters([0, 0]), 1)).toEqual({x: 1, y: 1, z: 1});
    expect(latLngToMeters([0, -90])).toEqual([0, -Infinity]);
    expect(metersToLatLng([0, -Infinity])).toEqual([0, -90]);
    expect(() => latLngToMeters([0, 91])).toThrow('invalid latitude');
  });
});
