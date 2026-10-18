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
