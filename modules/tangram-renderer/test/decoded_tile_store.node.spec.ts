// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import {Tileset2D} from '@loaders.gl/tiles';
import DecodedTileStore from '../src/sources/decoded_tile_store';

/** Deterministic completion for cancellation and source-revision races. */
function createDeferred<ValueT>() {
    let resolve: (value: ValueT) => void = () => {};
    let reject: (error: unknown) => void = () => {};
    const promise = new Promise<ValueT>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
    return {promise, resolve, reject};
}

test('one acquisition serves pending and ready leases, and final release leaves no warm record', async () => {
    const store = new DecodedTileStore<{byteLength: number}>(value => value.byteLength);
    const source = {}, content = {byteLength: 32}, deferred = createDeferred<typeof content>();
    const load = vi.fn(() => deferred.promise);
    const first = store.acquireTile({source, key: '0/0/0', load});
    const second = store.acquireTile({source, key: '0/0/0', load});
    await Promise.resolve(); expect(load).toHaveBeenCalledOnce();
    expect(store.getStatistics()).toMatchObject({loadingTiles: 1, consumers: 2, sharedAcquisitions: 1});
    deferred.resolve(content);
    expect(await first.promise).toBe(content); expect(await second.promise).toBe(content);
    const third = store.acquireTile({source, key: '0/0/0', load});
    expect(await third.promise).toBe(content);
    expect(store.getStatistics()).toMatchObject({readyTiles: 1, consumers: 3, decodedBytes: 32});
    first.release(); first.release(); second.release();
    expect(first.isActive()).toBe(false); expect(third.isActive()).toBe(true);
    third.release(); expect(store.getStatistics()).toMatchObject({loadingTiles: 0, readyTiles: 0, consumers: 0, decodedBytes: 0});
});

test('one pending consumer cancels independently; the final consumer alone aborts the request', async () => {
    const store = new DecodedTileStore<number>(), source = {}, deferred = createDeferred<number>();
    const signals: AbortSignal[] = [];
    const load = (signal: AbortSignal) => { signals.push(signal); return deferred.promise; };
    const first = store.acquireTile({source, key: 'tile', load}), second = store.acquireTile({source, key: 'tile', load});
    await Promise.resolve();
    const rejected = expect(first.promise).rejects.toMatchObject({name: 'AbortError'});
    first.release(); await rejected; expect(signals[0].aborted).toBe(false);
    const finalRejected = expect(second.promise).rejects.toMatchObject({name: 'AbortError'});
    second.release(); await finalRejected; expect(signals[0].aborted).toBe(true);
    deferred.resolve(1); await deferred.promise; await Promise.resolve();
    expect(store.getStatistics()).toMatchObject({readyTiles: 0, cancelledAcquisitions: 1});
});

test('cancellation before scheduling never starts the provider', async () => {
    const store = new DecodedTileStore<number>(), load = vi.fn(async () => 1);
    const lease = store.acquireTile({source: {}, key: 'tile', load});
    const rejected = expect(lease.promise).rejects.toMatchObject({name: 'AbortError'});
    lease.release(); await rejected; await Promise.resolve();
    expect(load).not.toHaveBeenCalled(); expect(store.getStatistics().failedAcquisitions).toBe(0);
});

test('a stale attempt cannot publish over a recreated coordinate', async () => {
    const store = new DecodedTileStore<string>(), source = {}, old = createDeferred<string>(), next = createDeferred<string>();
    const first = store.acquireTile({source, key: 'tile', load: () => old.promise});
    await Promise.resolve();
    const rejected = expect(first.promise).rejects.toMatchObject({name: 'AbortError'});
    first.release(); await rejected;
    const second = store.acquireTile({source, key: 'tile', load: () => next.promise});
    old.resolve('obsolete'); next.resolve('current');
    expect(await second.promise).toBe('current');
    expect(store.getStatistics()).toMatchObject({readyTiles: 1, acquisitions: 2});
    second.release();
});

test('source invalidation rejects pending leases and never cancels another source revision', async () => {
    const store = new DecodedTileStore<string>(), oldSource = {}, newSource = {}, deferred = createDeferred<string>();
    const first = store.acquireTile({source: oldSource, key: 'tile', load: () => deferred.promise});
    await Promise.resolve();
    const rejected = expect(first.promise).rejects.toMatchObject({name: 'AbortError'});
    const second = store.acquireTile({source: newSource, key: 'tile', load: async () => 'new'});
    store.invalidateSource(oldSource); await rejected;
    deferred.resolve('old'); expect(await second.promise).toBe('new');
    expect(first.isActive()).toBe(false); expect(second.isActive()).toBe(true);
    store.invalidateSource(oldSource); store.finalize();
    expect(second.isActive()).toBe(false); expect(store.getStatistics().consumers).toBe(0);
});

test('ready leases lose ownership on invalidation even if their promises already resolved', async () => {
    const store = new DecodedTileStore<number>(), source = {};
    const lease = store.acquireTile({source, key: 'tile', load: async () => 1});
    await lease.promise; store.invalidateSource(source);
    expect(lease.isActive()).toBe(false); expect(store.getStatistics().cancelledAcquisitions).toBe(0);
    lease.release();
});

test.each(['sync', 'async'])('%s acquisition failure rejects every consumer and permits an explicit retry', async mode => {
    const store = new DecodedTileStore<number>(), source = {}, failure = new Error('decode');
    const load = () => { if (mode === 'sync') throw failure; return Promise.reject(failure); };
    const first = store.acquireTile({source, key: 'tile', load}), second = store.acquireTile({source, key: 'tile', load});
    await Promise.all([expect(first.promise).rejects.toBe(failure), expect(second.promise).rejects.toBe(failure)]);
    expect(store.getStatistics()).toMatchObject({failedAcquisitions: 1, consumers: 0});
    const retry = store.acquireTile({source, key: 'tile', load: async () => 2});
    expect(await retry.promise).toBe(2); first.release(); second.release();
    expect(retry.isActive()).toBe(true); retry.release();
});

test.each([undefined, Number.NaN, -1, Infinity, 0, 32])('decoded byte accounting treats %s as an allocation estimate, never encoded bytes', async bytes => {
    const store = new DecodedTileStore<number>(() => bytes), lease = store.acquireTile({source: {}, key: 'tile', load: async () => 1});
    await lease.promise;
    const expected = bytes !== undefined && Number.isFinite(bytes) && bytes >= 0 ? bytes : undefined;
    expect(store.getStatistics().decodedBytes).toBe(expected); store.finalize();
});

test('unwrapped coordinate identities and separate source revisions never collapse', async () => {
    const store = new DecodedTileStore<number>(), source = {}, load = vi.fn(async () => 1);
    const leases = [store.acquireTile({source, key: '-1/0/1', load}), store.acquireTile({source, key: '1/0/1', load}),
        store.acquireTile({source: {}, key: '1/0/1', load})];
    await Promise.all(leases.map(lease => lease.promise)); expect(load).toHaveBeenCalledTimes(3);
    store.finalize(); expect(leases.every(lease => !lease.isActive())).toBe(true);
});

test('repeated acquire/release cycles and finalization do not accumulate records or leases', async () => {
    const store = new DecodedTileStore<number>(), source = {};
    for (let iteration = 0; iteration < 50; iteration++) {
        const lease = store.acquireTile({source, key: 'tile', load: async () => iteration});
        expect(await lease.promise).toBe(iteration); lease.release();
    }
    expect(store.getStatistics()).toMatchObject({consumers: 0, readyTiles: 0, loadingTiles: 0, acquisitions: 50});
    const deferred = createDeferred<number>(), lease = store.acquireTile({source, key: 'pending', load: () => deferred.promise});
    const rejected = expect(lease.promise).rejects.toMatchObject({name: 'AbortError'});
    store.finalize(); store.finalize(); await rejected; deferred.resolve(1);
    const successor = store.acquireTile({source, key: 'pending', load: async () => 2});
    expect(await successor.promise).toBe(2); successor.release();
});

test('published loaders.gl and Tangram share one XYZ acquisition but retain different ownership policies', async () => {
    const store = new DecodedTileStore<number>(), source = {}, tangramLoad = vi.fn(async () => 1), loadersLoad = vi.fn(() => 1);
    const loaders = new Tileset2D({getTileData: loadersLoad, maxRequests: 0, adapter: {
        getTileIndices: () => [], getTileBoundingBox: () => ({west: -180, south: -85, east: 180, north: 85})
    }});
    loaders.getTileIndices({viewState: null, zRange: null});
    const first = store.acquireTile({source, key: '0/0/0', load: tangramLoad}), second = store.acquireTile({source, key: '0/0/0', load: tangramLoad});
    const header = loaders.getTile({x: 0, y: 0, z: 0}, true);
    expect(loaders.getTile({x: 0, y: 0, z: 0}, true)).toBe(header);
    await Promise.all([first.promise, second.promise, header.data]);
    expect(tangramLoad).toHaveBeenCalledOnce(); expect(loadersLoad).toHaveBeenCalledOnce();
    first.release(); expect(second.isActive()).toBe(true); second.release();
    expect(store.getStatistics().readyTiles).toBe(0);
    expect(loaders.getTile({x: 0, y: 0, z: 0})).toBe(header); // loaders keeps a warm cache; Tangram does not.
    loaders.finalize();
});

test.each([1, 2])('unique loads obey capacity %d while pending and ready duplicate leases use no extra slot', async limit => {
    const store = new DecodedTileStore<number>(undefined, {maxConcurrentLoads: limit}), source = {};
    const pending = Array.from({length: 5}, () => createDeferred<number>());
    const started: number[] = [];
    let active = 0, peak = 0;
    const leases = pending.map((deferred, index) => store.acquireTile({source, key: String(index), load: () => {
        started.push(index); active++; peak = Math.max(peak, active);
        return deferred.promise.finally(() => { active--; });
    }}));
    const duplicate = store.acquireTile({source, key: '0', load: vi.fn(async () => -1)});
    expect(store.getStatistics()).toMatchObject({queuedTiles: 5, activeAcquisitions: 0, acquisitions: 0, sharedAcquisitions: 1});
    await Promise.resolve();
    expect(started).toEqual(Array.from({length: limit}, (_, index) => index));
    expect(store.getStatistics()).toMatchObject({queuedTiles: 5 - limit, activeAcquisitions: limit, maxConcurrentLoads: limit});
    for (let index = 0; index < pending.length; index++) {
        await vi.waitFor(() => expect(started).toContain(index), {interval: 1});
        pending[index].resolve(index);
    }
    expect(await Promise.all(leases.map(lease => lease.promise))).toEqual([0, 1, 2, 3, 4]);
    expect(await duplicate.promise).toBe(0);
    const ready = store.acquireTile({source, key: '0', load: vi.fn(async () => -1)});
    expect(await ready.promise).toBe(0);
    expect(peak).toBe(limit);
    await vi.waitFor(() => expect(store.getStatistics()).toMatchObject({queuedTiles: 0, activeAcquisitions: 0, acquisitions: 5}), {interval: 1});
    store.finalize();
});

test('queued cancellation never invokes its provider and a recreated key joins the end of the queue', async () => {
    const store = new DecodedTileStore<number>(undefined, {maxConcurrentLoads: 1}), source = {}, running = createDeferred<number>();
    const first = store.acquireTile({source, key: 'running', load: () => running.promise});
    const cancelledLoad = vi.fn(async () => -1);
    const cancelled = store.acquireTile({source, key: 'queued', load: cancelledLoad});
    const duplicate = store.acquireTile({source, key: 'queued', load: cancelledLoad});
    await Promise.resolve();
    const cancelledResult = expect(cancelled.promise).rejects.toMatchObject({name: 'AbortError'});
    const duplicateResult = expect(duplicate.promise).rejects.toMatchObject({name: 'AbortError'});
    cancelled.release(); expect(store.getStatistics().queuedTiles).toBe(1);
    duplicate.release(); await Promise.all([cancelledResult, duplicateResult]);
    const started: string[] = [];
    const next = store.acquireTile({source, key: 'next', load: async () => { started.push('next'); return 2; }});
    const retry = store.acquireTile({source, key: 'queued', load: async () => { started.push('retry'); return 3; }});
    running.resolve(1);
    expect(await Promise.all([first.promise, next.promise, retry.promise])).toEqual([1, 2, 3]);
    expect(started).toEqual(['next', 'retry']);
    expect(cancelledLoad).not.toHaveBeenCalled();
    expect(store.getStatistics()).toMatchObject({acquisitions: 3, cancelledAcquisitions: 1});
    store.finalize();
});

test('an aborted non-cooperative procedure retains its slot until settlement and cannot publish late content', async () => {
    const store = new DecodedTileStore<string>(undefined, {maxConcurrentLoads: 1}), source = {}, pending = createDeferred<string>();
    let signal: AbortSignal | undefined;
    const retired = store.acquireTile({source, key: 'tile', load: requestSignal => { signal = requestSignal; return pending.promise; }});
    await Promise.resolve();
    const rejected = expect(retired.promise).rejects.toMatchObject({name: 'AbortError'});
    retired.release(); await rejected;
    const load = vi.fn(async () => 'current');
    const current = store.acquireTile({source, key: 'tile', load});
    await Promise.resolve();
    expect(signal?.aborted).toBe(true);
    expect(load).not.toHaveBeenCalled();
    expect(store.getStatistics()).toMatchObject({loadingTiles: 1, activeAcquisitions: 1, queuedTiles: 1});
    pending.resolve('obsolete');
    expect(await current.promise).toBe('current');
    expect(store.getStatistics()).toMatchObject({readyTiles: 1, failedAcquisitions: 0});
    store.finalize();
});

test.each(['sync', 'async'])('%s failure releases a capacity slot and queued work continues', async mode => {
    const store = new DecodedTileStore<number>(undefined, {maxConcurrentLoads: 1}), source = {};
    const failed = store.acquireTile({source, key: 'failure', load: () => {
        if (mode === 'sync') throw new Error('decode failed');
        return Promise.reject(new Error('decode failed'));
    }});
    const next = store.acquireTile({source, key: 'next', load: async () => 2});
    await expect(failed.promise).rejects.toThrow('decode failed');
    expect(await next.promise).toBe(2);
    await vi.waitFor(() => expect(store.getStatistics()).toMatchObject({failedAcquisitions: 1, activeAcquisitions: 0, queuedTiles: 0}), {interval: 1});
    store.finalize();
});

test('source invalidation and finalize remove queued work without resetting unfinished procedure accounting', async () => {
    const store = new DecodedTileStore<number>(undefined, {maxConcurrentLoads: 1}), running = createDeferred<number>(), source = {};
    const first = store.acquireTile({source: {}, key: 'running', load: () => running.promise});
    const load = vi.fn(async () => 2), queued = store.acquireTile({source, key: 'queued', load});
    await Promise.resolve();
    const rejectedQueued = expect(queued.promise).rejects.toMatchObject({name: 'AbortError'});
    store.invalidateSource(source); await rejectedQueued;
    const rejectedRunning = expect(first.promise).rejects.toMatchObject({name: 'AbortError'});
    store.finalize(); store.finalize(); await rejectedRunning;
    expect(store.getStatistics()).toMatchObject({consumers: 0, queuedTiles: 0, activeAcquisitions: 1});
    running.resolve(1);
    await vi.waitFor(() => expect(store.getStatistics().activeAcquisitions).toBe(0), {interval: 1});
    expect(load).not.toHaveBeenCalled();
    const next = store.acquireTile({source, key: 'queued', load});
    expect(await next.promise).toBe(2); store.finalize();
});

test.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])('invalid capacity %s fails before acquiring any source', value => {
    expect(() => new DecodedTileStore(undefined, {maxConcurrentLoads: value})).toThrow('positive safe integer');
});

test('the published loaders.gl tileset and Tangram independently enforce the same unique-request capacity', async () => {
    const source = {}, store = new DecodedTileStore<number>(undefined, {maxConcurrentLoads: 1});
    const tangramPending = Array.from({length: 3}, () => createDeferred<number>());
    const loadersPending = Array.from({length: 3}, () => createDeferred<number>());
    const tangramLoad = vi.fn((index: number) => tangramPending[index].promise);
    const loadersLoad = vi.fn(({index}: {index: {x: number}}) => loadersPending[index.x].promise);
    const loaders = new Tileset2D<number>({getTileData: loadersLoad, maxRequests: 1, adapter: {
        getTileIndices: () => [], getTileBoundingBox: () => ({west: -180, south: -85, east: 180, north: 85})
    }});
    loaders.getTileIndices({viewState: null, zRange: null});
    const leases = tangramPending.map((_pending, index) => store.acquireTile({source, key: `${index}/0/2`, load: () => tangramLoad(index)}));
    const headers = loadersPending.map((_pending, index) => loaders.getTile({x: index, y: 0, z: 2}, true));
    try {
        for (let index = 0; index < 3; index++) {
            await vi.waitFor(() => {
                expect(tangramLoad).toHaveBeenCalledTimes(index + 1);
                expect(loadersLoad).toHaveBeenCalledTimes(index + 1);
            }, {interval: 1});
            tangramPending[index].resolve(index); loadersPending[index].resolve(index);
        }
        expect(await Promise.all(leases.map(lease => lease.promise))).toEqual([0, 1, 2]);
        expect(await Promise.all(headers.map(header => header.data))).toEqual([0, 1, 2]);
    } finally { store.finalize(); loaders.finalize(); }
});
