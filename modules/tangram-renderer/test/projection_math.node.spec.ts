// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {_GlobeViewport as GlobeViewport} from '@deck.gl/core';
import {PROJECTION_CONSTANTS, getMercatorMetersPerPixel, getProjectionSurface, projectGeographicPosition,
    projectGeographicVector, unprojectGlobePosition} from '../src/scene/projection_math';

/** Small deterministic corpus includes wrapping, poles, altitude and the origin. */
const positions = [[0, 0, 0], [179.999, 70, 100], [-180, -60, 10], [37, 90, 1000],
    [-100, -90, -10], [540, 45, 123], [-73.98, 40.7, 15]] as const;

test.each(positions)('shared projection agrees with the public GlobeViewport for %j', (longitude, latitude, altitude) => {
    const position = [longitude, latitude, altitude] as const;
    const globe = projectGeographicPosition(position, 'globe');
    const expected = new GlobeViewport({width: 512, height: 320}).projectPosition([...position]);
    globe.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 9));
    const recovered = unprojectGlobePosition(globe);
    expect(recovered[1]).toBeCloseTo(latitude, 7);
    expect(recovered[2]).toBeCloseTo(altitude, 6);
    if (Math.abs(latitude) < 90) expect(Math.sin((recovered[0] - longitude) * Math.PI / 180)).toBeCloseTo(0, 10);
});

test.each(positions)('ENU basis preserves lengths and surface orientation for %j', (longitude, latitude, altitude) => {
    const position = [longitude, latitude, altitude] as const;
    const east = projectGeographicVector(position, [1, 0, 0], 'globe');
    const north = projectGeographicVector(position, [0, 1, 0], 'globe');
    const up = projectGeographicVector(position, [0, 0, 1], 'globe');
    for (const vector of [east, north, up]) expect(Math.hypot(...vector)).toBeCloseTo(1, 12);
    for (const [left, right] of [[east, north], [east, up], [north, up]])
        expect(left.reduce((sum, value, index) => sum + value * right[index], 0)).toBeCloseTo(0, 12);
    expect(Math.hypot(...projectGeographicVector(position, [2, 3, 4], 'globe'))).toBeCloseTo(Math.sqrt(29), 12);
    const radial = projectGeographicPosition(position, 'globe');
    radial.forEach((value, index) => expect(value / Math.hypot(...radial)).toBeCloseTo(up[index], 12));
    expect(projectGeographicVector(position, [2, 3, 4], 'web-mercator')).toEqual([2, 3, 4]);
});

test.each([-85, -40, 0, 40, 85])('globe LOD differential matches finite differences at latitude %s', latitude => {
    const [x, y] = projectGeographicPosition([179.99, latitude, 0], 'web-mercator');
    const surface = getProjectionSurface(x, y, 'globe');
    const offset = 1;
    for (const [axis, derivative] of [[0, surface.derivativeX], [1, surface.derivativeY]] as const) {
        const high = getProjectionSurface(x + (axis === 0 ? offset : 0), y + (axis === 1 ? offset : 0), 'globe').position;
        const low = getProjectionSurface(x - (axis === 0 ? offset : 0), y - (axis === 1 ? offset : 0), 'globe').position;
        derivative.forEach((value, index) => expect(value).toBeCloseTo((high[index] - low[index]) / (2 * offset), 10));
    }
    expect(getProjectionSurface(x, y, 'web-mercator')).toEqual({position: [x, y, 0], derivativeX: [1, 0, 0], derivativeY: [0, 1, 0]});
});

test.each([0, 10.5, 20, 25])('style meter/pixel scale remains separate from perspective LOD at zoom %s', zoom => {
    expect(getMercatorMetersPerPixel(zoom) * 2 ** zoom).toBeCloseTo(2 * Math.PI * 6378137 / 256, 9);
});

test('planar wrapping, altitude and polar clamping retain the existing meter convention', () => {
    expect(projectGeographicPosition([-179, 20, 50], 'web-mercator', 179)).toEqual(projectGeographicPosition([181, 20, 50], 'web-mercator'));
    expect(projectGeographicPosition([0, 90, 50], 'web-mercator')[1]).toBeCloseTo(Math.PI * PROJECTION_CONSTANTS.mercatorRadius, 5);
    expect(projectGeographicPosition([0, -90, 50], 'web-mercator')[2]).toBe(50);
    expect(Object.isFrozen(PROJECTION_CONSTANTS)).toBe(true);
});

test.each([[0, 91, 0], [0, 0, Infinity], [NaN, 0, 0]] as const)('invalid geographic coordinates fail: %j', (longitude, latitude, altitude) => {
    expect(() => projectGeographicPosition([longitude, latitude, altitude], 'globe')).toThrow('Projection');
});

test.each([[0, 0, 0], [NaN, 0, 1]] as const)('undefined globe inverse fails: %j', (x, y, z) => {
    expect(() => unprojectGlobePosition([x, y, z])).toThrow('Globe position');
});
