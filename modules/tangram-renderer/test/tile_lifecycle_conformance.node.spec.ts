// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import {Tileset2D} from '@loaders.gl/tiles';
import TangramTileset2D from '../src/tile/tangram_tileset_2d';
import TilePyramid from '../src/tile/tile_pyramid';
import {TileID} from '../src/tile/tile_id';
import type {TileCoordinates} from '../src/tile/tile_id';
import type {ResourceTile} from '../src/tile/tile_resource_cache';
import TangramTileTraversalAdapter from '../src/tile/tile_traversal_adapter';
import type {TangramTraversalState} from '../src/tile/tile_traversal_adapter';
import {WebMercatorVisibilityAdapter, WebMercatorGlobeVisibilityAdapter} from '../src/scene/visibility_adapter';
import TangramTileSourceAdapter from '../src/sources/tile_source_adapter';
import type {TileSourceContext} from '../src/sources/tile_source_adapter';
import AlignedTangramTileSource from '../src/sources/aligned_tile_source';

/** Small resource fixture; decoded bytes and GPU bytes are deliberately distinct concepts. */
function createResident(index: TileCoordinates): ResourceTile {
    return {key: TileID.coordKey(index), visible: false, built: true, loading: false,
        meshes: {roads: [{buffer_size: 100}]}, isProxy: () => false};
}

/** Published engine with immediate hermetic content and the real Tangram traversal adapter. */
function createLoaders(options: {maxCacheSize?: number; maxCacheByteSize?: number; onTileUnload?: (tile: {index: TileCoordinates}) => void} = {}) {
    const adapter = new TangramTileTraversalAdapter(new WebMercatorVisibilityAdapter(), new WebMercatorGlobeVisibilityAdapter());
    const loaders = new Tileset2D<{byteLength: number}, TangramTraversalState>({adapter, maxRequests: 0,
        getTileData: () => ({byteLength: 100}), ...options});
    loaders.getTileIndices({viewState: {eyes: []}, zRange: null});
    return loaders;
}

test('two consumers protect the same selected data tile; detaching one cannot evict the other', async () => {
    const index = {x: 0, y: 0, z: 1}, first = Symbol('left'), second = Symbol('right');
    const tangram = new TangramTileset2D<ResourceTile>(), loaders = createLoaders({maxCacheSize: 0});
    try {
        const resident = createResident(index); tangram.setTile(resident); tangram.setOptions({maxCachedTiles: 0});
        tangram.attachConsumer(first); tangram.attachConsumer(second);
        loaders.attachConsumer(first); loaders.attachConsumer(second);
        const shared = loaders.getTile(index, true);
        const completion = shared.data;
        loaders.updateConsumer(first, [shared], [shared]); loaders.updateConsumer(second, [shared], [shared]);
        tangram.updateConsumer(first, [resident.key], [resident.key]); tangram.updateConsumer(second, [resident.key], [resident.key]);
        await completion;
        expect(loaders.getTile(index, true)).toBe(shared);
        expect(tangram.selectedTileKeys).toEqual([resident.key]);
        expect(loaders.selectedTiles.map(tile => TileID.coordKey(tile.index))).toEqual(tangram.selectedTileKeys);
        tangram.detachConsumer(first); loaders.detachConsumer(first);
        expect(tangram.getEvictionKeys(() => false)).toEqual([]); expect(loaders.getTile(index)).toBe(shared);
        tangram.detachConsumer(second); loaders.detachConsumer(second);
        expect(tangram.getEvictionKeys(() => false)).toEqual([resident.key]); expect(loaders.getTile(index)).toBeUndefined();
    } finally { loaders.finalize(); tangram.finalize(() => {}); }
});

test('LRU eviction compares candidate order and unload ownership after equal-sized content is retained', async () => {
    const unloaded: string[] = [], first = {x: 0, y: 0, z: 1}, second = {x: 1, y: 0, z: 1};
    const loaders = createLoaders({onTileUnload: tile => unloaded.push(TileID.coordKey(tile.index))});
    const tangram = new TangramTileset2D<ResourceTile>();
    try {
        for (const index of [first, second]) {
            tangram.setTile(createResident(index)); await loaders.getTile(index, true).data;
        }
        loaders.setOptions({maxCacheSize: 1}); loaders.updateConsumer(Symbol('empty'), [], []);
        tangram.setOptions({maxCachedTiles: 1});
        expect(tangram.getEvictionKeys(() => false)).toEqual(unloaded);
        expect(unloaded).toEqual(['0/0/1']);
        const disposal = vi.fn();
        for (const key of tangram.getEvictionKeys(() => false)) {
            const content = tangram.getTile(key); disposal(content); tangram.forgetTile(key);
        }
        expect(disposal).toHaveBeenCalledOnce();
        expect(tangram.tiles.map(tile => tile.key)).toEqual(loaders.tiles.map(tile => TileID.coordKey(tile.index)));
    } finally { loaders.finalize(); tangram.finalize(() => {}); }
});

test('cache limits intentionally differ: loaders counts all decoded bytes; Tangram caps only off-screen mesh bytes', async () => {
    const index = {x: 0, y: 0, z: 1}, consumer = Symbol('visible');
    const loaders = createLoaders({maxCacheByteSize: 100}), tangram = new TangramTileset2D<ResourceTile>();
    try {
        const visible = loaders.getTile(index, true); const completion = visible.data;
        loaders.updateConsumer(consumer, [visible], [visible]); await completion;
        const offscreen = {x: 1, y: 0, z: 1};
        await loaders.getTile(offscreen, true).data;
        tangram.setTile({...createResident(index), visible: true}); tangram.setTile(createResident(offscreen));
        tangram.setOptions({maxCachedMeshBytes: 100});
        expect(loaders.getTile(offscreen)).toBeUndefined();
        expect(tangram.getEvictionKeys(() => false)).toEqual([]);
        expect(tangram.getStatistics(() => false)).toMatchObject({cachedMeshBytes: 100, protectedMeshBytes: 100});
    } finally { loaders.finalize(); tangram.finalize(() => {}); }
});

test('both hierarchies retain the nearest loaded ancestor while finer content is missing', async () => {
    const source = {name: 'world', id: 1, zooms: [0, 1, 2]}, parentIndex = {x: 0, y: 0, z: 1}, childIndex = {x: 1, y: 1, z: 2};
    const parent = {source, coords: parentIndex, style_z: 1, key: TileID.key(parentIndex, source, 1), loaded: true};
    const child = {source, coords: childIndex, style_z: 2, key: TileID.key(childIndex, source, 2), loaded: false};
    const pyramid = new TilePyramid(), loaders = createLoaders();
    try {
        pyramid.addTile(parent); pyramid.addTile(child);
        const loaded = loaders.getTile(parentIndex, true); await loaded.data;
        const pending = loaders.getTile(childIndex, true); loaders.prepareTiles();
        expect(pyramid.getAncestor(child)?.coords).toEqual(pending.parent?.index);
        expect(pending.parent).toBe(loaded);
        expect(pyramid.getAncestor(child)).toBe(parent);
        await pending.data;
    } finally { loaders.finalize(); pyramid.removeTile(child); pyramid.removeTile(parent); }
});

test('published engine deduplicates in-flight XYZ; Tangram retains distinct style/build identities', async () => {
    let calls = 0;
    const loaders = createLoaders(), tangram = new TangramTileset2D<ResourceTile>();
    loaders.setOptions({getTileData: () => { calls++; return {byteLength: 100}; }});
    try {
        const index = {x: 0, y: 0, z: 1};
        const first = loaders.getTile(index, true), second = loaders.getTile(index, true);
        expect(second).toBe(first); await first.data; expect(calls).toBe(1);
        tangram.setTile({...createResident(index), key: 'world/0/0/1/1'});
        tangram.setTile({...createResident(index), key: 'world/0/0/1/12'});
        expect(tangram.tiles).toHaveLength(2);
        // The source procedure, not the mesh tileset, handles cross-style decoded reuse.
        const reference: TileSourceContext = {source: 'world', coords: {...index, key: '0/0/1'}, loaded: true, source_data: {layers: {roads: {}}}};
        const destination: TileSourceContext = {source: 'world', coords: reference.coords};
        const source = {load: vi.fn(async (context: TileSourceContext) => context), copyTileData: (previous: TileSourceContext, next: TileSourceContext) => {
            next.source_data = {layers: previous.source_data?.layers}; return next;
        }};
        await new TangramTileSourceAdapter(source, () => [reference]).getTileData({index, id: 'style-12', context: destination});
        expect(source.load).not.toHaveBeenCalled(); expect(destination.source_data?.layers).toBe(reference.source_data?.layers);
    } finally { loaders.finalize(); tangram.finalize(() => {}); }
});

test('a failed published request retries explicitly, while Tangram rejects without caching a decoded payload', async () => {
    let attempts = 0;
    const loaders = createLoaders();
    loaders.setOptions({getTileData: () => { if (++attempts === 1) throw new Error('decode'); return {byteLength: 100}; }});
    try {
        const index = {x: 0, y: 0, z: 1}, failed = loaders.getTile(index, true);
        await failed.data; expect(failed.hasError).toBe(true);
        // Failure is a cached state, not an implicit retry loop.
        expect(loaders.getTile(index, true)).toBe(failed); expect(attempts).toBe(1);
        failed.setNeedsReload(); await loaders.getTile(index, true).data;
        expect(failed.hasError).toBe(false); expect(attempts).toBe(2);
        let legacyAttempts = 0;
        const source = {load: async (context: TileSourceContext) => {
            if (++legacyAttempts === 1) throw new Error('decode'); context.source_data = {layers: {}}; return context;
        }, copyTileData: (_previous: TileSourceContext, next: TileSourceContext) => next};
        const context: TileSourceContext = {source: 'world', coords: {...index, key: '0/0/1'}};
        const adapter = new TangramTileSourceAdapter(source, () => []);
        await expect(adapter.getTileData({index, id: 'build', context})).rejects.toThrow('decode');
        await expect(adapter.getTileData({index, id: 'build', context})).resolves.toBe(context);
        expect(legacyAttempts).toBe(2);
    } finally { loaders.finalize(); }
});

test('AbortSignal from the real tileset reaches legacy cancellation and blocks a late provider result', async () => {
    let resolveLoad: (context: TileSourceContext) => void = () => {};
    let loadedContext: TileSourceContext = {source: 'world', coords: {x: 0, y: 0, z: 1, key: '0/0/1'}};
    const cancel = vi.fn();
    const bridge = new AlignedTangramTileSource({getMetadata: async () => ({}),
        load: context => { loadedContext = context; return new Promise(resolve => { resolveLoad = resolve; }); },
        copyTileData: (_previous, next) => next}, {cancel,
        createContext: parameters => ({source: 'world', coords: {...parameters.index, key: TileID.coordKey(parameters.index)}})});
    const loaders = new Tileset2D({tileSource: bridge, maxRequests: 0,
        adapter: new TangramTileTraversalAdapter(new WebMercatorVisibilityAdapter(), new WebMercatorGlobeVisibilityAdapter())});
    try {
        loaders.getTileIndices({viewState: {eyes: []}, zRange: null});
        const tile = loaders.getTile({x: 0, y: 0, z: 1}, true), completion = tile.data;
        await Promise.resolve(); await Promise.resolve();
        tile.abort();
        expect(cancel).toHaveBeenCalledExactlyOnceWith(loadedContext);
        loadedContext.source_data = {layers: {roads: {features: []}}}; resolveLoad(loadedContext);
        expect(await completion).toBeNull(); expect(tile.content).toBeNull();
    } finally { loaders.finalize(); }
});

test('build-generation tokens reject late completion and do not release a successor build', () => {
    const tangram = new TangramTileset2D<ResourceTile>();
    const start = vi.fn(), failed = vi.fn();
    tangram.setOptions({maxConcurrentBuilds: 1});
    tangram.buildQueue.enqueue({key: 'same', token: 'old', priority: 0, start, fail: failed});
    tangram.buildQueue.cancel('same');
    tangram.buildQueue.enqueue({key: 'same', token: 'new', priority: 0, start, fail: failed});
    expect(tangram.buildQueue.finish('same', 'old')).toBe(false);
    expect(tangram.getStatistics(() => false).activeBuilds).toBe(1);
    expect(tangram.buildQueue.finish('same', 'new')).toBe(true);
    tangram.finalize(() => {});
});

test('request slots end at decode, while Tangram build slots stay owned through final mesh completion', async () => {
    const adapter = new TangramTileTraversalAdapter(new WebMercatorVisibilityAdapter(), new WebMercatorGlobeVisibilityAdapter());
    const requested: string[] = [], started: string[] = [];
    const loaders = new Tileset2D({adapter, maxRequests: 1, getTileData: props => {
        requested.push(TileID.coordKey(props.index)); return {byteLength: 100};
    }});
    const tangram = new TangramTileset2D<ResourceTile>();
    try {
        loaders.getTileIndices({viewState: {eyes: []}, zRange: null});
        tangram.setOptions({maxConcurrentBuilds: 1});
        const indices = [{x: 0, y: 0, z: 1}, {x: 1, y: 0, z: 1}];
        const completions = indices.map(index => {
            const key = TileID.coordKey(index);
            tangram.buildQueue.enqueue({key, token: 'generation', priority: 0, start: () => { started.push(key); }, fail: () => {}});
            return loaders.getTile(index, true).data;
        });
        await Promise.all(completions);
        expect(requested).toEqual(['0/0/1', '1/0/1']);
        expect(started).toEqual(['0/0/1']);
        tangram.buildQueue.finish('0/0/1', 'generation');
        expect(started).toEqual(requested);
    } finally { loaders.finalize(); tangram.finalize(() => {}); }
});
