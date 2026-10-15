// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import {DrapedTerrainSurfaceSnapshot, type DrapedTerrainQueryMesh} from '../src/selection/draped-terrain-surface';
import {summarizeDrapedTerrainBounds} from '../src/map-logic/draped-terrain-bounds';
import {getGeographicProjectionProcedure} from '../src/scene/projection_math';
import {TriangleQueryIndex} from '../src/map-logic/triangle-query-index';
import {TerrainMeshSurface} from '../src/selection/terrain_surface';

test('half-open ownership is snapshotted and keeps a shared clip edge assigned to exactly one owner', () => {
    const mesh = ground(), entry = {id: 'left', mesh, blend: 1, clips: [[-1, -1, 0, 1] as const], halfOpenClips: true};
    const left = new DrapedTerrainSurfaceSnapshot('web-mercator', [entry], 1, 0, 1);
    entry.halfOpenClips = false;
    const ray = {origin: [0, 0, 500] as const, direction: [0, 0, -1] as const};
    expect(left.intersectRay(ray)).toBeNull();
    const both = new DrapedTerrainSurfaceSnapshot('web-mercator', [
        {...entry, halfOpenClips: true}, {id: 'right', mesh, blend: 1, clips: [[0, -1, 1, 1]], halfOpenClips: true}
    ], 1, 0, 1);
    expect(both.intersectRay(ray)?.surfaceId).toBe('right');
    expect(new DrapedTerrainSurfaceSnapshot('web-mercator', [entry], 1, 0, 1).displayKey).not.toBe(left.displayKey);
});

test('settled queries stay linear until cooperative warming and obey an aggregate hierarchy budget', () => {
    const mesh = ground(), required = TriangleQueryIndex.getRequiredHierarchyBytes(1);
    const ray = {origin: [0, -1, 500] as const, direction: [0, 0, -1] as const};
    const snapshot = new DrapedTerrainSurfaceSnapshot('web-mercator', [
        {id: 'one', mesh, blend: 1}, {id: 'lease', mesh, blend: 1}, {id: 'two', mesh: ground(), blend: 1}
    ], 0, 0, 1, required);
    const first = snapshot.intersectRay(ray);
    expect(snapshot.getStatistics()).toMatchObject({inputBytes: 204, queryIndexBytes: 0, reservedQueryIndexBytes: required});
    for (const _step of snapshot.prepareQueryIndexSteps()) { /* bounded cooperative work */ }
    expect(snapshot.getStatistics().queryIndexBytes).toBe(required);
    expect(snapshot.intersectRay(ray)).toEqual(first);
    const morph = new DrapedTerrainSurfaceSnapshot('web-mercator', [{id: 'morph', mesh, blend: 0.5}], 0, 0, 1, required);
    morph.intersectRay(ray);
    for (const _step of morph.prepareQueryIndexSteps()) { /* no morph hierarchy */ }
    expect(morph.getStatistics()).toMatchObject({queryIndexBytes: 0, reservedQueryIndexBytes: 0});
});

test('query preparation cancellation and allocation failure retain exact linear hits without retry loops', () => {
    const mesh = ground(), ray = {origin: [0, -1, 500] as const, direction: [0, 0, -1] as const};
    const snapshot = new DrapedTerrainSurfaceSnapshot('web-mercator', [{id: 'one', mesh, blend: 1}], 0, 0, 1);
    const hit = snapshot.intersectRay(ray);
    const warm = vi.spyOn(TerrainMeshSurface.prototype, 'prepareQueryIndexSteps').mockImplementation(function* () {yield; throw new Error('allocation fixture');});
    try {
        const cancelled = snapshot.prepareQueryIndexSteps(); cancelled.next(); cancelled.return();
        expect(snapshot.getStatistics().preparationFailures).toBe(0);
        for (const _step of snapshot.prepareQueryIndexSteps()) { /* reports failure, never drops geometry */ }
        expect(snapshot.getStatistics().preparationFailures).toBe(1);
        expect(snapshot.intersectRay(ray)).toEqual(hit);
        for (const _step of snapshot.prepareQueryIndexSteps()) { /* no repeated failed allocation */ }
        expect(warm).toHaveBeenCalledTimes(2);
    } finally {warm.mockRestore();}
});

test('unqueried and farther membership cannot reserve the nearest ground acceleration budget', () => {
    const farther = ground(), nearer = ground(), unrelated = ground();
    for (let vertex = 0; vertex < nearer.positions.length / 3; vertex++) nearer.positions[vertex * 3 + 2] += 100;
    for (let vertex = 0; vertex < unrelated.positions.length / 3; vertex++) unrelated.positions[vertex * 3] += 1000;
    unrelated.bounds = [990, -10, 1010, 10];
    const required = TriangleQueryIndex.getRequiredHierarchyBytes(1);
    const snapshot = new DrapedTerrainSurfaceSnapshot('web-mercator', [
        {id: 'unrelated-first', mesh: unrelated, blend: 1}, {id: 'farther-first', mesh: farther, blend: 1},
        {id: 'nearer-last', mesh: nearer, blend: 1}
    ], 0, 0, 1, required);
    expect(snapshot.reservedQueryIndexBytes).toBe(0);
    expect(snapshot.intersectRay({origin: [0, -1, 500], direction: [0, 0, -1]})?.surfaceId).toBe('nearer-last');
    for (const _step of snapshot.prepareQueryIndexSteps()) { /* nearest demanded owner only */ }
    expect(snapshot.getStatistics()).toMatchObject({reservedQueryIndexBytes: required, queryIndexBytes: required, preparedMeshes: 1});
    // A later distinct ray still picks exactly when no index budget remains.
    expect(snapshot.intersectRay({origin: [1000, -1, 500], direction: [0, 0, -1]})?.surfaceId).toBe('unrelated-first');
    for (const _step of snapshot.prepareQueryIndexSteps()) { /* exact fallback has no hierarchy */ }
    expect(snapshot.getStatistics()).toMatchObject({reservedQueryIndexBytes: required, queryIndexBytes: required, preparedMeshes: 2});
});

test('cooperative warming shares slices across demanded owners and cancels every partial iterator', () => {
    const left = ground(), right = ground();
    for (let vertex = 0; vertex < right.positions.length / 3; vertex++) right.positions[vertex * 3] += 100;
    right.bounds = [90, -10, 110, 10];
    const snapshot = new DrapedTerrainSurfaceSnapshot('web-mercator', [
        {id: 'left', mesh: left, blend: 1}, {id: 'right', mesh: right, blend: 1}
    ], 0, 0, 1);
    const first = snapshot.intersectRay({origin: [0, -1, 500], direction: [0, 0, -1]});
    const second = snapshot.intersectRay({origin: [100, -1, 500], direction: [0, 0, -1]});
    const calls: TerrainMeshSurface[] = [], closed: TerrainMeshSurface[] = [];
    const prepare = vi.spyOn(TerrainMeshSurface.prototype, 'prepareQueryIndexSteps').mockImplementation(function* (this: TerrainMeshSurface) {
        try {for (let slice = 0; slice < 3; slice++) {calls.push(this); yield;}}
        finally {closed.push(this);}
    });
    try {
        const steps = snapshot.prepareQueryIndexSteps();
        steps.next(); steps.next(); steps.next();
        expect(calls[0]).not.toBe(calls[1]); expect(calls[2]).toBe(calls[0]);
        steps.return(); expect(new Set(closed).size).toBe(2);
        expect(snapshot.getStatistics().preparationFailures).toBe(0);
        expect(snapshot.intersectRay({origin: [0, -1, 500], direction: [0, 0, -1]})).toEqual(first);
        expect(snapshot.intersectRay({origin: [100, -1, 500], direction: [0, 0, -1]})).toEqual(second);
    } finally {prepare.mockRestore();}
});

test('immutable display bounds are evaluated once across repeated probes without changing exact hits', () => {
    const mesh = ground(), summary = summarizeDrapedTerrainBounds(mesh);
    let summaryReads = 0;
    Object.defineProperty(mesh, 'boundsSummary', {get() {summaryReads++; return summary;}});
    const snapshot = new DrapedTerrainSurfaceSnapshot('web-mercator', [{id: 'ground', mesh, blend: 1}], 0, 0, 1);
    expect(summaryReads).toBe(0);
    const ray = {origin: [0, -1, 500] as const, direction: [0, 0, -1] as const};
    const expected = snapshot.intersectRay(ray);
    for (let query = 0; query < 10; query++) expect(snapshot.intersectRay(ray)).toEqual(expected);
    expect(summaryReads).toBe(1);
    expect(snapshot.getStatistics()).toMatchObject({preparedMeshes: 1, projectionBuilds: 1});
});

test('one failed warming owner never prevents another demanded owner from completing its index', () => {
    const left = ground(), right = ground();
    for (let vertex = 0; vertex < right.positions.length / 3; vertex++) right.positions[vertex * 3] += 100;
    right.bounds = [90, -10, 110, 10];
    const snapshot = new DrapedTerrainSurfaceSnapshot('web-mercator', [{id: 'left', mesh: left, blend: 1}, {id: 'right', mesh: right, blend: 1}], 0, 0, 1);
    const leftRay = {origin: [0, -1, 500] as const, direction: [0, 0, -1] as const};
    const rightRay = {origin: [100, -1, 500] as const, direction: [0, 0, -1] as const};
    const leftHit = snapshot.intersectRay(leftRay), rightHit = snapshot.intersectRay(rightRay);
    const original = TerrainMeshSurface.prototype.prepareQueryIndexSteps;
    const prepare = vi.spyOn(TerrainMeshSurface.prototype, 'prepareQueryIndexSteps').mockImplementation(function* (this: TerrainMeshSurface) {
        if ((this.getBounds()?.minimum[0] ?? Infinity) < 50) {yield; throw new Error('one owner fixture');}
        yield* original.call(this);
    });
    try {
        for (const _step of snapshot.prepareQueryIndexSteps()) { /* failure is owner-local */ }
        expect(snapshot.getStatistics()).toMatchObject({preparationFailures: 1, queryIndexBytes: TriangleQueryIndex.getRequiredHierarchyBytes(1)});
        expect(snapshot.intersectRay(leftRay)).toEqual(leftHit); expect(snapshot.intersectRay(rightRay)).toEqual(rightHit);
    } finally {prepare.mockRestore();}
});

test('visibility identity changes with mesh replacement or fallback clips, but not frame timestamps', () => {
    const mesh = ground();
    const capture = (time: number, next = mesh, clips?: readonly (readonly [number, number, number, number])[]) =>
        new DrapedTerrainSurfaceSnapshot('web-mercator', [{id: 'reused-owner', mesh: next, blend: 1, clips}], 4, time, 1);
    expect(capture(1).displayKey).toBe(capture(2).displayKey);
    expect(capture(1).displayKey).not.toBe(capture(1, ground()).displayKey);
    expect(capture(1).displayKey).not.toBe(capture(1, mesh, []).displayKey);
    for (const budget of [-1, 0.5, NaN]) expect(() => new DrapedTerrainSurfaceSnapshot('web-mercator', [], 0, 0, 1, budget)).toThrow(/budget/);
});

/** Tiny ground topology whose authored Z remains distinct from physical DEM height. */
function ground(): DrapedTerrainQueryMesh {
    return {positions: new Float64Array([-10, -10, 3, 10, -10, 3, -10, 10, 3]),
        heights: new Float32Array([100, 0, 100, 0, 100, 0]), indices: new Uint16Array([0, 1, 2]), bounds: [-10, -10, 10, 10]};
}

test.each(['web-mercator', 'globe'] as const)('zero projected residency budget preserves exact %s queries through morph, relief and clips', projection => {
    const globe = getGeographicProjectionProcedure('globe');
    const ray = projection === 'globe' ? {origin: globe.project([0, -0.00001, 1000]), direction: [0, 10, 0] as const} :
        {origin: [0, -1, 1000] as const, direction: [0, 0, -2] as const};
    for (const blend of [0, 0.5, 1]) for (const exaggeration of [0, 2, 5]) for (const clips of [undefined, [[-10, -10, 10, 10]], [[5, 5, 10, 10]]] as const) {
        const mesh = ground(), entries = [{id: 'ground', mesh, blend, clips}];
        const cached = new DrapedTerrainSurfaceSnapshot(projection, entries, 0, 0, exaggeration);
        const streaming = new DrapedTerrainSurfaceSnapshot(projection, entries, 0, 0, exaggeration, 1024, 0);
        expect(streaming.intersectRay(ray)).toEqual(cached.intersectRay(ray));
        expect(streaming.intersectRay(ray, 0.000001)).toBeNull();
        for (const _step of streaming.prepareQueryIndexSteps()) { /* no projected owner or hierarchy */ }
        const skippedByClipBounds = projection === 'web-mercator' && clips?.[0][0] === 5;
        expect(streaming.getStatistics()).toMatchObject({projectedBytes: 0, queryIndexBytes: 0, reservedQueryIndexBytes: 0, streamingMeshes: skippedByClipBounds ? 0 : 1, projectionBuilds: 0});
    }
});

test('projected geometry is demand-admitted, byte-exact, and shared by repeated clip leases', () => {
    const left = ground(), right = ground();
    for (let vertex = 0; vertex < 3; vertex++) right.positions[vertex * 3] += 100;
    right.bounds = [90, -10, 110, 10];
    const surface = new DrapedTerrainSurfaceSnapshot('web-mercator', [
        {id: 'left', mesh: left, blend: 1}, {id: 'left-lease', mesh: left, blend: 1}, {id: 'right', mesh: right, blend: 1}
    ], 0, 0, 1, 1024, 108);
    expect(surface.getStatistics().projectedBytes).toBe(0);
    expect(surface.intersectRay({origin: [0, -1, 500], direction: [0, 0, -1]})?.surfaceId).toBe('left');
    expect(surface.getStatistics()).toMatchObject({projectedBytes: 108, streamingMeshes: 0});
    expect(surface.intersectRay({origin: [100, -1, 500], direction: [0, 0, -1]})?.surfaceId).toBe('right');
    expect(surface.getStatistics()).toMatchObject({projectedBytes: 108, streamingMeshes: 1});
    for (const _step of surface.prepareQueryIndexSteps()) { /* only the resident owner warms */ }
    expect(surface.getStatistics().queryIndexBytes).toBe(TriangleQueryIndex.getRequiredHierarchyBytes(1));
});

test('streaming demand evicts older cache residency without invalidating a retained snapshot', () => {
    const mesh = ground(), entries = [{id: 'ground', mesh, blend: 1}];
    const ray = {origin: [0, -1, 500] as const, direction: [0, 0, -1] as const};
    const previous = new DrapedTerrainSurfaceSnapshot('web-mercator', entries, 0, 0, 1, 0, 108);
    const expected = previous.intersectRay(ray);
    expect(previous.getStatistics()).toMatchObject({projectedBytes: 108, projectionBuilds: 1});
    const streaming = new DrapedTerrainSurfaceSnapshot('web-mercator', entries, 0, 1, 1, 0, 0);
    expect(streaming.intersectRay(ray)).toEqual(expected);
    expect(streaming.getStatistics()).toMatchObject({projectedBytes: 0, projectionBuilds: 0, streamingMeshes: 1});
    expect(previous.intersectRay(ray)).toEqual(expected);
    const next = new DrapedTerrainSurfaceSnapshot('web-mercator', entries, 0, 2, 1, 0, 108);
    expect(next.intersectRay(ray)).toEqual(expected);
    // A fresh build proves the weak cache no longer pins the previous arrays.
    expect(next.getStatistics()).toMatchObject({projectedBytes: 108, projectionBuilds: 1});
});

test('streaming-owner validation is counted separately from exact query CPU time', () => {
    const surface = new DrapedTerrainSurfaceSnapshot('web-mercator', [{id: 'ground', mesh: ground(), blend: 1}], 0, 0, 1, 0, 0);
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(107).mockReturnValueOnce(110).mockReturnValueOnce(113);
    try {
        expect(surface.intersectRay({origin: [0, -1, 500], direction: [0, 0, -1]})).not.toBeNull();
        expect(surface.getStatistics()).toMatchObject({preparationMs: 7, queryMs: 3, streamingMeshes: 1, projectedBytes: 0});
    } finally {clock.mockRestore();}
});

test('streaming queries reject malformed channels instead of returning a plausible hit', () => {
    const mesh = ground(); mesh.indices[2] = 999;
    const surface = new DrapedTerrainSurfaceSnapshot('web-mercator', [{id: 'invalid', mesh, blend: 1}], 0, 0, 1, 0, 0);
    expect(() => surface.intersectRay({origin: [0, -1, 500], direction: [0, 0, -1]})).toThrow(/index|finite and in range/);
    for (const limit of [-1, 0.5, NaN]) expect(() => new DrapedTerrainSurfaceSnapshot('web-mercator', [], 0, 0, 1, 0, limit)).toThrow(/projected query budget/);
    expect(new DrapedTerrainSurfaceSnapshot('web-mercator', [], 0, 0, 1, 0, 0).displayKey).not.toBe(new DrapedTerrainSurfaceSnapshot('web-mercator', [], 0, 0, 1, 0, 1).displayKey);
});

test('streaming rejects a clipped nearer triangle and retains original-order distance ties', () => {
    const mesh = ground();
    mesh.positions = new Float64Array([...mesh.positions, ...mesh.positions]);
    mesh.positions[11] += 100; mesh.positions[14] += 100; mesh.positions[17] += 100;
    mesh.heights = new Float32Array([...mesh.heights, ...mesh.heights]);
    mesh.indices = new Uint32Array([3, 4, 5, 0, 1, 2, 0, 1, 2]);
    const entries = [{id: 'layered-ground', mesh, blend: 1}];
    const ray = {origin: [0, -1, 500] as const, direction: [0, 0, -1] as const};
    const cached = new DrapedTerrainSurfaceSnapshot('web-mercator', entries, 0, 0, 1);
    const streaming = new DrapedTerrainSurfaceSnapshot('web-mercator', entries, 0, 0, 1, 0, 0);
    expect(streaming.intersectRay(ray)).toEqual(cached.intersectRay(ray));
    expect(streaming.intersectRay(ray)?.triangleIndex).toBe(0);
    expect(streaming.intersectRay(ray, 200)).toBeNull();
    // A ray starting below the raised face keeps the first of the two identical lower triangles.
    const below = {origin: [0, -1, 150] as const, direction: [0, 0, -1] as const};
    expect(streaming.intersectRay(below)).toEqual(cached.intersectRay(below));
    expect(streaming.intersectRay(below)?.triangleIndex).toBe(1);
});

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

test('globe fallback clips use the source-position varying, not an inverse projection of the chord hit', () => {
    const mercator = getGeographicProjectionProcedure('web-mercator'), globe = getGeographicProjectionProcedure('globe');
    const coordinates: [number, number, number][] = [[-60, 0, 0], [60, 0, 0], [-60, 70, 0]];
    const positions = coordinates.map(coordinate => mercator.project(coordinate));
    const common = coordinates.map(coordinate => globe.project(coordinate));
    const average = (axis: number) => common.reduce((sum, vertex) => sum + vertex[axis] / 3, 0);
    const center: [number, number, number] = [average(0), average(1), average(2)];
    const horizontal = positions.reduce((sum, point) => sum + point[0] / 3, 0), vertical = positions.reduce((sum, point) => sum + point[1] / 3, 0);
    const mesh: DrapedTerrainQueryMesh = {positions: Float64Array.from(positions.flat()), heights: new Float32Array(6), indices: new Uint16Array([0, 1, 2]), bounds: [-1e7, 0, 1e7, 2e7]};
    const surface = new DrapedTerrainSurfaceSnapshot('globe', [{id: 'parent', mesh, blend: 1, clips: [[horizontal - 1000, vertical - 1000, horizontal + 1000, vertical + 1000]]}], 1, 0, 1);
    const hit = surface.intersectRay({origin: [center[0] * 4, center[1] * 4, center[2] * 4], direction: [-center[0], -center[1], -center[2]]});
    expect(hit).not.toBeNull(); expect(hit?.coordinate[0]).not.toBeCloseTo(-20, 0);
});

test('empty displays and invalid frame contracts fail explicitly without inventing ground', () => {
    expect(new DrapedTerrainSurfaceSnapshot('globe', [], 0, 0, 100).intersectRay({origin: [0, -300, 0], direction: [0, 1, 0]})).toBeNull();
    const mesh = ground();
    for (const [generation, time, exaggeration] of [[-1, 0, 1], [0, NaN, 1], [0, 0, -1], [0, 0, 1001]]) expect(() => new DrapedTerrainSurfaceSnapshot('globe', [], generation, time, exaggeration)).toThrow(/frame/);
    for (const blend of [-1, NaN, 2]) expect(() => new DrapedTerrainSurfaceSnapshot('globe', [{id: 'x', mesh, blend}], 0, 0, 1)).toThrow(/blend/);
    expect(() => new DrapedTerrainSurfaceSnapshot('globe', [{id: 'x', mesh: {...mesh, heights: new Float32Array(1)}, blend: 1}], 0, 0, 1)).toThrow(/channels/);
    expect(() => new DrapedTerrainSurfaceSnapshot('globe', [{id: 'x', mesh, blend: 1, clips: [[1, 0, 0, 1]]}], 0, 0, 1)).toThrow(/clip/);
});

test.each(['web-mercator', 'globe'] as const)('far and unrelated %s ground owners remain unprojected after a nearer hit', projection => {
    const mercator = getGeographicProjectionProcedure('web-mercator'), globe = getGeographicProjectionProcedure('globe');
    const near = ground(), far = ground(), unrelated = ground();
    far.positions = Float64Array.from(far.positions, (value, index) => index % 3 === 2 ? value - 100 : value);
    const shift = mercator.project([120, 45, 0]);
    unrelated.positions = Float64Array.from(unrelated.positions, (value, index) => index % 3 === 0 ? value + shift[0] : index % 3 === 1 ? value + shift[1] : value);
    unrelated.bounds = [shift[0] - 10, shift[1] - 10, shift[0] + 10, shift[1] + 10];
    for (const mesh of [near, far, unrelated]) mesh.boundsSummary = summarizeDrapedTerrainBounds(mesh);
    const snapshot = new DrapedTerrainSurfaceSnapshot(projection, [
        {id: 'far', mesh: far, blend: 1}, {id: 'elsewhere', mesh: unrelated, blend: 1}, {id: 'near', mesh: near, blend: 1}
    ], 0, 0, 1);
    const ray = projection === 'globe' ? {origin: globe.project([0, -0.00001, 1000]), direction: [0, 10, 0] as const} :
        {origin: [0, -1, 1000] as const, direction: [0, 0, -10] as const};
    expect(snapshot.intersectRay(ray)?.surfaceId).toBe('near');
    expect(snapshot.getStatistics()).toMatchObject({preparedMeshes: 1, projectionBuilds: 1, projectedBytes: 108});
    const miss = new DrapedTerrainSurfaceSnapshot(projection, [{id: 'far', mesh: far, blend: 1}], 0, 0, 1);
    expect(miss.intersectRay(ray, projection === 'globe' ? 0.00001 : 1)).toBeNull(); expect(miss.getStatistics().preparedMeshes).toBe(0);
});

test.each([[-190, 70], [179, -70], [40, 85]])('globe bounds enclose long chords near %s/%s throughout relief and morph changes', (longitude, latitude) => {
    const mercator = getGeographicProjectionProcedure('web-mercator'), globe = getGeographicProjectionProcedure('globe');
    const coordinates: [number, number, number][] = [[longitude - 5, latitude - 5, -30], [longitude + 5, latitude - 5, 40], [longitude, latitude, 5]];
    const mesh: DrapedTerrainQueryMesh = {positions: Float64Array.from(coordinates.flatMap(point => mercator.project(point))), heights: new Float32Array([500, -100, 100, 300, -50, 700]),
        indices: new Uint16Array([0, 1, 2]), bounds: [-Infinity, -Infinity, Infinity, Infinity]};
    mesh.bounds = [Math.min(mesh.positions[0], mesh.positions[3], mesh.positions[6]), Math.min(mesh.positions[1], mesh.positions[4], mesh.positions[7]),
        Math.max(mesh.positions[0], mesh.positions[3], mesh.positions[6]), Math.max(mesh.positions[1], mesh.positions[4], mesh.positions[7])];
    mesh.boundsSummary = summarizeDrapedTerrainBounds(mesh);
    for (const exaggeration of [0, 1, 200]) for (const blend of [0, 0.5, 1]) {
        const projected = coordinates.flatMap((point, index) => globe.project([point[0], point[1], point[2] +
            (mesh.heights[index * 2 + 1] + (mesh.heights[index * 2] - mesh.heights[index * 2 + 1]) * blend) * exaggeration]));
        const reference = new TerrainMeshSurface({projection: 'globe', positions: projected, indices: mesh.indices, cullBackfaces: true});
        const center = [0, 1, 2].map(axis => (projected[axis] + projected[axis + 3] + projected[axis + 6]) / 3);
        const ray = {origin: [center[0] * 2, center[1] * 2, center[2] * 2] as [number, number, number], direction: [-center[0], -center[1], -center[2]] as [number, number, number]};
        const snapshot = new DrapedTerrainSurfaceSnapshot('globe', [{id: 'ground', mesh, blend}], 0, 0, exaggeration);
        const expected = reference.intersectRay(ray);
        expect(expected).not.toBeNull(); expect(snapshot.intersectRay(ray)?.distance).toBeCloseTo(expected!.distance, 8);
    }
});

test('empty, disjoint or fully clipped owners allocate no projected geometry; unindexed invalid vertices do not affect bounds', () => {
    const mesh = ground(), ray = {origin: [0, -1, 500] as const, direction: [0, 0, -1] as const};
    for (const clips of [[], [[100, 100, 200, 200]]] as const) {
        const snapshot = new DrapedTerrainSurfaceSnapshot('web-mercator', [{id: 'clipped', mesh, blend: 1, clips}], 0, 0, 1);
        expect(snapshot.intersectRay(ray)).toBeNull(); expect(snapshot.getStatistics().preparedMeshes).toBe(0);
    }
    expect(new DrapedTerrainSurfaceSnapshot('globe', [{id: 'empty', mesh: {...mesh, indices: new Uint16Array()}, blend: 1}], 0, 0, 1).getStatistics().projectionBuilds).toBe(0);
    const extra = {...mesh, positions: new Float64Array([...mesh.positions, NaN, NaN, NaN]), heights: new Float32Array([...mesh.heights, NaN, NaN])};
    expect(summarizeDrapedTerrainBounds(extra)).toEqual(summarizeDrapedTerrainBounds(mesh));
    expect(() => summarizeDrapedTerrainBounds({...mesh, indices: new Uint16Array([0, 1, 9])})).toThrow('index');
    expect(() => summarizeDrapedTerrainBounds({...mesh, heights: new Float32Array(6).fill(NaN)})).toThrow('channels');
});
