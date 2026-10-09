// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Matrix4} from '@math.gl/core';
import {describe, expect, test} from 'vitest';
import {calculatePlanarGroundBounds, calculatePlanarVolumeBounds} from '../src/scene/ground_footprint';
import type {HostCamera} from '../src/types';

function camera(view = new Matrix4(), projection = new Matrix4()): HostCamera {
    return {view, projection, position: [0, 0, 0]};
}

describe('finite planar ground footprint', () => {
    test('height slab includes elevated-only visibility and preserves the ground-only default', () => {
        const input = camera(new Matrix4().translate([0, 0, -10]));
        expect(calculatePlanarGroundBounds(input)).toBeNull();
        expect(calculatePlanarVolumeBounds(input, [9, 11])).toEqual({sw: {x: -1, y: -1}, ne: {x: 1, y: 1}});
        expect(calculatePlanarVolumeBounds(input, [0, 8])).toBeNull();
        expect(calculatePlanarVolumeBounds(input, [12, 20])).toBeNull();
        expect(calculatePlanarVolumeBounds(camera(), [0, 0])).toEqual(calculatePlanarGroundBounds(camera()));
    });

    test('includes interior slab extrema, negative heights and clipped stereo-eye unions without mutating cameras', () => {
        const input = camera(new Matrix4().rotateX(Math.PI / 4).translate([0, 0, -10]));
        const original = Array.from(input.view);
        const bounds = calculatePlanarVolumeBounds(input, [8, 12]);
        expect(bounds).not.toBeNull();
        expect(bounds!.ne.y - bounds!.sw.y).toBeGreaterThan(2);
        expect(calculatePlanarVolumeBounds(input, [8, 12], {sw: {x: -0.5, y: -0.5}, ne: {x: 0.5, y: 0.5}}))
            .toEqual({sw: {x: -0.5, y: -0.5}, ne: {x: 0.5, y: 0.5}});
        expect(Array.from(input.view)).toEqual(original);
        expect(calculatePlanarVolumeBounds(camera(new Matrix4().translate([0, 0, 10])), [-11, -9])).not.toBeNull();
        const left = calculatePlanarVolumeBounds(camera(new Matrix4().translate([1, 0, -10])), [9, 11]);
        const right = calculatePlanarVolumeBounds(camera(new Matrix4().translate([-1, 0, -10])), [9, 11]);
        expect(left?.sw.x).toBe(-2);
        expect(right?.ne.x).toBe(2);
    });

    test.each([[1, 0], [NaN, 0], [0, Infinity]])('rejects invalid elevation ranges %j', (minimum, maximum) => {
        expect(() => calculatePlanarVolumeBounds(camera(), [minimum, maximum])).toThrow('finite ordered heights');
    });
    test('intersects a frustum whose ground hits lie on near/far plane edges, not corner rays', () => {
        // At the horizon, no upper ray hits ground. Finite edge intersections still bound it.
        const view = new Matrix4().lookAt({eye: [0, 0, 2], center: [0, 10, 2], up: [0, 0, 1]});
        const projection = new Matrix4().perspective({fovy: Math.PI / 3, aspect: 2, near: 1, far: 20});
        const bounds = calculatePlanarGroundBounds(camera(view, projection));
        expect(bounds).not.toBeNull();
        expect(bounds?.ne.y).toBeCloseTo(20, 8);
        expect(bounds?.sw.y).toBeCloseTo(2 / Math.tan(Math.PI / 6), 8);
        expect(bounds?.ne.x).toBeCloseTo(40 * Math.tan(Math.PI / 6), 8);
    });

    test('clips the polygon before bounding instead of clamping a disjoint rectangle', () => {
        const bounds = calculatePlanarGroundBounds(camera(), {sw: {x: 0, y: 0}, ne: {x: 0.5, y: 0.7}});
        expect(bounds).toEqual({sw: {x: 0, y: 0}, ne: {x: 0.5, y: 0.7}});
        expect(calculatePlanarGroundBounds(camera(), {sw: {x: 2, y: 2}, ne: {x: 3, y: 3}})).toBeNull();
        const rotated = camera(new Matrix4().rotateZ(Math.PI / 4));
        expect(calculatePlanarGroundBounds(rotated, {sw: {x: 1, y: 1}, ne: {x: 2, y: 2}})).toBeNull();
    });

    test('handles coplanar edges and returns no area for a tangential or sky-only frustum', () => {
        expect(calculatePlanarGroundBounds(camera(new Matrix4().translate([0, 0, 1])))).not.toBeNull();
        expect(calculatePlanarGroundBounds(camera(new Matrix4().translate([0, 0, 2])))).toBeNull();
        expect(calculatePlanarGroundBounds(camera(), {sw: {x: 1, y: 1}, ne: {x: 2, y: 2}})).toBeNull();
    });

    test('does not mutate input matrices or clipping limits', () => {
        const input = camera();
        const limits = {sw: {x: -0.5, y: -0.5}, ne: {x: 0.5, y: 0.5}};
        const original = JSON.stringify({input, limits});
        calculatePlanarGroundBounds(input, limits);
        expect(JSON.stringify({input, limits})).toBe(original);
    });

    test('accepts typed host matrices without silently replacing them with identity', () => {
        const view = new Matrix4().lookAt({eye: [100, 200, 2], center: [100, 210, 2], up: [0, 0, 1]});
        const projection = new Matrix4().perspective({fovy: Math.PI / 3, aspect: 2, near: 1, far: 20});
        const expected = calculatePlanarGroundBounds(camera(view, projection));
        const actual = calculatePlanarGroundBounds({view: new Float64Array(view),
            projection: new Float32Array(projection), position: [0, 0, 0]});
        if (!actual || !expected) throw new Error('The horizon fixture must intersect ground');
        expect(actual.sw.x).toBeCloseTo(expected.sw.x, 4);
        expect(actual.ne.y).toBeCloseTo(expected.ne.y, 4);
    });

    test('rejects malformed, singular, infinite-far and invalid-limit inputs', () => {
        const singular = new Matrix4();
        singular.fill(0);
        expect(() => calculatePlanarGroundBounds(camera(singular))).toThrow(/singular/);
        const invalid = new Matrix4();
        invalid[0] = Number.NaN;
        expect(() => calculatePlanarGroundBounds(camera(invalid))).toThrow(/finite camera/);
        expect(() => calculatePlanarGroundBounds(camera(undefined,
            new Matrix4().perspective({fovy: 1, aspect: 1, near: 1, far: Infinity})))).toThrow(/finite near and far/);
        expect(() => calculatePlanarGroundBounds(camera(), {sw: {x: 2, y: 0}, ne: {x: 1, y: 1}})).toThrow(/ordered/);
        expect(() => calculatePlanarGroundBounds(camera(), {sw: {x: 0, y: 0}, ne: {x: Infinity, y: 1}})).toThrow(/finite ordered/);
    });
});
