// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import TangramTileSourceAdapter, {iterateSourceTiles} from '../src/sources/tile_source_adapter';
import type {TileSourceContext, LegacyTileDataSource, TangramTileDataRequest} from '../src/sources/tile_source_adapter';

/** Small worker context with distinct data, style, and build identities. */
interface TestTile extends TileSourceContext {
    /** Source/style build key. */
    key: string;
    /** Style zoom can change without changing source data coordinates. */
    style_z: number;
    /** Decoded data and cancellation bookkeeping remain on this live object. */
    source_data?: {layers?: Record<string, unknown>; request_id?: string; error?: string};
    /** Attached raster source identities. */
    rasters?: string[];
    /** Legacy seam padding. */
    pad_scale?: number;
    /** Legacy polygon orientation. */
    default_winding?: string;
}

/** Create a deterministic source-normalized worker context. */
function createTile(source = 'world', styleZoom = 3, x = 1): TestTile {
    return {source, style_z: styleZoom, key: `${source}/${x}/2/3/${styleZoom}`,
        coords: {x, y: 2, z: 3, key: `${x}/2/3`}};
}

/** Envelope that keeps data index and build identity separate. */
function createRequest(tile: TestTile): TangramTileDataRequest<TestTile> {
    return {index: tile.coords, id: tile.key, context: tile};
}

/** Existing source hooks with observable calls and destination mutation. */
function createSource(): LegacyTileDataSource<TestTile> {
    return {
        load: vi.fn(async tile => {
            tile.source_data = {layers: {roads: {features: []}}, request_id: 'live-request'};
            return tile;
        }),
        copyTileData: vi.fn((reference, destination) => {
            destination.source_data = {layers: reference.source_data?.layers};
            destination.rasters = [...(reference.rasters ?? [])];
            destination.pad_scale = reference.pad_scale;
            destination.default_winding = reference.default_winding;
            return destination;
        })
    };
}

test('data reuse crosses style/build identities but preserves the live destination and source payload references', async () => {
    const source = createSource();
    const reference = {...createTile('world', 3), loaded: true, source_data: {layers: {roads: {features: []}}},
        rasters: ['raster'], pad_scale: 0.001, default_winding: 'CW'};
    const destination = createTile('world', 12);
    const adapter = new TangramTileSourceAdapter(source, () => [reference]);
    const result = await adapter.getTileData(createRequest(destination));
    expect(result).toBe(destination);
    expect(source.copyTileData).toHaveBeenCalledExactlyOnceWith(reference, destination);
    expect(source.load).not.toHaveBeenCalled();
    expect(result.source_data?.layers).toBe(reference.source_data.layers);
    expect(result.rasters).toEqual(reference.rasters);
    expect(result.rasters).not.toBe(reference.rasters);
    expect(result.pad_scale).toBe(reference.pad_scale);
    expect(result.default_winding).toBe(reference.default_winding);
    expect(result.style_z).toBe(12);
    expect(result.key).toBe('world/1/2/3/12');
});

test.each(['other-source', 'other-coordinate', 'loading', 'unwrapped-copy'])('%s does not reuse decoded data', async condition => {
    const source = createSource();
    const reference = {...createTile(), loaded: true};
    if (condition === 'other-source') reference.source = 'other';
    if (condition === 'other-coordinate') reference.coords = createTile('world', 3, 2).coords;
    if (condition === 'loading') reference.loaded = false;
    if (condition === 'unwrapped-copy') reference.coords = createTile('world', 3, -7).coords;
    const destination = createTile();
    const adapter = new TangramTileSourceAdapter(source, () => [reference]);
    expect(await adapter.getTileData(createRequest(destination))).toBe(destination);
    expect(source.load).toHaveBeenCalledExactlyOnceWith(destination);
    expect(source.copyTileData).not.toHaveBeenCalled();
    expect(destination.source_data?.request_id).toBe('live-request');
});

test('uses the first loaded match from the current registry, not a cached registry snapshot', async () => {
    const source = createSource();
    const unloaded = createTile();
    const first = {...createTile(), loaded: true};
    const second = {...createTile('world', 8), loaded: true};
    let retained: TestTile[] = [unloaded, first, second];
    const adapter = new TangramTileSourceAdapter(source, () => retained);
    const request = createRequest(createTile());
    await adapter.getTileData(request);
    expect(source.copyTileData).toHaveBeenLastCalledWith(first, request.context);
    retained = [second];
    await adapter.getTileData(request);
    expect(source.copyTileData).toHaveBeenLastCalledWith(second, request.context);
});

test('worker table iteration remains lazy and preserves legacy enumerable order', () => {
    const first = createTile(), second = createTile('world', 4), inherited = createTile('other');
    const records: Record<string, TestTile> = {first, second};
    Object.setPrototypeOf(records, {inherited});
    const iterator = iterateSourceTiles(records)[Symbol.iterator]();
    expect(iterator.next().value).toBe(first);
    delete records.second;
    expect(iterator.next().value).toBe(inherited);
    expect(iterator.next().done).toBe(true);
});

test('missing sources reset decoded data without consulting retained tiles or adding GPU state', async () => {
    const destination = createTile('missing');
    destination.source_data = {layers: {old: []}};
    const getRetainedTiles = vi.fn(() => []);
    const adapter = new TangramTileSourceAdapter<TestTile>(undefined, getRetainedTiles);
    expect(await adapter.getTileData(createRequest(destination))).toBe(destination);
    expect(destination.source_data).toEqual({});
    expect(getRetainedTiles).not.toHaveBeenCalled();
    expect(destination).not.toHaveProperty('meshes');
});

test('keeps resolved data errors, rejected loads and synchronous source errors distinct', async () => {
    const source = createSource();
    source.load = async tile => { tile.source_data = {error: 'provider failure'}; return tile; };
    const adapter = new TangramTileSourceAdapter(source, () => []);
    const destination = createTile();
    await expect(adapter.getTileData(createRequest(destination))).resolves.toBe(destination);
    expect(destination.source_data?.error).toBe('provider failure');
    const failure = new Error('decode failure');
    source.load = () => Promise.reject(failure);
    await expect(adapter.getTileData(createRequest(createTile()))).rejects.toBe(failure);
    source.load = () => { throw failure; };
    expect(() => adapter.getTileData(createRequest(createTile()))).toThrow(failure);
    source.copyTileData = () => { throw failure; };
    const reuse = new TangramTileSourceAdapter(source, () => [{...createTile(), loaded: true}]);
    expect(() => reuse.getTileData(createRequest(createTile()))).toThrow(failure);
});
