// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {intersectRayTriangle} from '@math.gl/culling/queries';
import {TriangleQueryIndex} from '../modules/tangram-renderer/src/map-logic/triangle-query-index';

/** Small separated patches with a sloped nearest layer and reversed farther winding. */
function fixture(count = 128) {
    const positions: number[] = [], indices: number[] = [];
    for (let column = 0; column < count; column++) {
        const start = positions.length / 3;
        positions.push(column * 3, 0, 0, column * 3 + 2, 0, 0, column * 3, 2, 1,
            column * 3, 0, 4, column * 3 + 2, 0, 4, column * 3, 2, 5);
        indices.push(start, start + 1, start + 2, start + 5, start + 4, start + 3);
    }
    return {positions, indices};
}

/** Independent linear oracle built directly on the upstream math.gl triangle kernel. */
function linear(positions: number[], indices: number[], origin: [number, number, number], direction: [number, number, number], maximum: number) {
    let nearest: {parameter: number; triangleIndex: number; barycentric: [number, number, number]} | null = null;
    for (let index = 0; index < indices.length; index += 3) {
        const vertex = (offset: number): [number, number, number] => {
            const start = indices[index + offset] * 3; return [positions[start], positions[start + 1], positions[start + 2]];
        };
        const hit = intersectRayTriangle(origin, direction, vertex(0), vertex(1), vertex(2), {maxT: nearest?.parameter ?? maximum});
        if (hit && (!nearest || hit.t < nearest.parameter)) nearest = {parameter: hit.t, triangleIndex: index / 3, barycentric: hit.barycentric};
    }
    return nearest;
}

test.each([{leafSize: 1}, {leafSize: 8}, {leafSize: 64}, {leafSize: 8, maxHierarchyBytes: 0}])('indexed or budget-fallback rays conform to the linear math.gl oracle: %j', ({leafSize, maxHierarchyBytes}) => {
    const {positions, indices} = fixture();
    const index = new TriangleQueryIndex(positions, indices, leafSize, {maxHierarchyBytes});
    for (const column of [-1, 0, 31, 73, 127, 128]) for (const direction of [[0, 0, -1], [0, 0, -100], [0, 0, 1], [1, 0, 0]] satisfies [number, number, number][]) {
        const origin: [number, number, number] = [column * 3 + 0.4, 0.5, 10];
        for (const maximum of [0, 0.05, 5, 6, Infinity]) expect(index.queryRay(origin, direction, maximum).hit).toEqual(linear(positions, indices, origin, direction, maximum));
    }
});

test('query work is pruned, detached geometry is stable and equal-distance ties keep original IDs', () => {
    const {positions, indices} = fixture(512);
    const index = new TriangleQueryIndex(positions, indices);
    const query = index.queryRay([700, 0.5, 10], [0, 0, -1]);
    expect(query.hit?.triangleIndex).toBe(467);
    expect(query.testedTriangles).toBeLessThan(32);
    expect(query.testedBounds).toBeLessThan(64);
    expect(index.triangleCount).toBe(1024); expect(index.arrayBytes).toBeGreaterThan(0);
    positions.fill(999); indices.fill(0);
    expect(index.queryRay([700, 0.5, 10], [0, 0, -1])).toEqual(query);
    const ties = new TriangleQueryIndex([0, 0, 0, 2, 0, 0, 0, 2, 0], [0, 1, 2, 2, 1, 0], 1);
    expect(ties.queryRay([0.5, 0.5, 1], [0, 0, -1]).hit?.triangleIndex).toBe(0);
    expect(ties.queryRay([0.5, 0.5, 0], [0, 0, 1], 0).hit?.parameter).toBe(0);
});

test('ArrayLike values are read once and the copied geometry is what gets validated', () => {
    const positions = [0, 0, 0, 2, 0, 0, 0, 2, 0], indices = [0, 1, 2];
    let positionReads = 0, indexReads = 0;
    Object.defineProperty(positions, 0, {get: () => positionReads++ === 0 ? 0 : NaN});
    Object.defineProperty(indices, 0, {get: () => indexReads++ === 0 ? 0 : NaN});
    const index = new TriangleQueryIndex(positions, indices);
    expect(positionReads).toBe(1); expect(indexReads).toBe(1);
    expect(index.queryRay([0.5, 0.5, 1], [0, 0, -1]).hit?.parameter).toBe(1);
});

test('empty, invalid and degenerate rays/triangles do not produce phantom hits', () => {
    const empty = new TriangleQueryIndex([], []);
    expect(empty.queryRay([0, 0, 0], [0, 0, 1])).toEqual({hit: null, testedBounds: 0, testedTriangles: 0});
    const index = new TriangleQueryIndex([0, 0, 0], [0, 0, 0]);
    for (const direction of [[0, 0, 0], [NaN, 0, 1], [0, 0, 1]] satisfies [number, number, number][]) expect(index.queryRay([0, 0, 1], direction).hit).toBeNull();
    expect(index.queryRay([Infinity, 0, 0], [0, 0, 1]).hit).toBeNull();
    for (const maximum of [-1, NaN]) expect(() => index.queryRay([0, 0, 0], [0, 0, 1], maximum)).toThrow();
});

test('a caller can reject an unprojectable hit without hiding a valid farther surface', () => {
    const {positions, indices} = fixture(1);
    const index = new TriangleQueryIndex(positions, indices, 1);
    expect(index.queryRay([0.5, 0.5, 10], [0, 0, -1], Infinity, candidate => candidate.triangleIndex === 0).hit?.triangleIndex).toBe(0);
    expect(index.queryRay([0.5, 0.5, 10], [0, 0, -1], Infinity, () => false).hit).toBeNull();
});

test.each([
    {positions: [0, 0], indices: [], leafSize: 8}, {positions: [0, 0, NaN], indices: [], leafSize: 8},
    {positions: [0, 0, 0], indices: [0], leafSize: 8}, {positions: [0, 0, 0], indices: [0, 0, 1], leafSize: 8},
    {positions: [0, 0, 0], indices: [0, 0, -1], leafSize: 8}, {positions: [], indices: [], leafSize: 0},
    {positions: [], indices: [], leafSize: 65}, {positions: [0, 0, 0], indices: [0, 0, 0.5], leafSize: 8}
])('invalid index rejects before publication: %j', options => {
    expect(() => new TriangleQueryIndex(options.positions, options.indices, options.leafSize)).toThrow();
});
