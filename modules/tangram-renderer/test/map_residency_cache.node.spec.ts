// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {TileResidency, TileCachePolicy, type TileCacheRecord} from '../src/map-logic/index';

/** Immutable metadata fixture without meshes, lifecycle methods or renderer types. */
function record(key: string, bytes = 100, protectedRecord = false): TileCacheRecord {
    return Object.freeze({key, bytes, protected: protectedRecord});
}

test('consumer snapshots copy inputs, union selections stably and protect visible fallback keys', () => {
    const residency = new TileResidency<string>();
    const selected = ['shared', 'left', 'shared'], visible = ['parent'];
    residency.attachConsumer('left');
    residency.updateConsumer('left', selected, visible);
    residency.updateConsumer('right', ['right', 'shared'], ['right-parent']);
    selected.push('later'); visible.length = 0;
    expect(residency.getSelectedTileKeys()).toEqual(['shared', 'left', 'right']);
    expect(residency.isProtected('parent')).toBe(true);
    expect(residency.isProtected('right-parent')).toBe(true);
    expect(residency.isProtected('right')).toBe(true);
    expect(residency.isProtected('later')).toBe(false);
    const snapshot = residency.getSelectedTileKeys(); snapshot.length = 0;
    expect(residency.getSelectedTileKeys()).toEqual(['shared', 'left', 'right']);
    residency.detachConsumer('left');
    expect(residency.isProtected('shared')).toBe(true);
    expect(residency.isProtected('parent')).toBe(false);
    residency.attachConsumer('right');
    expect(residency.isProtected('shared')).toBe(false);
    expect(residency.getSelectedTileKeys()).toEqual([]);
    residency.detachConsumer('absent'); residency.clear();
    expect(residency.isProtected('right')).toBe(false);
});

test('symbol consumers and instances remain isolated through replacement and teardown', () => {
    const first = new TileResidency(), second = new TileResidency();
    const left = Symbol('eye'), right = Symbol('eye');
    first.updateConsumer(left, ['shared'], []); first.updateConsumer(right, [], ['shared']);
    first.updateConsumer(left, [], []);
    expect(first.isProtected('shared')).toBe(true);
    expect(second.isProtected('shared')).toBe(false);
    first.clear();
    expect(first.getSelectedTileKeys()).toEqual([]);
    expect(first.isProtected('shared')).toBe(false);
});

test('LRU honors independent and combined budgets without mutating snapshots or touching recency', () => {
    const policy = new TileCachePolicy();
    const records = Object.freeze([record('old', 40), record('middle', 60), record('new', 100), record('pinned', 1000, true)]);
    records.forEach(record => policy.touch(record.key));
    expect(policy.selectEvictions(records)).toEqual([]);
    expect(policy.selectEvictions(records, {})).toEqual([]);
    expect(policy.selectEvictions(records, {maxCachedTiles: 2})).toEqual(['old']);
    expect(policy.selectEvictions(records, {maxCachedBytes: 100})).toEqual(['old', 'middle']);
    policy.touch('old');
    expect(policy.selectEvictions(records, {maxCachedTiles: 2, maxCachedBytes: 60})).toEqual(['middle', 'new']);
    expect(policy.selectEvictions(records, {maxCachedTiles: 0})).toEqual(['middle', 'new', 'old']);
    expect(policy.selectEvictions(records, {maxCachedBytes: 0})).toEqual(['middle', 'new', 'old']);
    expect(records.map(record => record.key)).toEqual(['old', 'middle', 'new', 'pinned']);
    expect(records.every(Object.isFrozen)).toBe(true);
    policy.forget('middle');
    expect(policy.selectEvictions(records, {maxCachedTiles: 2})).toEqual(['middle']);
    policy.clear();
    expect(policy.selectEvictions(records, {maxCachedTiles: 1})).toEqual(['old', 'middle']);
});

test('unknown keys preserve snapshot order on ties; zero-byte content still consumes the count budget', () => {
    const policy = new TileCachePolicy();
    const records = [record('zero', 0), record('first', 10), record('second', 10)];
    expect(policy.selectEvictions(records, {maxCachedBytes: 20})).toEqual([]);
    expect(policy.selectEvictions(records, {maxCachedTiles: 2})).toEqual(['zero']);
    expect(policy.selectEvictions(records, {maxCachedBytes: 10})).toEqual(['zero', 'first']);
    expect(policy.selectEvictions([], {maxCachedTiles: 0})).toEqual([]);
    expect(policy.selectEvictions([record('protected', 1000, true)], {maxCachedBytes: 0})).toEqual([]);
});

test('statistics are detached and do not evict, retain records or change access ordering', () => {
    const policy = new TileCachePolicy();
    const records = [record('first', 10), record('second', 20), record('protected', 100, true)];
    policy.touch('first'); policy.touch('second');
    const statistics = policy.getStatistics(records);
    expect(statistics).toEqual({residentTiles: 3, cachedTiles: 2, cachedBytes: 30, protectedTiles: 1, protectedBytes: 100});
    statistics.cachedTiles = 100;
    expect(policy.getStatistics(records).cachedTiles).toBe(2);
    expect(policy.selectEvictions(records, {maxCachedTiles: 1})).toEqual(['first']);
    expect(policy.getStatistics([])).toEqual({residentTiles: 0, cachedTiles: 0, cachedBytes: 0, protectedTiles: 0, protectedBytes: 0});
});

test('residency and policy compose without owning content or automatically refreshing recency', () => {
    const residency = new TileResidency<string>(), policy = new TileCachePolicy();
    residency.updateConsumer('left', ['left'], ['shared']);
    residency.updateConsumer('right', ['right'], ['shared']);
    const keys = ['cached', 'left', 'right', 'shared'];
    const snapshot = () => keys.map(key => record(key, 10, residency.isProtected(key)));
    expect(policy.selectEvictions(snapshot(), {maxCachedTiles: 0})).toEqual(['cached']);
    residency.detachConsumer('left');
    expect(policy.selectEvictions(snapshot(), {maxCachedTiles: 0})).toEqual(['cached', 'left']);
    residency.detachConsumer('right');
    expect(policy.selectEvictions(snapshot(), {maxCachedTiles: 0})).toEqual(keys);
    expect(keys).toEqual(['cached', 'left', 'right', 'shared']);
});
