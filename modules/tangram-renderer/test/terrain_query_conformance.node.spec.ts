// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {TriangleBVH} from '@math.gl/geometry';
import {TriangleQueryIndex} from '../src/map-logic/triangle-query-index';

test('math.gl and the retained terrain query index agree on triangle identity, clipping and barycentric weights', () => {
    // Sloped, stacked, coincident and degenerate triangles exercise observable boundaries.
    const positions = [0, 0, 0, 2, 0, 10, 0, 2, 20, 0, 0, 100, 2, 0, 110, 0, 2, 120];
    const indices = [0, 1, 2, 3, 4, 5, 3, 4, 5, 0, 0, 0];
    const candidate = new TriangleBVH({positions, indices});
    for (const budget of [0, 1024 * 1024]) {
        const retained = new TriangleQueryIndex(positions, indices, 8, {maxHierarchyBytes: budget});
        for (const origin of [[0, 0, 200], [0.5, 0.5, 200], [2, 0, 200], [0, 2, 200], [2, 2, 200], [0.5, 0.5, -1]] as const) {
            for (const direction of [[0, 0, -2], [0, 0, 1], [0, 1, -2]] as const) {
                for (const maxDistance of [0, 50, 100, 200, Infinity]) {
                    const length = Math.hypot(...direction);
                    const legacy = retained.queryRay(origin, direction, maxDistance / length).hit;
                    const shared = candidate.intersectRay(origin, direction, {maxDistance});
                    expect(Boolean(shared)).toBe(Boolean(legacy));
                    if (!legacy || !shared) continue;
                    expect(shared.index).toBe(legacy.triangleIndex);
                    expect(shared.distance).toBeCloseTo(legacy.parameter * length, 10);
                    shared.barycentric.forEach((weight, index) => expect(weight).toBeCloseTo(legacy.barycentric[index], 10));
                }
            }
        }
    }
});

test('published math.gl accepted-hit filtering agrees with retained terrain fallback', () => {
    const positions = [0, 0, 3, 2, 0, 3, 0, 2, 3, 0, 0, 1, 2, 0, 1, 0, 2, 1];
    const indices = [0, 1, 2, 3, 4, 5, 0, 1, 2];
    const candidate = new TriangleBVH({positions, indices, leafSize: 1});
    for (const maxHierarchyBytes of [0, 1024]) {
        const retained = new TriangleQueryIndex(positions, indices, 1, {maxHierarchyBytes});
        for (const maxDistance of [0, 2, 4, Infinity]) for (const rejected of [-1, 0, 1, 2]) {
            const origin = [0.5, 0.5, 5] as const, direction = [0, 0, -7] as const;
            const expected = retained.queryRay(origin, direction, maxDistance / 7, hit => hit.triangleIndex !== rejected).hit;
            const actual = candidate.intersectRay(origin, direction, {maxDistance, acceptHit: hit => hit.index !== rejected});
            expect(actual?.index ?? null).toBe(expected?.triangleIndex ?? null);
            if (!expected || !actual) continue;
            expect(actual.distance).toBeCloseTo(expected.parameter * 7, 12);
            expect(actual.barycentric).toEqual(expected.barycentric);
        }
    }
});

test.each([1e-8, 1, 1e8])('published math.gl preserves exact hit cutoffs despite slab rounding at scale %s', scale => {
    const positions = [0, 0, 0, 0.1 * scale, 0, 0, 0, 0.1 * scale, 0];
    const candidate = new TriangleBVH({positions, leafSize: 1});
    const origin = [0.01 * scale, 0.01 * scale, 0.3 * scale] as const, direction = [0, 0, -1] as const;
    const retained = new TriangleQueryIndex(positions, [0, 1, 2], 1, {maxHierarchyBytes: 0});
    const expected = retained.queryRay(origin, direction, Infinity).hit;
    const actual = candidate.intersectRay(origin, direction);
    expect(actual).not.toBeNull();
    expect(expected).not.toBeNull();
    if (!actual || !expected) return;
    expect(actual.distance / scale).toBeCloseTo(expected.parameter / scale, 12);
    expect(candidate.intersectRay(origin, direction, {maxDistance: actual.distance})).toEqual(actual);
    expect(candidate.intersectRay(origin, direction, {maxDistance: actual.distance * (1 - Number.EPSILON)})).toBeNull();
});
