// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import type {TileSource} from '@loaders.gl/loader-utils';
import AlignedTangramTileSource from '../src/sources/aligned_tile_source';
import type {AlignedLegacySource, AlignedTileParameters} from '../src/sources/aligned_tile_source';
import type {TileSourceContext} from '../src/sources/tile_source_adapter';
import {updateTileSourceRequest} from '../src/sources/tile_source_state';

/** Deterministic, individually controllable source completion. */
function createDeferred<T>() {
    let resolve: (value: T) => void = () => {};
    let reject: (reason: unknown) => void = () => {};
    const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
    return {promise, resolve, reject};
}

/** A fresh worker context, never a renderer mesh tile. */
function createContext(parameters: AlignedTileParameters): TileSourceContext {
    const index = parameters.index;
    return {source: 'world', coords: {...index, key: `${index.x}/${index.y}/${index.z}`}};
}

/** Small legacy provider using the original mutation/return convention. */
function createSource(): AlignedLegacySource<TileSourceContext> {
    return {getMetadata: async () => ({name: 'world', minZoom: 0, maxZoom: 14, attributions: ['provider']}),
        load: vi.fn(async context => { context.source_data = {layers: {roads: {features: []}}}; return context; }),
        copyTileData: vi.fn((reference, destination) => { destination.source_data = {layers: reference.source_data?.layers}; return destination; })};
}

test('is structurally a loaders.gl TileSource and returns content without request or style/build state', async () => {
    const legacy = createSource();
    const source: TileSource = new AlignedTangramTileSource(legacy, {createContext, cancel: () => {}});
    expect(await source.getMetadata()).toMatchObject({attributions: ['provider'], maxZoom: 14});
    const result = await source.getTile({x: 0, y: 0, z: 0});
    expect(result).toEqual({layers: {roads: {features: []}}, rasters: [], padScale: undefined, defaultWinding: undefined});
    expect(result).not.toHaveProperty('coords');
    expect(result).not.toHaveProperty('source_data');
    expect(result).not.toHaveProperty('meshes');
});

test('pre-aborted and excluded requests never create contexts or start underlying loads', async () => {
    const legacy = createSource();
    legacy.includesTile = () => false;
    const context = vi.fn(createContext), cancel = vi.fn();
    const source = new AlignedTangramTileSource(legacy, {createContext: context, cancel});
    const controller = new AbortController(); controller.abort();
    await expect(source.getTile({x: 0, y: 0, z: 0, signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
    await expect(source.getTile({x: 0, y: 0, z: 0})).resolves.toBeNull();
    expect(context).not.toHaveBeenCalled(); expect(legacy.load).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
});

test('source display policy receives explicit style zoom, not normalized data zoom', async () => {
    const legacy = createSource();
    const includes = vi.fn(() => true); legacy.includesTile = includes;
    const source = new AlignedTangramTileSource(legacy, {createContext, cancel: () => {}});
    const parameters: AlignedTileParameters = {index: {x: 1, y: 1, z: 2}, id: 'style-12',
        bbox: {west: -90, south: 0, east: 0, north: 60}, zoom: 5, userData: {styleZoom: 12}};
    await source.getTileData(parameters);
    expect(includes).toHaveBeenLastCalledWith(parameters.index, 12);
    await source.getTileData({...parameters, userData: undefined});
    expect(includes).toHaveBeenLastCalledWith(parameters.index, 5);
});

test.each([0, 100, -1, Number.NaN, Number.POSITIVE_INFINITY])('decoded byte accounting validates %s without using encoded response bytes', async byteLength => {
    const source = new AlignedTangramTileSource(createSource(), {createContext, cancel: () => {}, getPayloadByteLength: () => byteLength});
    const loading = source.getTile({x: 0, y: 0, z: 0});
    if (Number.isFinite(byteLength) && byteLength >= 0) await expect(loading).resolves.toHaveProperty('byteLength', byteLength);
    else await expect(loading).rejects.toThrow('finite and non-negative');
    expect(source.localCoordinates).toBe(true);
});

test('abort rejects promptly, cancels late request IDs, and ignores completion from a non-cancellable provider', async () => {
    const deferred = createDeferred<TileSourceContext>();
    const legacy = createSource();
    let context: TileSourceContext = {source: 'world', coords: {x: 0, y: 0, z: 0, key: '0'}};
    legacy.load = tile => { context = tile; return deferred.promise; };
    const cancel = vi.fn((tile: TileSourceContext) => updateTileSourceRequest(tile, {requestId: null}));
    const source = new AlignedTangramTileSource(legacy, {createContext, cancel});
    const controller = new AbortController();
    const loading = source.getTile({x: 0, y: 0, z: 0, signal: controller.signal});
    const rejected = expect(loading).rejects.toMatchObject({name: 'AbortError'});
    controller.abort();
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    updateTileSourceRequest(context, {requestId: 'created-after-abort'});
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(context.source_data?.request_id).toBeNull();
    deferred.resolve(context); await deferred.promise; await Promise.resolve();
    updateTileSourceRequest(context, {requestId: 'after-settlement'});
    expect(cancel).toHaveBeenCalledTimes(2);
});

test('aborting one request does not cancel or poison another request for the same index', async () => {
    const pending: Array<{context: TileSourceContext; deferred: ReturnType<typeof createDeferred<TileSourceContext>>}> = [];
    const legacy = createSource();
    legacy.load = context => { const deferred = createDeferred<TileSourceContext>(); pending.push({context, deferred}); return deferred.promise; };
    const cancel = vi.fn();
    const source = new AlignedTangramTileSource(legacy, {createContext, cancel});
    const controller = new AbortController();
    const first = source.getTile({x: 0, y: 0, z: 0, signal: controller.signal});
    const second = source.getTile({x: 0, y: 0, z: 0});
    const rejected = expect(first).rejects.toMatchObject({name: 'AbortError'});
    controller.abort(); await rejected;
    pending[1].context.source_data = {layers: {roads: {features: []}}};
    pending[1].deferred.resolve(pending[1].context);
    expect(await second).toHaveProperty('layers.roads');
    expect(cancel).toHaveBeenCalledExactlyOnceWith(pending[0].context);
    pending[0].deferred.resolve(pending[0].context);
});

test('keeps resolved provider errors separate and cleans listeners after synchronous and asynchronous failures', async () => {
    const legacy = createSource(), cancel = vi.fn(), resolvedError = vi.fn();
    const controller = new AbortController();
    const source = new AlignedTangramTileSource(legacy, {createContext, cancel, onResolvedError: resolvedError});
    legacy.load = async context => { context.source_data = {layers: {}, error: 'legacy resolved error'}; return context; };
    await expect(source.getTile({x: 0, y: 0, z: 0})).resolves.toMatchObject({layers: {}});
    expect(resolvedError).toHaveBeenCalledExactlyOnceWith('legacy resolved error', expect.objectContaining({source: 'world'}));
    const failure = new Error('decode');
    legacy.load = () => { throw failure; };
    await expect(source.getTile({x: 0, y: 0, z: 0, signal: controller.signal})).rejects.toBe(failure);
    legacy.load = () => Promise.reject(failure);
    await expect(source.getTile({x: 0, y: 0, z: 0, signal: controller.signal})).rejects.toBe(failure);
    controller.abort(); expect(cancel).not.toHaveBeenCalled();
});
