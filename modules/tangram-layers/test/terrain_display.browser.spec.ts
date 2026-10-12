// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {GlobeTerrainPreparation, type TerrainHeightGrid} from '@vis.gl/tangram-renderer/map-logic';
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
