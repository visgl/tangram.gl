// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test} from 'vitest';
import {Ellipsoid} from '@math.gl/geospatial';
import {lngLatToWorld, worldToLngLat} from '@math.gl/web-mercator';
import {getGeographicProjectionProcedure, PROJECTION_CONSTANTS, getProjectionSurface} from '../src/scene/projection_math';
import type {GeographicProjectionPosition} from '../src/scene/projection_math';
import Geo from '../src/utils/geo';

const {mercatorRadius, earthRadius, globeRadius, maxMercatorLatitude} = PROJECTION_CONSTANTS;
const sphere = new Ellipsoid(earthRadius, earthRadius, earthRadius);
const mercator = getGeographicProjectionProcedure('web-mercator');
const globe = getGeographicProjectionProcedure('globe');
/** A small deterministic corpus exercises world copies, clipping, poles and elevation. */
const positions: GeographicProjectionPosition[] = [
  [0, 0, 0], [-73.98, 40.7, 25], [179.999999, 85, 1000], [-180, -85, -25],
  [540, 45, 123], [-541, -60, 10], [37, 90, 1000], [-100, -90, 0]
];

/** Adapt math.gl's 512-unit, north-positive world to absolute EPSG:3857 meters. */
function projectMercatorWithMath(position: GeographicProjectionPosition): number[] {
  const latitude = Math.max(-maxMercatorLatitude, Math.min(maxMercatorLatitude, position[1]));
  const [worldX, worldY] = lngLatToWorld([position[0], latitude]);
  return [(worldX / 512 - 0.5) * 2 * Math.PI * mercatorRadius,
    (worldY / 512 - 0.5) * 2 * Math.PI * mercatorRadius, position[2]];
}

/** Adapt math.gl ECEF meters (prime meridian +X) to Tangram common space (-Y). */
function projectGlobeWithMath(position: GeographicProjectionPosition): number[] {
  const [x, y, z] = sphere.cartographicToCartesian([...position]);
  return [y * globeRadius / earthRadius, -x * globeRadius / earthRadius, z * globeRadius / earthRadius];
}

/** Compare dimensions with an explicit absolute tolerance in the relevant output units. */
function expectPositionClose(actual: readonly number[], expected: readonly number[], tolerance: number): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => expect(Math.abs(value - expected[index])).toBeLessThanOrEqual(tolerance));
}

describe('renderer geographic projection boundary', () => {
  test('declares immutable domains and units without introducing a new CRS or camera', () => {
    expect(getGeographicProjectionProcedure('globe')).toBe(globe);
    expect(Object.isFrozen(globe)).toBe(true);
    expect(Object.isFrozen(mercator)).toBe(true);
    expect(mercator).toMatchObject({type: 'web-mercator', positionUnits: 'meters', latitudeLimit: maxMercatorLatitude,
      longitudePolicy: 'nearest-anchor-or-unwrapped'});
    expect(globe).toMatchObject({type: 'globe', positionUnits: 'globe-common-units', latitudeLimit: 90, longitudePolicy: 'periodic'});
  });

  test.each(positions)('Mercator CPU output conforms to math.gl for %j', (longitude, latitude, altitude) => {
    const position: GeographicProjectionPosition = [longitude, latitude, altitude];
    const projected = mercator.project(position);
    expectPositionClose(projected, projectMercatorWithMath(position), 1e-7);
    const recovered = mercator.unproject(projected);
    expectPositionClose(recovered, [longitude, Math.max(-maxMercatorLatitude, Math.min(maxMercatorLatitude, latitude)), altitude], 1e-10);
    const [expectedLongitude, expectedLatitude] = worldToLngLat([
      (projected[0] / (2 * Math.PI * mercatorRadius) + 0.5) * 512,
      (projected[1] / (2 * Math.PI * mercatorRadius) + 0.5) * 512
    ]);
    expectPositionClose(recovered, [expectedLongitude, expectedLatitude, altitude], 1e-10);
  });

  test.each(positions)('globe CPU output conforms to a math.gl sphere for %j', (longitude, latitude, altitude) => {
    const position: GeographicProjectionPosition = [longitude, latitude, altitude];
    const projected = globe.project(position);
    expectPositionClose(projected, projectGlobeWithMath(position), 1e-10);
    const recovered = globe.unproject(projected);
    const expected = sphere.cartesianToCartographic([
      -projected[1] * earthRadius / globeRadius, projected[0] * earthRadius / globeRadius, projected[2] * earthRadius / globeRadius
    ]);
    expectPositionClose(recovered, expected, 1e-7);
    expect(recovered[1]).toBeCloseTo(latitude, 8);
    expect(recovered[2]).toBeCloseTo(altitude, 7);
    // At the poles longitude is geometrically indeterminate; compare only off-pole.
    if (Math.abs(latitude) < 90) expect(Math.cos((recovered[0] - longitude) * Math.PI / 180)).toBeCloseTo(1, 12);
  });

  test('retains anchored Mercator world copies but globe longitude is periodic', () => {
    expect(mercator.project([-179, 20, 50], 179)).toEqual(mercator.project([181, 20, 50]));
    expect(mercator.unproject(mercator.project([541, 20, 50]))[0]).toBeCloseTo(541, 10);
    expectPositionClose(globe.project([181, 20, 50]), globe.project([-179, 20, 50]), 1e-12);
    expect(globe.project([181, 20, 50], 900)).toEqual(globe.project([181, 20, 50]));
  });

  test('returns fresh positions without mutating geographic or common-space inputs', () => {
    const position = Object.freeze([-73.98, 40.7, 25] as const);
    for (const procedure of [mercator, globe]) {
      const projected = Object.freeze(procedure.project(position));
      const recovered = procedure.unproject(projected);
      expect(procedure.project(position)).not.toBe(projected);
      expect(recovered).not.toBe(projected);
      expect(position).toEqual([-73.98, 40.7, 25]);
      expectPositionClose(recovered, position, 1e-7);
    }
  });

  test('does not mistake the Tangram sphere for WGS84 or convert ENU vector lengths', () => {
    expect(globe.project([0, 0, 0])).toEqual([0, -256, 0]);
    expectPositionClose(globe.project([90, 0, earthRadius]), [512, 0, 0], 1e-12);
    const position: GeographicProjectionPosition = [-73.98, 40.7, 0];
    for (const direction of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const) {
      const transformed = globe.projectVector(position, direction);
      expect(Math.hypot(...transformed)).toBeCloseTo(1, 12);
    }
    expect(mercator.projectVector(position, [2, 3, 4])).toEqual([2, 3, 4]);
  });

  test.each([-85, -40, 0, 40, 85])('globe LOD surface agrees with independent math.gl samples at %s degrees', latitude => {
    const position: GeographicProjectionPosition = [179.99, latitude, 0];
    const [x, y] = mercator.project(position);
    const surface = getProjectionSurface(x, y, 'globe');
    expectPositionClose(surface.position, projectGlobeWithMath(position), 1e-10);
    for (const [axis, derivative] of [[0, surface.derivativeX], [1, surface.derivativeY]] as const) {
      const high = mercator.unproject([x + (axis === 0 ? 1 : 0), y + (axis === 1 ? 1 : 0), 0]);
      const low = mercator.unproject([x - (axis === 0 ? 1 : 0), y - (axis === 1 ? 1 : 0), 0]);
      const upper = projectGlobeWithMath(high), lower = projectGlobeWithMath(low);
      expectPositionClose(derivative, upper.map((value, index) => (value - lower[index]) / 2), 1e-10);
    }
  });

  test('keeps geographic projection separate from north-origin tile rows and exact tile ownership', () => {
    const north = mercator.project([30, 45, 0]), south = mercator.project([30, -45, 0]);
    expect(north[1]).toBeGreaterThan(0);
    expect(Geo.tileForMeters(north, 8).y).toBeLessThan(Geo.tileForMeters(south, 8).y);
    for (const zoom of [0, 8, 20, 30]) {
      const tile = {x: 0, y: 0, z: zoom};
      const origin = Geo.metersForTile(tile);
      // Sample inside the tile: seam ownership remains the responsibility of Geo.
      const interior = [origin.x + Geo.metersPerTile(zoom) / 2, origin.y - Geo.metersPerTile(zoom) / 2];
      expect(Geo.tileForMeters(interior, zoom)).toEqual(tile);
    }
  });

  test('preserves forward rejection and documents undefined/finite inverse domains', () => {
    for (const procedure of [mercator, globe]) {
      expect(() => procedure.project([0, 91, 0])).toThrow('Projection');
      expect(() => procedure.project([NaN, 0, 0])).toThrow('Projection');
      expect(() => procedure.project([0, 0, Infinity])).toThrow('Projection');
    }
    expect(() => globe.unproject([0, 0, 0])).toThrow('Globe position');
    expect(() => globe.unproject([NaN, 0, 0])).toThrow('Globe position');
    expect(() => mercator.unproject([Infinity, 0, 0])).toThrow('Mercator position');
    expect(globe.project([0, 0, -earthRadius])).toEqual([0, -0, 0]);
    expect(() => globe.unproject(globe.project([0, 0, -earthRadius]))).toThrow('Globe position');
  });

  test.each(['albers', 'toString', '__proto__', undefined])('rejects unsupported procedure selection: %s', projection => {
    expect(() => getGeographicProjectionProcedure(projection as never)).toThrow('Unsupported geographic projection');
  });
});
