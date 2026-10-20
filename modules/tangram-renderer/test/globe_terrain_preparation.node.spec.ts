// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {GlobeTerrainPreparation, getPreparedGlobeTerrainTemplate, assertGlobeTerrainPreparationSnapshot} from '../src/map-logic/globe-terrain-preparation';
import {prepareGlobeTerrainMesh, prepareGlobeTerrainMeshSteps, scaleGlobeTerrainMesh, scaleGlobeTerrainMeshSteps} from '../src/map-logic/globe-terrain';
import type {TerrainHeightGrid} from '../src/map-logic/terrain-data';
import {TerrainResourceBudget} from '../src/map-logic/terrain-resource-budget';

/** Tiny immutable physical grid; neighboring fixtures use matching square extents. */
function grid(height = 1000, bounds: [number, number, number, number] = [-100000, -100000, 100000, 100000]): TerrainHeightGrid {
    return {width: 4, height: 4, heights: Float32Array.from({length: 16}, (_, index) => height + index * 10), valid: new Uint8Array(16).fill(1), bounds, registration: 'pixel-center', verticalDatum: 'unknown'};
}

/** Deterministic clock forces a return after each cooperative step without sleeping. */
function clock(): () => number {let elapsed = 0; return () => elapsed++;}

/** Finish a small hermetic generation; production hosts call once per animation frame. */
function finish(preparation: GlobeTerrainPreparation): void {
    const now = clock();
    let calls = 0;
    while (preparation.isPending()) {preparation.advance(1, now); if (++calls > 10000) throw new Error('Preparation did not settle');}
}

test.each([false, true])('cooperative chunks match synchronous physical geometry, lighting and holes (%s)', holes => {
    const source = grid(), neighbor = grid(2000, [100000, -100000, 300000, 100000]);
    if (holes) {source.valid[5] = 0; source.heights[5] = NaN;}
    const iterator = prepareGlobeTerrainMeshSteps(source, {resolution: 4, neighbors: [neighbor]});
    let result = iterator.next(), yields = 0;
    while (!result.done) {yields++; result = iterator.next();}
    expect(yields).toBeGreaterThan(8);
    const template = prepareGlobeTerrainMesh(source, {resolution: 4, neighbors: [neighbor]});
    for (const exaggeration of [0, 1, 100]) expect(scaleGlobeTerrainMesh(result.value, exaggeration)).toEqual(scaleGlobeTerrainMesh(template, exaggeration));
    expect(template.byteLength).toBe(template.vertexCount * 68 + template.triangleCount * 12);
});

test.each([false, true])('cooperative display scaling preserves exact packed arrays and physical holes (%s)', holes => {
    const source = grid(); if (holes) {source.valid[5] = 0; source.heights[5] = NaN;}
    const template = prepareGlobeTerrainMesh(source, {resolution: 16});
    for (const exaggeration of [0, 0.5, 1, 7.3, 100]) {
        const steps = scaleGlobeTerrainMeshSteps(template, exaggeration);
        let result = steps.next(), yields = 0;
        while (!result.done) {yields++; result = steps.next();}
        expect(yields).toBeGreaterThanOrEqual(2);
        expect(result.value).toEqual(scaleGlobeTerrainMesh(template, exaggeration));
        result.value.indices.fill(0); expect(scaleGlobeTerrainMesh(template, exaggeration).indices.some(value => value > 0)).toBe(true);
    }
    expect(() => scaleGlobeTerrainMeshSteps(template, -1).next()).toThrow('Invalid');
    expect(() => scaleGlobeTerrainMeshSteps({vertexCount: 0, triangleCount: 0, byteLength: 0}).next()).toThrow('template');
    expect(() => assertGlobeTerrainPreparationSnapshot({grids: [], resolution: 4, byteLength: 0})).toThrow('completed snapshot');
    const empty = new GlobeTerrainPreparation(); empty.request([], 4); finish(empty);
    expect(() => assertGlobeTerrainPreparationSnapshot(empty.getSnapshot()!)).not.toThrow();
});

test('initial and replacement generations publish atomically; obsolete work and immutable requests stay isolated', () => {
    const preparation = new GlobeTerrainPreparation(), source = grid();
    expect(preparation.advance()).toBe(false); expect(preparation.retry()).toBe(false);
    expect(preparation.request([source], 4)).toBe(true); expect(preparation.request([source], 4)).toBe(false);
    preparation.advance(1, clock()); expect(preparation.getSnapshot()).toBeUndefined();
    finish(preparation);
    const first = preparation.getSnapshot()!;
    expect(first.grids).toEqual([source]); expect(first.resolution).toBe(4); expect(Object.isFrozen(first)).toBe(true); expect(Object.isFrozen(first.grids)).toBe(true);
    expect(preparation.getStatistics()).toMatchObject({pending: 0, committed: 1, prepared: 1, reused: 0, retainedBytes: first.byteLength});
    const replacement = grid(3000);
    preparation.request([replacement], 4); preparation.advance(1, clock());
    expect(preparation.getSnapshot()).toBe(first);
    preparation.request([source], 4); expect(preparation.getStatistics().cancelled).toBe(1);
    finish(preparation);
    expect(getPreparedGlobeTerrainTemplate(preparation.getSnapshot()!, source)).toBe(getPreparedGlobeTerrainTemplate(first, source));
    expect(preparation.getStatistics()).toMatchObject({prepared: 0, reused: 1, committed: 2, retainedBytes: first.byteLength});
    expect(preparation.getStatistics().slices).toBeGreaterThan(0); expect(preparation.getStatistics().workMs).toBeGreaterThan(0);
    const statistics = preparation.getStatistics(); statistics.committed = -1; expect(preparation.getStatistics().committed).toBe(2);
    preparation.destroy(); preparation.destroy(); expect(preparation.getStatistics().retainedBytes).toBe(0); expect(preparation.getSnapshot()).toBeUndefined();
    expect(preparation.advance()).toBe(false); expect(preparation.retry()).toBe(false); expect(() => preparation.request([])).toThrow('disposed');
});

test('touching and wrapped neighborhoods invalidate while distant and reordered templates remain warm', () => {
    const preparation = new GlobeTerrainPreparation(), source = grid(), distant = grid(2000, [1000000, -100000, 1200000, 100000]);
    preparation.request([source, distant], 4); finish(preparation); const first = preparation.getSnapshot()!;
    const neighbor = grid(3000, [100000, -100000, 300000, 100000]);
    preparation.request([distant, source, neighbor], 4); finish(preparation); const changed = preparation.getSnapshot()!;
    expect(changed.grids).toEqual([distant, source, neighbor]);
    expect(getPreparedGlobeTerrainTemplate(changed, distant)).toBe(getPreparedGlobeTerrainTemplate(first, distant));
    expect(getPreparedGlobeTerrainTemplate(changed, source)).not.toBe(getPreparedGlobeTerrainTemplate(first, source));
    expect(preparation.getStatistics()).toMatchObject({prepared: 2, reused: 1});
    preparation.request([distant], 8); finish(preparation);
    expect(getPreparedGlobeTerrainTemplate(preparation.getSnapshot()!, distant)).not.toBe(getPreparedGlobeTerrainTemplate(first, distant));
    const edge = Math.PI * 6378137, west = grid(1000, [-edge, -100000, -edge + 200000, 100000]), east = grid(2000, [edge - 200000, -100000, edge, 100000]);
    preparation.request([west, east], 4); finish(preparation); const wrapped = preparation.getSnapshot()!;
    preparation.request([west, {...east, heights: east.heights.slice()}], 4); finish(preparation);
    expect(getPreparedGlobeTerrainTemplate(preparation.getSnapshot()!, west)).not.toBe(getPreparedGlobeTerrainTemplate(wrapped, west));
    preparation.destroy();
});

test('current and staged retention counts shared storage once, rejects excess and requires explicit retry', () => {
    const source = grid(), distant = grid(2000, [1000000, -100000, 1200000, 100000]);
    const bytes = prepareGlobeTerrainMesh(source, {resolution: 4}).byteLength;
    const preparation = new GlobeTerrainPreparation(bytes);
    preparation.request([source], 4); finish(preparation); const displayed = preparation.getSnapshot();
    preparation.request([source, distant], 4); finish(preparation);
    expect(preparation.getSnapshot()).toBe(displayed);
    expect(preparation.getStatistics()).toMatchObject({error: expect.stringContaining('retained-byte limit'), retainedBytes: bytes, pending: 0});
    expect(preparation.request([source, distant], 4)).toBe(false); expect(preparation.retry()).toBe(true); finish(preparation);
    expect(preparation.getSnapshot()).toBe(displayed); expect(preparation.getStatistics().retainedBytes).toBeLessThanOrEqual(bytes);
    preparation.request([source], 4); finish(preparation); expect(preparation.getStatistics().error).toBeUndefined();
    const bounded = new GlobeTerrainPreparation(bytes * 2);
    bounded.request([source], 4); finish(bounded); bounded.request([source, distant], 4);
    finish(bounded); expect(bounded.getSnapshot()?.byteLength).toBe(bytes * 2); expect(bounded.getStatistics().reused).toBe(1);
    const empty = new GlobeTerrainPreparation(0); empty.request([]); finish(empty); expect(empty.getSnapshot()?.grids).toEqual([]);
    preparation.destroy(); bounded.destroy(); empty.destroy();
});

test('invalid limits, source identity, resolution and handles reject; asynchronous data errors retain displayed geometry', () => {
    for (const limit of [-1, 1.5, Infinity]) expect(() => new GlobeTerrainPreparation(limit)).toThrow('byte limit');
    const preparation = new GlobeTerrainPreparation(), source = grid();
    for (const budget of [0, -1, NaN, Infinity]) expect(() => preparation.advance(budget)).toThrow('slice target');
    for (const resolution of [1, 257, 2.5]) expect(() => preparation.request([source], resolution)).toThrow('resolution');
    expect(() => preparation.request([source, source])).toThrow('distinct');
    expect(() => preparation.request([source, {...grid(), verticalDatum: 'ellipsoidal'}])).toThrow('datum');
    expect(() => getPreparedGlobeTerrainTemplate({grids: [source], resolution: 4, byteLength: 0}, source)).toThrow('completed snapshot');
    preparation.request([source], 4); finish(preparation); const displayed = preparation.getSnapshot()!;
    expect(() => getPreparedGlobeTerrainTemplate(displayed, grid())).toThrow('source identity');
    preparation.request([{...grid(), registration: 'grid-node', heights: new Float32Array(2)}], 4); finish(preparation);
    expect(preparation.getStatistics().error).toContain('Invalid globe terrain grid'); expect(preparation.getSnapshot()).toBe(displayed);
    preparation.destroy();
});

test('large no-data masks yield during validation and prefix construction before sampling begins', () => {
    const source = {...grid(), width: 16, height: 16, heights: new Float32Array(256).fill(1000), valid: new Uint8Array(256).fill(1)};
    source.valid[100] = 0;
    const iterator = prepareGlobeTerrainMeshSteps(source, {resolution: 2});
    let result = iterator.next(), steps = 0;
    while (!result.done) {steps++; result = iterator.next();}
    expect(steps).toBeGreaterThan(7); expect(result.value.triangleCount).toBeLessThan(8);
    const cancelled = prepareGlobeTerrainMeshSteps(source); expect(cancelled.next().done).toBe(false);
    expect(cancelled.return(result.value).done).toBe(true);
});

test('typed-template admission reports exact bytes and can reject before template allocation', () => {
    const source = grid();
    const expected = prepareGlobeTerrainMesh(source, {resolution: 4});
    let admittedBytes = 0;
    const steps = prepareGlobeTerrainMeshSteps(source, {resolution: 4, onAllocate: bytes => {admittedBytes = bytes;}});
    let result = steps.next(); while (!result.done) result = steps.next();
    expect(admittedBytes).toBe(expected.byteLength);
    expect(scaleGlobeTerrainMesh(result.value)).toEqual(scaleGlobeTerrainMesh(expected));
    const rejected = prepareGlobeTerrainMeshSteps(source, {resolution: 4, onAllocate: () => {throw new Error('admission fixture');}});
    expect(() => {while (!rejected.next().done) {/* finish topology */}}).toThrow('admission fixture');
});

test('shared template admission preserves the incumbent and recovers only after capacity is available', () => {
    const source = grid(), replacement = grid(2000);
    const bytes = prepareGlobeTerrainMesh(source, {resolution: 4}).byteLength;
    const budget = new TerrainResourceBudget(bytes * 2);
    const preparation = new GlobeTerrainPreparation(bytes * 4, {resourceBudget: budget});
    preparation.request([source], 4); finish(preparation);
    const first = preparation.getSnapshot();
    const blocker = budget.reserve('gpu', bytes);
    preparation.request([replacement], 4); finish(preparation);
    expect(preparation.getSnapshot()).toBe(first);
    expect(preparation.getStatistics()).toMatchObject({prepared: 0, requiredPeakBytes: bytes * 2, error: expect.stringContaining('shared resource budget')});
    expect(budget.getStatistics()).toMatchObject({bytes: bytes * 2, leases: 2});
    blocker?.release(); expect(preparation.retry()).toBe(true); finish(preparation);
    expect(preparation.getSnapshot()).not.toBe(first);
    expect(budget.getStatistics()).toMatchObject({bytes, leases: 1, peakBytes: bytes * 2});
    preparation.destroy(); preparation.destroy(); expect(budget.getStatistics().bytes).toBe(0);
});

test('cancellation releases partially allocated template reservations and allows the same request again', () => {
    const source = grid(), budget = new TerrainResourceBudget(1024 * 1024);
    const preparation = new GlobeTerrainPreparation(undefined, {resourceBudget: budget});
    preparation.request([source], 4); finish(preparation);
    const first = preparation.getSnapshot(), retainedBytes = budget.getStatistics().bytes;
    preparation.request([source], 16);
    let steps = 0; const now = clock();
    while (budget.getStatistics().bytes === retainedBytes && preparation.isPending()) {
        preparation.advance(1, now); if (++steps > 1000) throw new Error('Missing allocation fence');
    }
    expect(budget.getStatistics().bytes).toBeGreaterThan(retainedBytes);
    expect(preparation.cancel()).toBe(true); expect(preparation.cancel()).toBe(false);
    expect(preparation.getSnapshot()).toBe(first);
    expect(budget.getStatistics().bytes).toBe(retainedBytes);
    expect(preparation.request([source], 16)).toBe(true); finish(preparation);
    preparation.request([], 4); finish(preparation);
    expect(budget.getStatistics()).toMatchObject({bytes: 0, leases: 0});
    preparation.destroy();
});
