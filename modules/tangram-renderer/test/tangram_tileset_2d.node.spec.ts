// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import TangramTileset2D from '../src/tile/tangram_tileset_2d';
import type {ResourceTile} from '../src/tile/tile_resource_cache';

/** Small resource envelope requiring no renderer, camera, network or GPU. */
function createTile(key: string): ResourceTile {
    return {key, visible: false, loading: false, built: true,
        meshes: {roads: [{buffer_size: 100}]}, isProxy: () => false};
}

test('retains source/style tile identities in legacy property order and exposes detached array views', () => {
    const tileset = new TangramTileset2D<ResourceTile>();
    const first = createTile('world/1/2/3/3'), overzoom = createTile('world/1/2/3/12');
    tileset.setTile(first); tileset.setTile(overzoom);
    expect(tileset.getTile(first.key)).toBe(first);
    expect(tileset.getTile('missing')).toBeUndefined();
    const snapshot = tileset.tiles;
    snapshot.pop();
    expect(tileset.tiles).toEqual([first, overzoom]);
    const replacement = createTile(first.key);
    tileset.setTile(replacement);
    expect(tileset.tiles).toEqual([replacement, overzoom]);
});

test('resource policy and pinned residency are shared by every consumer without disposing payloads', () => {
    const tileset = new TangramTileset2D<ResourceTile>();
    const cached = createTile('cached'), visible = {...createTile('visible'), visible: true}, pinned = createTile('pinned');
    tileset.setTile(cached); tileset.setTile(visible); tileset.setTile(pinned);
    tileset.setOptions({maxCachedTiles: 0, maxCachedMeshBytes: 0, maxConcurrentBuilds: 1});
    expect(tileset.getEvictionKeys(key => key === pinned.key)).toEqual([cached.key]);
    expect(tileset.getTile(cached.key)).toBe(cached);
    expect(tileset.getStatistics(key => key === pinned.key)).toMatchObject({residentTiles: 3,
        cachedTiles: 1, cachedMeshBytes: 100, protectedTiles: 2, protectedMeshBytes: 200});
    tileset.forgetTile(cached.key, tile => {
        expect(tile).toBe(cached);
        expect(tileset.getTile(tile.key)).toBe(cached);
        expect(tileset.buildQueue.has(tile.key)).toBe(false);
    });
    expect(tileset.getTile(cached.key)).toBeUndefined();
    tileset.setOptions(undefined);
    pinned.visible = false;
    expect(tileset.getEvictionKeys(() => false)).toEqual([]);
});

test('protected reuse updates LRU recency; completed off-screen data is evicted oldest first', () => {
    const tileset = new TangramTileset2D<ResourceTile>();
    const first = createTile('first'), second = createTile('second');
    tileset.setTile(first); tileset.setTile(second);
    tileset.setOptions({maxCachedTiles: 1});
    first.visible = true;
    expect(tileset.getEvictionKeys(() => false)).toEqual([]);
    first.visible = false;
    expect(tileset.getEvictionKeys(() => false)).toEqual([second.key]);
});

test('forgetting an active tile releases queue ownership but waits for adapter completion before pumping', () => {
    const tileset = new TangramTileset2D<ResourceTile>();
    tileset.setOptions({maxConcurrentBuilds: 1, maxCachedTiles: 0});
    const first = createTile('first'), second = createTile('second');
    tileset.setTile(first); tileset.setTile(second);
    const start = vi.fn();
    for (const tile of [first, second]) tileset.buildQueue.enqueue({key: tile.key, token: `${tile.key}/1`,
        priority: 0, start, fail: () => {}});
    expect(tileset.getEvictionKeys(() => false)).toEqual([]);
    tileset.forgetTile(first.key);
    expect(start).toHaveBeenCalledOnce();
    expect(tileset.getStatistics(() => false)).toMatchObject({activeBuilds: 0, queuedBuilds: 1, protectedTiles: 1});
    tileset.buildQueue.pump();
    expect(start).toHaveBeenCalledTimes(2);
    expect(tileset.buildQueue.finish(first.key, `${first.key}/1`)).toBe(false);
    tileset.buildQueue.finish(second.key, `${second.key}/1`);
    expect(tileset.getEvictionKeys(() => false)).toEqual([second.key]);
});

test('finalization stops queued work before delegating disposal and clears all ownership', () => {
    const tileset = new TangramTileset2D<ResourceTile>();
    const first = createTile('first'), second = createTile('second');
    tileset.setTile(first); tileset.setTile(second);
    tileset.setOptions({maxConcurrentBuilds: 1});
    const start = vi.fn(), unload = vi.fn((tile: ResourceTile) => {
        expect(tile).toBeDefined();
        expect(tileset.buildQueue.getCounts()).toEqual({activeBuilds: 0, queuedBuilds: 0});
    });
    for (const tile of [first, second]) tileset.buildQueue.enqueue({key: tile.key, token: 'generation', priority: 0,
        start, fail: () => {}});
    tileset.finalize(unload);
    expect(unload.mock.calls.map(call => call[0])).toEqual([first, second]);
    expect(start).toHaveBeenCalledOnce();
    expect(tileset.tiles).toEqual([]);
    expect(tileset.getStatistics(() => false)).toEqual({activeBuilds: 0, queuedBuilds: 0, residentTiles: 0,
        cachedTiles: 0, cachedMeshBytes: 0, protectedTiles: 0, protectedMeshBytes: 0});
    tileset.finalize(unload);
    expect(unload).toHaveBeenCalledTimes(2);
});

test('missing forgets do not invoke hierarchy callbacks and failed finalization does not hide undisposed content', () => {
    const tileset = new TangramTileset2D<ResourceTile>();
    const beforeDelete = vi.fn();
    tileset.forgetTile('missing', beforeDelete);
    expect(beforeDelete).not.toHaveBeenCalled();
    tileset.setTile(createTile('first'));
    const failure = new Error('dispose');
    expect(() => tileset.finalize(() => { throw failure; })).toThrow(failure);
    expect(tileset.tiles).toHaveLength(1);
    tileset.finalize(() => {});
    expect(tileset.tiles).toEqual([]);
});
