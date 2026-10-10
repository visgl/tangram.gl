// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import TileBuildQueue, {type TileBuildTask} from '../src/map-logic/tile-build-queue';
import TileResourceCache, {getTileMeshBytes, type ResourceTile} from '../src/tile/tile_resource_cache';

/** Deterministic task fixture with observable submission and failure. */
function createTask(key: string, priority = 0, token = `${key}/1`): TileBuildTask {
    return {key, token, priority, start: vi.fn(), fail: vi.fn()};
}

test('one shared build limit deduplicates eyes and releases slots only for matching generations', () => {
    const queue = new TileBuildQueue();
    queue.setLimit(1);
    const first = createTask('first');
    const second = createTask('second');
    queue.enqueue(first);
    queue.enqueue(first);
    queue.enqueue(second);
    expect(queue.getCounts()).toEqual({activeBuilds: 1, queuedBuilds: 1});
    expect(first.start).toHaveBeenCalledTimes(1);
    expect(second.start).not.toHaveBeenCalled();
    expect(queue.finish(first.key, 'stale')).toBe(false);
    expect(queue.finish(first.key, first.token)).toBe(true);
    expect(second.start).toHaveBeenCalledTimes(1);
    expect(queue.finish(first.key, first.token)).toBe(false);
    queue.finish(second.key, second.token);
    expect(queue.getCounts()).toEqual({activeBuilds: 0, queuedBuilds: 0});
});

test('unsent visible work takes priority over preload and cached work with stable ties', () => {
    const queue = new TileBuildQueue();
    queue.setLimit(1);
    const active = createTask('active');
    const order: string[] = [];
    queue.enqueue(active);
    for (const [key, priority] of [['cache', 2], ['preload', 1], ['left', 0], ['right', 0]] as const) {
        queue.enqueue({...createTask(key, priority), start: () => { order.push(key); }});
    }
    queue.finish(active.key, active.token);
    expect(order).toEqual(['left']);
    queue.finish('left', 'left/1');
    expect(order).toEqual(['left', 'right']);
    queue.setPriority('cache', 0);
    queue.finish('right', 'right/1');
    expect(order).toEqual(['left', 'right', 'cache']);
    queue.finish('cache', 'cache/1');
    expect(order).toEqual(['left', 'right', 'cache', 'preload']);
});

test('nested visibility batches install all new visible tasks before filling slots from old preload work', () => {
    const queue = new TileBuildQueue();
    queue.setLimit(1);
    const active = createTask('active'), preload = createTask('preload', 1);
    queue.enqueue(active); queue.enqueue(preload);
    queue.suspend(); queue.suspend();
    queue.setLimit(3);
    const left = createTask('left'), right = createTask('right');
    queue.enqueue(left); queue.enqueue(right);
    queue.resume();
    expect(left.start).not.toHaveBeenCalled();
    queue.resume();
    expect(left.start).toHaveBeenCalledOnce();
    expect(right.start).toHaveBeenCalledOnce();
    expect(preload.start).not.toHaveBeenCalled();
    queue.finish(active.key, active.token);
    expect(preload.start).toHaveBeenCalledOnce();
});

test('a newer generation waits for the active generation and replaces only unsent work', () => {
    const queue = new TileBuildQueue();
    queue.setLimit(2);
    const old = createTask('tile', 0, 'tile/old');
    const replaced = createTask('tile', 0, 'tile/replaced');
    const newest = createTask('tile', 0, 'tile/newest');
    queue.enqueue(old); queue.enqueue(replaced); queue.enqueue(newest);
    expect(queue.getCounts()).toEqual({activeBuilds: 1, queuedBuilds: 1});
    queue.finish(old.key, old.token);
    expect(newest.start).toHaveBeenCalledOnce();
    expect(replaced.start).not.toHaveBeenCalled();
    expect(queue.finish(old.key, old.token)).toBe(false);
    expect(queue.has('tile')).toBe(true);
});

test('lowering limits never aborts active builds; omission restores unlimited submission', () => {
    const queue = new TileBuildQueue();
    const tasks = ['first', 'second', 'third'].map(key => createTask(key));
    queue.enqueue(tasks[0]); queue.enqueue(tasks[1]);
    queue.setLimit(1); queue.enqueue(tasks[2]);
    expect(queue.getCounts()).toEqual({activeBuilds: 2, queuedBuilds: 1});
    queue.finish(tasks[0].key, tasks[0].token);
    expect(tasks[2].start).not.toHaveBeenCalled();
    queue.setLimit(undefined); queue.pump();
    expect(tasks[2].start).toHaveBeenCalledOnce();
});

test('cancellation and teardown remove ownership without starting cancelled work', () => {
    const queue = new TileBuildQueue();
    queue.setLimit(1);
    const active = createTask('active'), cancelled = createTask('cancelled'), next = createTask('next');
    queue.enqueue(active); queue.enqueue(cancelled); queue.enqueue(next);
    queue.cancel(cancelled.key); queue.cancel(active.key); queue.pump();
    expect(cancelled.start).not.toHaveBeenCalled();
    expect(next.start).toHaveBeenCalledOnce();
    const counts = queue.getCounts(); counts.activeBuilds = 200;
    expect(queue.getCounts().activeBuilds).toBe(1);
    queue.clear();
    expect(queue.has(next.key)).toBe(false);
    expect(queue.finish(next.key, next.token)).toBe(false);
});

test('synchronous failure and synchronous completion do not strand later work', () => {
    const queue = new TileBuildQueue();
    queue.setLimit(1);
    const initial = createTask('initial'); queue.enqueue(initial);
    const failed = createTask('failed');
    failed.start = () => { throw new Error('fixture'); };
    const complete = createTask('complete');
    complete.start = () => { queue.finish(complete.key, complete.token); };
    const last = createTask('last');
    queue.enqueue(failed); queue.enqueue(complete); queue.enqueue(last);
    queue.finish(initial.key, initial.token);
    expect(failed.fail).toHaveBeenCalledWith(expect.objectContaining({message: 'fixture'}));
    expect(last.start).toHaveBeenCalledOnce();
    expect(queue.getCounts()).toEqual({activeBuilds: 1, queuedBuilds: 0});
});

/** Small, backend-independent tile cache entry. */
function createTile(key: string, bytes = 100): ResourceTile {
    return {key, built: true, visible: false, loading: false,
        meshes: {polygons: [{buffer_size: bytes}]}, isProxy: () => false};
}

test('mesh accounting includes globe variants and pending labels without double counting', () => {
    const tile = createTile('tile');
    const mesh = {buffer_size: 100, globe_mesh: {buffer_size: 200}};
    tile.meshes = {polygons: [mesh, mesh]};
    tile.pending_label_meshes = {labels: [mesh, {buffer_size: 32}, {buffer_size: Infinity}, {buffer_size: -1}, {}]};
    expect(getTileMeshBytes(tile)).toBe(332);
    mesh.globe_mesh.buffer_size = 400;
    expect(getTileMeshBytes(tile)).toBe(532);
});

test('LRU cache satisfies both count and byte caps and updates recency when a tile is reused', () => {
    const cache = new TileResourceCache();
    const tiles = ['old', 'middle', 'new'].map(key => createTile(key));
    for (const tile of tiles) cache.touch(tile.key);
    expect(cache.selectEvictions(tiles, {maxCachedTiles: 2}, () => false)).toEqual(['old']);
    cache.touch('old');
    expect(cache.selectEvictions(tiles, {maxCachedTiles: 2, maxCachedMeshBytes: 100}, () => false))
        .toEqual(['middle', 'new']);
    expect(cache.selectEvictions(tiles, {maxCachedTiles: 0}, () => false)).toEqual(['middle', 'new', 'old']);
    expect(cache.selectEvictions(tiles, undefined, () => false)).toEqual([]);
    cache.forget('middle'); cache.clear();
    expect(cache.selectEvictions(tiles, {maxCachedMeshBytes: 0}, () => false)).toEqual(['old', 'middle', 'new']);
});

test('zero cache budgets protect visible, proxy, pinned, active and incomplete tiles', () => {
    const cache = new TileResourceCache();
    const cached = createTile('cached');
    const visible = {...createTile('visible'), visible: true};
    const proxy = {...createTile('proxy'), isProxy: () => true};
    const loading = {...createTile('loading'), loading: true};
    const queued = {...createTile('queued'), built: false};
    const pinned = createTile('pinned');
    const tiles = [cached, visible, proxy, loading, queued, pinned];
    expect(cache.selectEvictions(tiles, {maxCachedTiles: 0, maxCachedMeshBytes: 0}, key => key === 'pinned'))
        .toEqual(['cached']);
    const statistics = cache.getStatistics(tiles, key => key === 'pinned', {activeBuilds: 1, queuedBuilds: 1});
    expect(statistics).toEqual({activeBuilds: 1, queuedBuilds: 1, residentTiles: 6,
        cachedTiles: 1, cachedMeshBytes: 100, protectedTiles: 5, protectedMeshBytes: 500});
    statistics.cachedTiles = 200;
    expect(cache.getStatistics(tiles, key => key === 'pinned', {activeBuilds: 1, queuedBuilds: 1}).cachedTiles).toBe(1);
});
