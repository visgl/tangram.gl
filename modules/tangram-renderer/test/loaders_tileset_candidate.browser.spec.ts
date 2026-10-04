// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import {Tileset2D} from '@loaders.gl/tiles';
import TangramTileTraversalAdapter from '../src/tile/tile_traversal_adapter';
import type {TangramTraversalState} from '../src/tile/tile_traversal_adapter';
import {WebMercatorVisibilityAdapter, WebMercatorGlobeVisibilityAdapter} from '../src/scene/visibility_adapter';
import {TileID} from '../src/tile/tile_id';
import type {TileCoordinates} from '../src/tile/tile_id';
import LoadersTilesetCandidate from './helpers/loaders_tileset_candidate';
import TilePyramid from '../src/tile/tile_pyramid';
import {createTraversalView, traversalFixtures} from './helpers/tile_traversal_fixtures';

/** One immutable source revision with all levels available unless overridden by a case. */
const source = {name: 'world', id: 1, zooms: Array.from({length: 19}, (_, index) => index)};
const adapter = new TangramTileTraversalAdapter(new WebMercatorVisibilityAdapter(), new WebMercatorGlobeVisibilityAdapter());
/** Compact payload whose allocation size is meaningful independently of GPU meshes. */
type Content = {key: string; byteLength: number};
/** Hermetic source procedure uses normalized XYZ, never display zoom. */
async function loadContent(index: TileCoordinates): Promise<Content> { return {key: TileID.coordKey(index), byteLength: 100}; }
/** Single known logical coordinate, including distinct unwrapped copies. */
function createState(index: TileCoordinates): TangramTraversalState {
    const bounds = adapter.getTileBoundingBox({viewState: {eyes: []}}, index);
    const inset = 0.001;
    return {eyes: [{view: createTraversalView({tile_zoom: index.z, wrap: true}), projection: {type: 'web-mercator',
        visibleBounds: [bounds.west + inset, bounds.south + inset, bounds.east - inset, bounds.north - inset]}}]};
}
/** Explicit completion controls avoid timing, public network and large geometry fixtures. */
function createDeferred<ValueT>() {
    let resolve: (value: ValueT) => void = () => {};
    const promise = new Promise<ValueT>(settle => { resolve = settle; });
    return {promise, resolve};
}

test.each(traversalFixtures)('full loaders-backed candidate loads the frozen $name footprint', async ({state, keys}) => {
    const load = vi.fn(loadContent), candidate = new LoadersTilesetCandidate({source, adapter, load, getByteLength: value => value.byteLength});
    try {
        const before = JSON.stringify(state);
        const tiles = candidate.updateConsumer(Symbol('host'), state, 8);
        expect(tiles.map(tile => TileID.coordKey(tile.content.index))).toEqual(keys);
        expect(tiles.map(tile => tile.key)).toEqual(keys.map(key => `world/${key}/8`));
        await Promise.all(tiles.map(tile => tile.content.data));
        expect(load).toHaveBeenCalledTimes(keys.length);
        expect(candidate.getStatistics()).toEqual({decodedTiles: keys.length, decodedBytes: 100 * keys.length, meshConsumers: 1});
        expect(JSON.stringify(state)).toBe(before);
    } finally { candidate.finalize(); }
});

test('overzoom and sparse levels deduplicate decoded content without collapsing style or source-revision identities', async () => {
    const load = vi.fn(loadContent), options = {source: {...source, zooms: [0, 2, 4], zoom_bias: 1}, adapter, load};
    const candidate = new LoadersTilesetCandidate(options), replacement = new LoadersTilesetCandidate(options);
    try {
        const state = createState({x: 20, y: 12, z: 6});
        const first = candidate.updateConsumer(Symbol('style-6'), state, 6);
        const second = candidate.updateConsumer(Symbol('style-12'), state, 12);
        expect(first).toHaveLength(1); expect(second).toHaveLength(1);
        expect(first[0].key).toBe('world/5/3/4/6'); expect(second[0].key).toBe('world/5/3/4/12');
        expect(first[0].content).toBe(second[0].content);
        await first[0].content.data; expect(load).toHaveBeenCalledOnce();
        const changed = replacement.updateConsumer(Symbol('replacement'), state, 12);
        await changed[0].content.data;
        expect(changed[0].content).not.toBe(second[0].content); expect(load).toHaveBeenCalledTimes(2);
    } finally { candidate.finalize(); replacement.finalize(); }
});

test('overzoom duplicate mesh keys are removed, while unwrapped world copies remain separate', async () => {
    const candidate = new LoadersTilesetCandidate({source: {...source, zooms: [0]}, adapter, load: loadContent});
    try {
        expect(candidate.updateConsumer(Symbol('overzoom'), traversalFixtures[0].state, 12)).toHaveLength(1);
        const first = candidate.updateConsumer(Symbol('west'), createState({x: -1, y: 0, z: 0}), 12);
        const second = candidate.updateConsumer(Symbol('east'), createState({x: 0, y: 0, z: 0}), 12);
        expect(first[0].key).toBe('world/-1/0/0/12'); expect(second[0].key).toBe('world/0/0/0/12');
        expect(first[0].content).not.toBe(second[0].content);
        await Promise.all([first[0].content.data, second[0].content.data]);
    } finally { candidate.finalize(); }
});

test('both stereo hosts protect one header, and coarse globe preload survives their detachment', async () => {
    const unloaded = vi.fn(), candidate = new LoadersTilesetCandidate({source, adapter, load: loadContent, onContentUnload: unloaded});
    const first = Symbol('left'), second = Symbol('right'), state = createState({x: 0, y: 0, z: 1});
    try {
        const left = candidate.updateConsumer(first, state, 6), right = candidate.updateConsumer(second, state, 6);
        candidate.setPreload([{x: 0, y: 0, z: 0}]);
        expect(left[0].content).toBe(right[0].content);
        await Promise.all(candidate.decodedTileset.tiles.map(tile => tile.data));
        candidate.detachConsumer(first); expect(unloaded).not.toHaveBeenCalled();
        candidate.detachConsumer(second); expect(unloaded).toHaveBeenCalledExactlyOnceWith({key: '0/0/1', byteLength: 100});
        expect(candidate.decodedTileset.selectedTiles).toEqual([]);
        expect(candidate.decodedTileset.tiles.map(tile => TileID.coordKey(tile.index))).toEqual(['0/0/0']);
        candidate.setPreload([]); expect(unloaded).toHaveBeenCalledTimes(2);
    } finally { candidate.finalize(); }
    expect(unloaded).toHaveBeenCalledTimes(2);
});

test('authored ancestor and descendant fallbacks retain data without applying decoded-header refinement to styled meshes', async () => {
    const candidate = new LoadersTilesetCandidate({source, adapter, load: loadContent});
    try {
        const parent = {x: 0, y: 0, z: 1}, child = {x: 1, y: 1, z: 2}, detail = {x: 2, y: 2, z: 3};
        candidate.updateConsumer(Symbol('parent'), createState(parent), 1);
        const selected = candidate.updateConsumer(Symbol('child'), createState(child), 12,
            [{index: parent, styleZoom: 1}, {index: detail, styleZoom: 12}]);
        await Promise.all(candidate.decodedTileset.tiles.map(tile => tile.data));
        candidate.decodedTileset.prepareTiles();
        expect(selected[0].content.parent?.index).toMatchObject(parent);
        expect(selected[0].content.children?.map(tile => tile.index)).toMatchObject([detail]);
        expect(selected[0].styleZoom).toBe(12); expect(selected[0].content.zoom).toBe(2);
        expect(candidate.decodedTileset.visibleTiles.map(tile => TileID.coordKey(tile.index)).sort()).toEqual(['0/0/1', '1/1/2', '2/2/3']);
    } finally { candidate.finalize(); }
});

test('nearest cached header is not always Tangram\'s nearest loaded styled ancestor', async () => {
    const pending = createDeferred<Content>(), candidate = new LoadersTilesetCandidate({source, adapter,
        load: index => index.z === 1 ? pending.promise : loadContent(index)});
    const rootIndex = {x: 0, y: 0, z: 0}, parentIndex = {x: 0, y: 0, z: 1}, childIndex = {x: 1, y: 1, z: 2};
    const pyramid = new TilePyramid();
    const root = {source, coords: rootIndex, key: TileID.key(rootIndex, source, 0), style_z: 0, loaded: true};
    const parent = {source, coords: parentIndex, key: TileID.key(parentIndex, source, 1), style_z: 1, loaded: false};
    const child = {source, coords: childIndex, key: TileID.key(childIndex, source, 2), style_z: 2, loaded: false};
    try {
        candidate.setPreload([rootIndex]);
        await candidate.decodedTileset.getTile(rootIndex)?.data;
        candidate.updateConsumer(Symbol('pending-parent'), createState(parentIndex), 1);
        const header = candidate.updateConsumer(Symbol('child'), createState(childIndex), 2,
            [{index: rootIndex, styleZoom: 0}])[0].content;
        await header.data; candidate.decodedTileset.prepareTiles();
        for (const tile of [root, parent, child]) pyramid.addTile(tile);
        expect(header.parent?.index).toMatchObject(parentIndex);
        expect(header.parent?.isLoaded).toBe(false);
        expect(pyramid.getAncestor(child)?.coords).toEqual(rootIndex);
        expect(candidate.decodedTileset.visibleTiles.some(tile => TileID.coordKey(tile.index) === '0/0/0')).toBe(true);
    } finally { candidate.finalize(); pending.resolve({key: 'retired', byteLength: 100}); }
});

test('queued/running decoded requests share capacity; final detachment blocks late non-cooperative publication', async () => {
    const pending = createDeferred<Content>(), load = vi.fn((_index: TileCoordinates, _signal: AbortSignal) => pending.promise);
    const candidate = new LoadersTilesetCandidate({source, adapter, load, maxRequests: 1});
    const first = Symbol('first'), second = Symbol('second');
    const state = createState({x: 0, y: 0, z: 1});
    try {
        const header = candidate.updateConsumer(first, state, 6)[0].content;
        candidate.updateConsumer(second, state, 12);
        const completion = header.data;
        await vi.waitFor(() => expect(load).toHaveBeenCalledOnce(), {interval: 1});
        candidate.detachConsumer(first); expect(load.mock.calls[0][1].aborted).toBe(false);
        candidate.detachConsumer(second); expect(load.mock.calls[0][1].aborted).toBe(true);
        pending.resolve({key: 'late', byteLength: 100});
        expect(await completion).toBeNull(); expect(header.content).toBeNull();
        expect(candidate.getStatistics().decodedTiles).toBe(0);
    } finally { candidate.finalize(); }
});

test('cached failure retries only explicitly, and successful content is not reloaded by retry', async () => {
    const load = vi.fn(loadContent).mockRejectedValueOnce(new Error('decode failed'));
    const candidate = new LoadersTilesetCandidate({source, adapter, load});
    try {
        const index = {x: 0, y: 0, z: 1}, consumer = Symbol('host'), state = createState(index);
        const header = candidate.updateConsumer(consumer, state, 6)[0].content;
        await header.data; expect(header.hasError).toBe(true);
        candidate.updateConsumer(consumer, state, 6); expect(load).toHaveBeenCalledOnce();
        expect(await candidate.retryTile(index).data).toEqual({key: '0/0/1', byteLength: 100});
        expect(header.hasError).toBe(false);
        expect(candidate.retryTile(index)).toBe(header); expect(load).toHaveBeenCalledTimes(2);
    } finally { candidate.finalize(); }
});

test('decoded warm count is explicit and does not reinterpret an off-screen mesh budget', async () => {
    const unloaded = vi.fn(), candidate = new LoadersTilesetCandidate({source, adapter, load: loadContent,
        maxDecodedTiles: 1, getByteLength: value => value.byteLength, onContentUnload: unloaded});
    const host = Symbol('host');
    try {
        await candidate.updateConsumer(host, createState({x: 0, y: 0, z: 1}), 6)[0].content.data;
        candidate.updateConsumer(host, {eyes: []}, 6);
        expect(candidate.getStatistics().decodedTiles).toBe(1); // Explicit warm cache, unlike the default zero.
        await candidate.updateConsumer(host, createState({x: 1, y: 0, z: 1}), 6)[0].content.data;
        expect(unloaded).toHaveBeenCalledExactlyOnceWith({key: '0/0/1', byteLength: 100});
        expect(candidate.getStatistics()).toMatchObject({decodedTiles: 1, decodedBytes: 100});
    } finally { candidate.finalize(); }
    expect(unloaded).toHaveBeenCalledTimes(2);
});

test('finalizing a source revision aborts pending work and cannot unload or publish a late result', async () => {
    const pending = createDeferred<Content>(), unloaded = vi.fn();
    const load = vi.fn((_index: TileCoordinates, _signal: AbortSignal) => pending.promise);
    const candidate = new LoadersTilesetCandidate({source, adapter, load, onContentUnload: unloaded});
    const state = createState({x: 0, y: 0, z: 1});
    const header = candidate.updateConsumer(Symbol('old'), state, 6)[0].content, completion = header.data;
    try {
        await vi.waitFor(() => expect(load).toHaveBeenCalledOnce(), {interval: 1});
        candidate.finalize(); expect(load.mock.calls[0][1].aborted).toBe(true);
        const replacement = new LoadersTilesetCandidate({source, adapter, load: loadContent});
        try {
            const current = replacement.updateConsumer(Symbol('new'), state, 6)[0].content;
            expect(await current.data).toEqual({key: '0/0/1', byteLength: 100});
            pending.resolve({key: 'obsolete', byteLength: 100});
            expect(await completion).toBeNull(); expect(header.content).toBeNull();
            expect(current.content?.key).toBe('0/0/1'); expect(unloaded).not.toHaveBeenCalled();
        } finally { replacement.finalize(); }
    } finally { candidate.finalize(); pending.resolve({key: 'obsolete', byteLength: 100}); }
});

test.each([undefined, NaN, -1])('unknown/invalid allocation %s stays unknown rather than becoming zero', async bytes => {
    const candidate = new LoadersTilesetCandidate({source, adapter, load: async () => ({geometry: [1, 2]}), getByteLength: () => bytes});
    try {
        await candidate.updateConsumer(Symbol('host'), createState({x: 0, y: 0, z: 0}), 6)[0].content.data;
        expect(candidate.decodedTileset.cacheByteSize).toBe(0); // Published engine assumes a byteLength field.
        expect(candidate.getStatistics().decodedBytes).toBeUndefined();
    } finally { candidate.finalize(); }
});

test('published finalize needs an explicit decoded-release adapter; teardown rejects reuse and is idempotent', async () => {
    const unload = vi.fn(), reference = new Tileset2D({adapter, getTileData: () => ({byteLength: 100}), onTileUnload: unload});
    reference.getTileIndices({viewState: {eyes: []}, zRange: null});
    await reference.getTile({x: 0, y: 0, z: 0}, true).data;
    reference.finalize(); expect(unload).not.toHaveBeenCalled();
    const candidate = new LoadersTilesetCandidate({source, adapter, load: loadContent, onContentUnload: unload});
    const state = createState({x: 0, y: 0, z: 0});
    await candidate.updateConsumer(Symbol('host'), state, 6)[0].content.data;
    candidate.finalize(); candidate.finalize(); expect(unload).toHaveBeenCalledOnce();
    expect(candidate.getStatistics()).toEqual({decodedTiles: 0, decodedBytes: 0, meshConsumers: 0});
    expect(() => candidate.updateConsumer(Symbol('host'), state, 6)).toThrow('finalized');
    expect(() => candidate.setPreload([])).toThrow('finalized');
    expect(() => candidate.retryTile({x: 0, y: 0, z: 0})).toThrow('finalized');
});
