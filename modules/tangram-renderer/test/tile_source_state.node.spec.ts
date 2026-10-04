// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import {applyTilePayload, captureTilePayload, getTilePayload, getTileSourceRequest, updateTileSourceRequest,
    bindTileSourceCancellation} from '../src/sources/tile_source_state';
import type {TileDataContext} from '../src/sources/tile_source_state';
import {createTileSourceMetadata} from '../src/sources/tile_source_metadata';

test('decoded content excludes request fields and preserves layer identity without freezing style features', () => {
    const layers = {roads: {features: [{properties: {kind: 'road'}}]}};
    const context: TileDataContext = {source_data: {layers, error: 'provider', url: 'tile', request_id: 'pending'},
        rasters: ['terrain'], pad_scale: 0.001, default_winding: 'CW'};
    const payload = captureTilePayload(context);
    expect(payload).toEqual({layers, rasters: ['terrain'], padScale: 0.001, defaultWinding: 'CW'});
    expect(payload.layers).toBe(layers);
    expect(payload.rasters).not.toBe(context.rasters);
    expect(getTilePayload(context)).toBe(payload);
    expect(getTileSourceRequest(context)).toEqual({requestId: 'pending', error: 'provider', url: 'tile'});
    expect(Object.isFrozen(layers.roads.features[0])).toBe(false);
});

test('rebinding content for overzoom has an independent request facade and raster list', () => {
    const reference: TileDataContext = {source_data: {layers: {}, request_id: 'old', error: 'old', url: 'old'}, rasters: ['raster']};
    const destination: TileDataContext = {source_data: {request_id: 'stale'}};
    expect(getTilePayload(destination)).toBeUndefined();
    const payload = captureTilePayload(reference);
    applyTilePayload(destination, payload);
    expect(destination.source_data).toEqual({layers: payload.layers});
    expect(destination.rasters).toEqual(['raster']);
    expect(destination.rasters).not.toBe(payload.rasters);
    updateTileSourceRequest(destination, {requestId: 'new', error: null, url: 'new'});
    expect(getTileSourceRequest(reference).requestId).toBe('old');
    expect(getTileSourceRequest(destination)).not.toBe(getTileSourceRequest(reference));
    expect(payload).not.toHaveProperty('requestId');
});

test('custom legacy writes are reconciled and late IDs invoke only the current cancellation hook', () => {
    const context: TileDataContext = {};
    const first = vi.fn(), second = vi.fn();
    const removeFirst = bindTileSourceCancellation(context, first);
    const removeSecond = bindTileSourceCancellation(context, second);
    removeFirst();
    updateTileSourceRequest(context, {requestId: 'late'});
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    removeSecond();
    updateTileSourceRequest(context, {requestId: null});
    context.source_data = {url: 'custom', request_id: 'custom'};
    expect(getTileSourceRequest(context)).toEqual({requestId: 'custom', url: 'custom', error: undefined});
    updateTileSourceRequest(context, {requestId: 'next'});
    expect(second).toHaveBeenCalledOnce();
});

test('metadata keeps authored bounds/sparse levels and detached credits without changing source layout', () => {
    const source = {name: 'world', config: {type: 'MVT', bounds: [170, -30, -170, 60], zooms: [0, 3, 7]},
        zooms: [0, 3, 7], max_zoom: 7, getAttributions: () => ['provider']};
    const metadata = createTileSourceMetadata(source, {bounds: [-180, -80, 180, 80], minzoom: 2, maxzoom: 14});
    expect(metadata).toEqual({name: 'world', format: 'MVT', minZoom: 0, maxZoom: 7,
        attributions: ['provider'], boundingBox: [[170, -30], [-170, 60]]});
    if (metadata.boundingBox) metadata.boundingBox[0][0] = 0;
    expect(source.config.bounds[0]).toBe(170);
    expect(source.zooms).toEqual([0, 3, 7]);
});

test.each(['MVT', 'PMTiles', 'MLT', 'Raster'])('normalizes %s metadata without selecting a parser', format => {
    const source = {name: 'world', config: {type: format}, zooms: [0, 1], max_zoom: 1, getAttributions: () => []};
    expect(createTileSourceMetadata(source, {minzoom: 2, maxzoom: 12, bounds: [-180, -80, 180, 80]}))
        .toEqual({format, name: 'world', minZoom: 2, maxZoom: 12, attributions: [], boundingBox: [[-180, -80], [180, 80]]});
});

test('unknown metadata is omitted; explicit data ceiling wins over advertised metadata', () => {
    const source = {name: 'world', config: {max_zoom: 5}, zooms: [0], max_zoom: 5, getAttributions: () => []};
    const result = createTileSourceMetadata(source, {maxzoom: 20, bounds: ['invalid']});
    expect(result.maxZoom).toBe(5);
    expect(result).not.toHaveProperty('boundingBox');
    expect(result).not.toHaveProperty('format');
});
