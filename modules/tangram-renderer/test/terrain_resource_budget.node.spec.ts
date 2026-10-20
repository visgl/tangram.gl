// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {TerrainResourceBudget} from '../src/map-logic/terrain-resource-budget';

test('shared owners cannot admit a replacement by forgetting the still-visible generation', () => {
    const budget = new TerrainResourceBudget(100);
    const source = budget.reserve('retained', 20), display = budget.reserve('gpu', 50);
    expect(source).not.toBeNull(); expect(display).not.toBeNull();
    expect(budget.reserve('transient', 31)).toBeNull();
    const replacement = budget.reserve('transient', 30);
    expect(replacement?.resize(40)).toBe(false);
    expect(budget.getStatistics()).toEqual({bytes: 100, peakBytes: 100, byteLimit: 100, retainedBytes: 20, transientBytes: 30, gpuBytes: 50, leases: 3});
    display?.release();
    expect(replacement?.resize(40)).toBe(true);
    replacement?.release(); replacement?.release();
    expect(replacement?.resize(1)).toBe(false);
    source?.release();
    expect(budget.getStatistics()).toMatchObject({bytes: 0, peakBytes: 100, leases: 0});
});

test('invalid accounting never mutates admission and zero-budget owners are explicit', () => {
    for (const bytes of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => new TerrainResourceBudget(bytes)).toThrow();
        expect(() => new TerrainResourceBudget(10).reserve('gpu', bytes)).toThrow();
    }
    const budget = new TerrainResourceBudget(0), lease = budget.reserve('retained', 0);
    expect(lease?.resize(1)).toBe(false);
    expect(() => lease?.resize(-1)).toThrow();
    expect(budget.reserve('transient', 1)).toBeNull();
    lease?.release(); expect(budget.getStatistics().leases).toBe(0);
});

test('complete mixed-domain batches are admitted atomically and retain independent leases', () => {
    const budget = new TerrainResourceBudget(100);
    const incumbent = budget.reserve('retained', 20);
    const before = budget.getStatistics();
    expect(budget.reserveAll([{domain: 'gpu', bytes: 50}, {domain: 'transient', bytes: 31}])).toBeNull();
    expect(budget.getStatistics()).toEqual(before);
    expect(() => budget.reserveAll([{domain: 'gpu', bytes: 10}, {domain: 'retained', bytes: NaN}])).toThrow();
    expect(() => budget.reserveAll([{domain: 'gpu', bytes: Number.MAX_SAFE_INTEGER}, {domain: 'gpu', bytes: 1}])).toThrow();
    expect(budget.getStatistics()).toEqual(before);
    const leases = budget.reserveAll([{domain: 'gpu', bytes: 50}, {domain: 'transient', bytes: 30}]);
    expect(leases).toHaveLength(2);
    expect(budget.getStatistics()).toMatchObject({bytes: 100, leases: 3, gpuBytes: 50, transientBytes: 30});
    leases?.[0].release(); expect(leases?.[1].resize(40)).toBe(true);
    for (const lease of leases ?? []) {lease.release(); lease.release();}
    incumbent?.release(); expect(budget.reserveAll([])).toEqual([]);
    expect(budget.getStatistics()).toMatchObject({bytes: 0, leases: 0, peakBytes: 100});
});

test('shared identities survive owner handoff, count once and reject incompatible metadata atomically', () => {
    const budget = new TerrainResourceBudget(100), identity = {};
    const first = budget.reserveShared(identity, 'retained', 70);
    const leases = budget.reserveAll([{identity, domain: 'retained', bytes: 70}, {identity, domain: 'retained', bytes: 70}, {domain: 'gpu', bytes: 30}]);
    expect(leases).toHaveLength(3);
    expect(budget.getStatistics()).toMatchObject({bytes: 100, retainedBytes: 70, gpuBytes: 30, leases: 4});
    const before = budget.getStatistics();
    expect(() => budget.reserveShared(identity, 'retained', 71)).toThrow('metadata');
    expect(() => budget.reserveShared(identity, 'gpu', 70)).toThrow('metadata');
    expect(() => budget.reserveAll([{identity: {}, domain: 'gpu', bytes: 1}, {identity, domain: 'retained', bytes: 71}])).toThrow('metadata');
    expect(budget.getStatistics()).toEqual(before);
    expect(first?.resize(60)).toBe(false); expect(first?.resize(70)).toBe(true);
    first?.release(); expect(first?.resize(70)).toBe(false);
    expect(budget.getStatistics().retainedBytes).toBe(70);
    for (const lease of leases ?? []) lease.release();
    expect(budget.getStatistics()).toMatchObject({bytes: 0, leases: 0});
    const reopened = budget.reserveShared(identity, 'retained', 20);
    expect(budget.getStatistics().bytes).toBe(20); reopened?.release();
    const fresh = {}, batch = budget.reserveAll([{identity: fresh, domain: 'retained', bytes: 100}, {identity: fresh, domain: 'retained', bytes: 100}]);
    expect(batch).toHaveLength(2); expect(budget.getStatistics().bytes).toBe(100);
    for (const lease of batch ?? []) lease.release();
});

test('batch descriptors are snapshotted once before validating and allocating', () => {
    const budget = new TerrainResourceBudget(20);
    let reads = 0;
    const request = {domain: 'gpu' as const, get bytes() {return ++reads === 1 ? 10 : 1000;}};
    const leases = budget.reserveAll([request]);
    expect(reads).toBe(1); expect(leases).toHaveLength(1);
    expect(budget.getStatistics()).toMatchObject({bytes: 10, peakBytes: 10});
    for (const lease of leases ?? []) lease.release();
});
