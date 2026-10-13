// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {DrapedTerrainSurfaceSnapshot, type DrapedTerrainQueryMesh} from '../src/selection/draped-terrain-surface';
import {getGeographicProjectionProcedure} from '../src/scene/projection_math';

/** Tiny ground topology whose authored Z remains distinct from physical DEM height. */
function ground(): DrapedTerrainQueryMesh {
    return {positions: new Float64Array([-10, -10, 3, 10, -10, 3, -10, 10, 3]),
        heights: new Float32Array([100, 0, 100, 0, 100, 0]), indices: new Uint16Array([0, 1, 2]), bounds: [-10, -10, 10, 10]};
}

test('ground queries use the final triangles and morph, preserving physical heights under visual exaggeration', () => {
    const mesh = ground();
    const ray = {origin: [0, -1, 500] as const, direction: [0, 0, -2] as const};
    const first = new DrapedTerrainSurfaceSnapshot('web-mercator', [{id: 'ground', mesh, blend: 0.5}], 4, 100, 2);
    expect(first.getStatistics()).toMatchObject({preparedMeshes: 0, projectedBytes: 0, projectionBuilds: 0});
    expect(first.intersectRay(ray)).toMatchObject({position: [0, -1, 103], coordinate: [expect.any(Number), expect.any(Number), 53], surfaceId: 'ground'});
    expect(first.inputBytes).toBe(102); expect(first.generation).toBe(4); expect(first.frameTime).toBe(100); expect(first.exaggeration).toBe(2);
    expect(first.getStatistics()).toMatchObject({preparedMeshes: 1, projectedBytes: 108, projectionBuilds: 1});
    const second = new DrapedTerrainSurfaceSnapshot('web-mercator', [{id: 'ground', mesh, blend: 1}], 5, 200, 0);
    expect(second.intersectRay(ray)?.position[2]).toBeCloseTo(3);
    expect(second.intersectRay(ray)?.coordinate[2]).toBeCloseTo(103);
    // Later queries cannot mutate a retained old frame or its lazily projected owner.
    expect(first.intersectRay(ray)?.position[2]).toBeCloseTo(103);
    const reused = new DrapedTerrainSurfaceSnapshot('web-mercator', [{id: 'ground', mesh, blend: 1}], 5, 201, 0);
    expect(reused.intersectRay(ray)).toEqual(second.intersectRay(ray));
    expect(reused.getStatistics().projectionBuilds).toBe(0);
    expect(first.intersectRay(ray, 1)).toBeNull();
    expect(first.intersectRay({origin: [50, 0, 500], direction: [0, 0, -1]})).toBeNull();
    expect(first.intersectRay({origin: [0, 50, 500], direction: [0, 0, -1]})).toBeNull();
    expect(first.intersectRay({origin: [50, 0, 500], direction: [1, 0, -1]})).toBeNull();
    expect(first.intersectRay({origin: [50, 50, 500], direction: [-1, -1, -1]}, 1)).toBeNull();
    expect(first.intersectRay({origin: [0, 0, 500], direction: [0, 0, 0]})).toBeNull();
});

test('globe ground queries project the displayed vertices, retaining unexaggerated source meters', () => {
    const mesh = ground(), globe = getGeographicProjectionProcedure('globe');
    const ray = {origin: globe.project([0, 0, 1000]), direction: [0, 1, 0] as const};
    const snapshot = new DrapedTerrainSurfaceSnapshot('globe', [{id: 'spherical-ground', mesh, blend: 0.25}], 1, 30, 10);
    const hit = snapshot.intersectRay(ray);
    expect(hit?.coordinate[2]).toBeCloseTo(28, 5);
    expect(hit?.position[1]).toBeLessThan(-256);
    expect(new DrapedTerrainSurfaceSnapshot('globe', [{id: 'spherical-ground', mesh, blend: 1, clips: [[100, 100, 200, 200]]}], 1, 30, 1).intersectRay(ray)).toBeNull();
});

test('fallback clips reject the nearer candidate before choosing a farther visible triangle', () => {
    const mesh: DrapedTerrainQueryMesh = {positions: new Float64Array([-30, -30, 10, 30, -30, 10, 0, 30, 10, -30, -30, 0, 30, -30, 0, 0, 30, 0]),
        heights: new Float32Array(12), indices: new Uint16Array([0, 1, 2, 3, 4, 5]), bounds: [-30, -30, 30, 30]};
    const ray = {origin: [-5, -20, 20] as const, direction: [1, 0, -1] as const};
    const snapshot = new DrapedTerrainSurfaceSnapshot('web-mercator', [{id: 'parent', mesh, blend: 1, clips: [[10, -30, 20, 30]]}], 1, 30, 1);
    expect(snapshot.intersectRay(ray)).toMatchObject({position: [15, -20, 0], triangleIndex: 1});
    expect(new DrapedTerrainSurfaceSnapshot('web-mercator', [{id: 'parent', mesh, blend: 1, clips: []}], 1, 30, 1).intersectRay(ray)).toBeNull();
});

test('empty displays and invalid frame contracts fail explicitly without inventing ground', () => {
    expect(new DrapedTerrainSurfaceSnapshot('globe', [], 0, 0, 100).intersectRay({origin: [0, -300, 0], direction: [0, 1, 0]})).toBeNull();
    const mesh = ground();
    for (const [generation, time, exaggeration] of [[-1, 0, 1], [0, NaN, 1], [0, 0, -1], [0, 0, 1001]]) expect(() => new DrapedTerrainSurfaceSnapshot('globe', [], generation, time, exaggeration)).toThrow(/frame/);
    for (const blend of [-1, NaN, 2]) expect(() => new DrapedTerrainSurfaceSnapshot('globe', [{id: 'x', mesh, blend}], 0, 0, 1)).toThrow(/blend/);
    expect(() => new DrapedTerrainSurfaceSnapshot('globe', [{id: 'x', mesh: {...mesh, heights: new Float32Array(1)}, blend: 1}], 0, 0, 1)).toThrow(/channels/);
    expect(() => new DrapedTerrainSurfaceSnapshot('globe', [{id: 'x', mesh, blend: 1, clips: [[1, 0, 0, 1]]}], 0, 0, 1)).toThrow(/clip/);
});
