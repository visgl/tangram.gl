// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {TriangleBVH} from '@math.gl/spatial-index';
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
