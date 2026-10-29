// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {GlobeTerrainPreparation, TerrainResourceBudget, type TerrainHeightGrid} from '@tangram.gl/tangram-renderer/map-logic';
import {GlobeTerrainDisplayPreparation, resolveGlobeTerrainDisplay} from '../src/experimental/terrain-display';

/** Hermetic immutable physical grid, optionally touching another footprint. */
function grid(height = 1000, bounds: [number, number, number, number] = [-100000, -100000, 100000, 100000]): TerrainHeightGrid {
    return {width: 2, height: 2, heights: new Float32Array(4).fill(height), valid: new Uint8Array(4).fill(1), bounds, registration: 'grid-node', verticalDatum: 'unknown'};
}

/** Complete small source/template fixtures independently of a device or network. */
function terrain(grids: TerrainHeightGrid[], resolution = 4) {
    const preparation = new GlobeTerrainPreparation(); preparation.request(grids, resolution);
    while (preparation.isPending()) preparation.advance(1000);
    return preparation.getSnapshot()!;
}

/** One clock tick per observation makes every advance yield deterministically. */
function finish(display: GlobeTerrainDisplayPreparation): void {
    let elapsed = 0, calls = 0;
    while (display.isPending()) {display.advance(1, () => elapsed++); if (++calls > 10000) throw new Error('Display did not settle');}
}

test('shared source/display ownership retains old templates until the matching display retires', () => {
    const budget = new TerrainResourceBudget(1024 * 1024);
    const preparation = new GlobeTerrainPreparation(undefined, {resourceBudget: budget});
    preparation.request([grid()], 4); while (preparation.isPending()) preparation.advance(1000);
    const source = preparation.getSnapshot(); if (!source) throw new Error('Missing source fixture');
    const display = new GlobeTerrainDisplayPreparation({resourceBudget: budget, maxQueryIndexBytes: 0});
    display.request(source, 1); finish(display);
    const first = display.getSnapshot(); if (!first) throw new Error('Missing display fixture');
    expect(budget.getStatistics()).toMatchObject({bytes: source.byteLength + first.byteLength, leases: 3});
    preparation.request([grid(2000)], 4); while (preparation.isPending()) preparation.advance(1000);
    const next = preparation.getSnapshot(); if (!next) throw new Error('Missing replacement fixture');
    expect(budget.getStatistics().bytes).toBe(source.byteLength + next.byteLength + first.byteLength);
    // Source ownership can retire before the displayed generation: its template remains leased.
    preparation.destroy();
    expect(budget.getStatistics().bytes).toBe(source.byteLength + first.byteLength);
    display.request(next, 1); finish(display);
    expect(display.getStatistics().error).toBeUndefined();
    expect(budget.getStatistics().bytes).toBe(next.byteLength + (display.getSnapshot()?.byteLength ?? 0));
    display.destroy(); display.destroy(); expect(budget.getStatistics()).toMatchObject({bytes: 0, leases: 0});
});

test('display batch rejection and cancellation retain current geometry without leaking future reservations', () => {
    const source = terrain([grid()], 16), budget = new TerrainResourceBudget(1024 * 1024);
    const display = new GlobeTerrainDisplayPreparation({resourceBudget: budget, maxQueryIndexBytes: 0});
    display.request(source, 1); finish(display); const first = display.getSnapshot();
    const bytes = budget.getStatistics().bytes;
    const blocker = budget.reserve('gpu', budget.byteLimit - bytes);
    display.request(source, 2); finish(display);
    expect(display.getSnapshot()).toBe(first);
    expect(display.getStatistics()).toMatchObject({prepared: 0, error: expect.stringContaining('shared resource budget')});
    expect(budget.getStatistics().bytes).toBe(budget.byteLimit);
    blocker?.release(); expect(display.retry()).toBe(true);
    let elapsed = 0; display.advance(1, () => elapsed++);
    expect(budget.getStatistics().bytes).toBeGreaterThan(bytes);
    expect(display.cancel()).toBe(true); expect(display.cancel()).toBe(false);
    expect(display.getSnapshot()).toBe(first); expect(budget.getStatistics().bytes).toBe(bytes);
    expect(display.request(source, 2)).toBe(true); finish(display);
    expect(display.getSnapshot()?.exaggeration).toBe(2);
    const committed = display.getSnapshot(), committedBytes = budget.getStatistics().bytes;
    const replacement = terrain([grid(), grid(2000, [1000000, -100000, 1200000, 100000])]);
    display.request(replacement, 1); display.advance(1, () => elapsed++);
    expect(display.getStatistics().prepared).toBe(1);
    expect(budget.getStatistics().bytes).toBeGreaterThan(committedBytes);
    display.cancel();
    expect(display.getSnapshot()).toBe(committed);
    expect(budget.getStatistics().bytes).toBe(committedBytes);
    display.request(terrain([]), 1); finish(display);
    expect(budget.getStatistics()).toMatchObject({bytes: 0, leases: 0}); display.destroy();
});

test('reordered shared templates and displays can be reused even when the shared pool is full', () => {
    const budget = new TerrainResourceBudget(1024 * 1024), first = grid(), second = grid(2000, [1000000, -100000, 1200000, 100000]);
    const preparation = new GlobeTerrainPreparation(undefined, {resourceBudget: budget});
    preparation.request([first, second], 4); while (preparation.isPending()) preparation.advance(1000);
    const source = preparation.getSnapshot(); if (!source) throw new Error('Missing fixture');
    const display = new GlobeTerrainDisplayPreparation({resourceBudget: budget, maxQueryIndexBytes: 0});
    display.request(source, 1); finish(display);
    const bytes = budget.getStatistics().bytes, blocker = budget.reserve('gpu', budget.byteLimit - bytes);
    preparation.request([second, first], 4); while (preparation.isPending()) preparation.advance(1000);
    const reordered = preparation.getSnapshot(); if (!reordered) throw new Error('Missing reordered fixture');
    display.request(reordered, 1); finish(display);
    expect(display.getStatistics()).toMatchObject({reused: 2, prepared: 0, error: undefined});
    expect(budget.getStatistics()).toMatchObject({bytes: budget.byteLimit, leases: 7});
    blocker?.release(); preparation.destroy(); display.destroy();
    expect(budget.getStatistics()).toMatchObject({bytes: 0, leases: 0});
});

test('display rescaling yields without publishing partial drawing or picking and latest requests replace staged work', () => {
    const source = terrain([grid()], 16), display = new GlobeTerrainDisplayPreparation({maxQueryIndexBytes: 0});
    expect(display.request(source, 100)).toBe(true);
    let clock = 0; expect(display.advance(1, () => clock++)).toBe(false);
    expect(display.getSnapshot()).toBeUndefined(); expect(display.getStatistics()).toMatchObject({pending: 1, slices: 1});
    expect(display.request(source, 100)).toBe(false); finish(display);
    const first = display.getSnapshot()!; expect(first.exaggeration).toBe(100);
    const tile = resolveGlobeTerrainDisplay(first)[0];
    expect(tile.surface.intersectRay({origin: [0, -400, 0], direction: [0, 1, 0]})?.coordinate[2]).toBeCloseTo(1000);
    expect(display.getStatistics().queryIndexBytes).toBe(0);
    display.request(source, 50); display.advance(1, () => clock++);
    expect(display.getSnapshot()).toBe(first);
    display.request(source, 0); finish(display);
    expect(display.getSnapshot()?.exaggeration).toBe(0); expect(display.getStatistics().cancelled).toBe(1);
    const flat = resolveGlobeTerrainDisplay(display.getSnapshot()!)[0];
    expect(flat.mesh.attributes.POSITION.value.filter((_, index) => index % 3 === 2).every(value => value === 0)).toBe(true);
    expect(flat.surface.intersectRay({origin: [0, -400, 0], direction: [0, 1, 0]})?.coordinate[2]).toBeCloseTo(1000);
    const statistics = display.getStatistics(); statistics.pending = 99; expect(display.getStatistics().pending).toBe(0);
    display.destroy(); display.destroy(); expect(display.getSnapshot()).toBeUndefined(); expect(display.getStatistics().retainedBytes).toBe(0);
    expect(display.advance()).toBe(false); expect(display.retry()).toBe(false); expect(() => display.request(source, 1)).toThrow('disposed');
});

test('reuse follows immutable template identity, survives reordering and counts shared retained geometry once', () => {
    const source = grid(), distant = grid(2000, [1000000, -100000, 1200000, 100000]), preparation = new GlobeTerrainPreparation();
    preparation.request([source, distant], 4); while (preparation.isPending()) preparation.advance(1000);
    const display = new GlobeTerrainDisplayPreparation(); display.request(preparation.getSnapshot()!, 1); finish(display);
    const first = resolveGlobeTerrainDisplay(display.getSnapshot()!), bytes = display.getStatistics().retainedBytes;
    const hit = first[0].surface.intersectRay({origin: [0, -400, 0], direction: [0, 1, 0]}); expect(hit?.coordinate[2]).toBeCloseTo(1000);
    expect(display.getStatistics().queryIndexBytes).toBeGreaterThan(0);
    preparation.request([distant, source], 4); while (preparation.isPending()) preparation.advance(1000);
    display.request(preparation.getSnapshot()!, 1); let clock = 0; display.advance(1, () => clock++);
    expect(display.getStatistics().retainedBytes).toBe(bytes); finish(display);
    expect(resolveGlobeTerrainDisplay(display.getSnapshot()!)).toEqual([first[1], first[0]]);
    expect(display.getStatistics()).toMatchObject({prepared: 0, reused: 2});
    preparation.request([source], 4); while (preparation.isPending()) preparation.advance(1000);
    display.request(preparation.getSnapshot()!, 1); finish(display);
    expect(resolveGlobeTerrainDisplay(display.getSnapshot()!)[0]).toBe(first[0]);
});

test('display admission rejects before rescaling, retains old queries, retries explicitly and accepts empty release', () => {
    const source = terrain([grid()]), probe = new GlobeTerrainDisplayPreparation(); probe.request(source, 1); finish(probe);
    const bytes = probe.getSnapshot()!.byteLength, display = new GlobeTerrainDisplayPreparation({maxDisplayBytes: bytes});
    display.request(source, 1); finish(display); const first = display.getSnapshot();
    display.request(source, 100); finish(display);
    expect(display.getSnapshot()).toBe(first); expect(display.getStatistics()).toMatchObject({prepared: 0, retainedBytes: bytes, requiredPeakBytes: bytes * 2, error: expect.stringContaining('display-byte limit')});
    expect(display.request(source, 100)).toBe(false); expect(display.retry()).toBe(true); finish(display);
    expect(display.getSnapshot()).toBe(first);
    display.request(source, 1); finish(display); expect(display.getStatistics().error).toBeUndefined();
    display.request(terrain([]), 1); finish(display); expect(display.getStatistics().retainedBytes).toBe(0);
    const zero = new GlobeTerrainDisplayPreparation({maxDisplayBytes: 0}); zero.request(source, 1); zero.advance();
    expect(zero.getSnapshot()).toBeUndefined(); expect(zero.getStatistics().error).toContain('display-byte limit');
    zero.request(terrain([]), 1); expect(zero.advance()).toBe(true); expect(zero.getSnapshot()?.byteLength).toBe(0);
});

test('invalid limits, forged source/display handles and invalid slice/exaggeration inputs fail explicitly', () => {
    for (const limit of [-1, 0.5, NaN, Infinity]) for (const key of ['maxDisplayBytes', 'maxQueryIndexBytes']) expect(() => new GlobeTerrainDisplayPreparation({[key]: limit})).toThrow('byte limits');
    const display = new GlobeTerrainDisplayPreparation(), source = terrain([grid()]);
    for (const limit of [0, -1, NaN, Infinity]) expect(() => display.advance(limit)).toThrow('slice target');
    for (const multiplier of [-1, NaN, Infinity, 1001]) expect(() => display.request(source, multiplier)).toThrow('Invalid');
    expect(() => display.request({grids: [], resolution: 4, byteLength: 0}, 1)).toThrow('completed snapshot');
    expect(() => resolveGlobeTerrainDisplay({terrain: source, exaggeration: 1, byteLength: 0, maxDisplayBytes: 0, maxQueryIndexBytes: 0})).toThrow('library snapshot');
    expect(display.retry()).toBe(false);
});

test('query-policy changes rebuild only when acceleration no longer fits; errors and teardown release staged work', () => {
    const source = grid(), distant = grid(2000, [1000000, -100000, 1200000, 100000]), preparation = new GlobeTerrainPreparation();
    preparation.request([source], 4); while (preparation.isPending()) preparation.advance(1000);
    const display = new GlobeTerrainDisplayPreparation({maxQueryIndexBytes: 1000}); display.request(preparation.getSnapshot()!, 1); finish(display);
    const original = resolveGlobeTerrainDisplay(display.getSnapshot()!)[0]; original.surface.intersectRay({origin: [0, -400, 0], direction: [0, 1, 0]});
    expect(display.getStatistics().queryIndexBytes).toBeGreaterThan(0);
    preparation.request([source, distant], 4); while (preparation.isPending()) preparation.advance(1000);
    display.request(preparation.getSnapshot()!, 1); finish(display);
    const smallerQuota = resolveGlobeTerrainDisplay(display.getSnapshot()!)[0]; expect(smallerQuota.surface).not.toBe(original.surface);
    expect(smallerQuota.surface.intersectRay({origin: [0, -400, 0], direction: [0, 1, 0]})?.coordinate[2]).toBeCloseTo(1000);
    expect(display.getStatistics().queryIndexBytes).toBe(0);
    const negative = terrain([grid(-100000)]), physical = new GlobeTerrainDisplayPreparation(); physical.request(negative, 1); finish(physical); const previous = physical.getSnapshot();
    physical.request(negative, 100); finish(physical); expect(physical.getStatistics().error).toContain('elevation'); expect(physical.getSnapshot()).toBe(previous);
    display.request(preparation.getSnapshot()!, 50); let clock = 0; display.advance(1, () => clock++);
    expect(display.isPending()).toBe(true); display.destroy(); expect(display.getStatistics()).toMatchObject({retainedBytes: 0, queryIndexBytes: 0, pending: 0});
});

test('display warms picking before publication and cancellation releases partial query indexes', () => {
    const source = terrain([grid()], 16), display = new GlobeTerrainDisplayPreparation(); display.request(source, 1);
    let clock = 0;
    while (display.isPending() && display.getStatistics().queryIndexBytes === 0) display.advance(1, () => clock++);
    expect(display.isPending()).toBe(true); expect(display.getSnapshot()).toBeUndefined();
    expect(display.getStatistics().queryIndexBytes).toBeGreaterThan(0);
    display.request(source, 50); expect(display.getStatistics().queryIndexBytes).toBe(0); finish(display);
    const tile = resolveGlobeTerrainDisplay(display.getSnapshot()!)[0], before = tile.surface.getStatistics();
    expect(display.getStatistics()).toMatchObject({warmedIndexes: 1, deferredIndexes: 0, cancelled: 1});
    expect(before.queryIndexBytes).toBe(before.requiredQueryIndexBytes);
    expect(tile.surface.intersectRay({origin: [0, -400, 0], direction: [0, 1, 0]})?.coordinate[2]).toBeCloseTo(1000);
    expect(tile.surface.getStatistics()).toEqual(before);
    display.request(source, 100);
    while (display.isPending() && display.getStatistics().prepared === 0) display.advance(1, () => clock++);
    display.destroy(); expect(display.getStatistics().queryIndexBytes).toBe(0);
});

test('warming respects current-plus-staged acceleration budget without rejecting replacement geometry', () => {
    const source = terrain([grid()]), probe = new GlobeTerrainDisplayPreparation(); probe.request(source, 1); finish(probe);
    const required = resolveGlobeTerrainDisplay(probe.getSnapshot()!)[0].surface.getStatistics().requiredQueryIndexBytes;
    const display = new GlobeTerrainDisplayPreparation({maxQueryIndexBytes: required}); display.request(source, 1); finish(display);
    expect(display.getStatistics()).toMatchObject({queryIndexBytes: required, warmedIndexes: 1});
    const previous = display.getSnapshot(); display.request(source, 100);
    let clock = 0;
    while (display.isPending()) {display.advance(1, () => clock++); expect(display.getStatistics().queryIndexBytes).toBeLessThanOrEqual(required);}
    expect(display.getSnapshot()).not.toBe(previous); expect(display.getStatistics()).toMatchObject({deferredIndexes: 1, warmedIndexes: 0, queryIndexBytes: 0});
    const tile = resolveGlobeTerrainDisplay(display.getSnapshot()!)[0];
    // A cold displayed index can allocate between slices, so reserve it even before its first pick.
    display.request(source, 50);
    while (display.isPending() && display.getStatistics().prepared === 0) display.advance(1, () => clock++);
    expect(tile.surface.intersectRay({origin: [0, -400, 0], direction: [0, 1, 0]})?.coordinate[2]).toBeCloseTo(1000);
    expect(display.getStatistics().queryIndexBytes).toBe(required);
    finish(display); expect(display.getStatistics()).toMatchObject({deferredIndexes: 1, warmedIndexes: 0, queryIndexBytes: 0});
});
