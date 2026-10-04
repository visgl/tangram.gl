// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, expect, test, vi} from 'vitest';
import DataSource, {NetworkTileSource} from '../src/sources/data_source';
import {GeoJSONTileSource} from '../src/sources/geojson';
import {MVTSource} from '../src/sources/mvt';
import {RasterTileSource} from '../src/sources/raster';
import AlignedTangramTileSource from '../src/sources/aligned_tile_source';
import type {AlignedTileParameters} from '../src/sources/aligned_tile_source';
import type {TileSourceContext} from '../src/sources/tile_source_adapter';
import {captureTilePayload, getTileSourceRequest, updateTileSourceRequest} from '../src/sources/tile_source_state';
import Geo from '../src/utils/geo';
import Utils from '../src/utils/utils';

/** Parser context contains geographic transform anchors but no renderer content. */
interface SourceContext extends TileSourceContext {
    /** Consumer/build identity. */
    key: string;
    /** Geographic tile northwest in EPSG:3857 meters. */
    min: {x: number; y: number};
    /** Geographic tile southeast in EPSG:3857 meters. */
    max: {x: number; y: number};
}

/** Context factory shared by the legacy and aligned procedure calls. */
function createContext(parameters: AlignedTileParameters): SourceContext {
    const index = parameters.index;
    return {source: 'world', key: parameters.id, coords: {...index, key: `${index.x}/${index.y}/${index.z}`},
        min: Geo.metersForTile(index), max: Geo.metersForTile({...index, x: index.x + 1, y: index.y + 1})};
}

/** Tiny valid MVT: roads layer, feature ID 7, point at local origin, extent 4096. */
const mvt = new Uint8Array([26, 23, 10, 5, 114, 111, 97, 100, 115,
    18, 9, 8, 7, 24, 1, 34, 3, 9, 0, 0, 40, 128, 32, 120, 2]);
const geojson = JSON.stringify({type: 'FeatureCollection', features: [{type: 'Feature', id: 7,
    properties: {kind: 'road'}, geometry: {type: 'Point', coordinates: [0, 0]}}]});
afterEach(() => vi.restoreAllMocks());

test.each(['MVT', 'GeoJSON', 'Raster'])('aligned %s source returns the same postprocessed payload as the legacy source', async format => {
    vi.spyOn(Utils, 'io').mockResolvedValue({body: format === 'MVT' ? mvt.buffer : geojson, status: 200});
    const config = {name: 'world', type: format, url: `fixtures/{z}/{x}/{y}.${format}`, rasters: ['terrain'], pad_scale: 0.001};
    const createSource = (): DataSource => format === 'MVT' ? new MVTSource(config, {}) :
        format === 'GeoJSON' ? new GeoJSONTileSource(config, {}) : new RasterTileSource(config, {});
    const parameters: AlignedTileParameters = {index: {x: 0, y: 0, z: 0}, id: 'build', bbox: {west: -180, south: -85, east: 180, north: 85}};
    const legacyContext = createContext(parameters);
    const legacy = await createSource().load(legacyContext);
    const source = new AlignedTangramTileSource(createSource(), {createContext, cancel: () => {}});
    const result = await source.getTileData(parameters);
    expect(result).toEqual(captureTilePayload(legacy));
    expect(result?.layers).toBeDefined();
    expect(result?.rasters).toContain('terrain');
    expect(result?.padScale).toBe(0.001);
    expect(result?.defaultWinding).toBe(format === 'Raster' ? 'CW' : 'CCW');
    expect(result).not.toHaveProperty('request_id');
    expect(result).not.toHaveProperty('url');
});

test('metadata resolves TileJSON once, retains attribution and relative URL handling, and does not alter legacy layout', async () => {
    const io = vi.spyOn(Utils, 'io').mockResolvedValue({status: 200, body: JSON.stringify({
        tiles: ['tiles/{z}/{x}/{y}.mvt'], minzoom: 2, maxzoom: 10, bounds: [170, -40, -170, 60], attribution: 'provider'})});
    const source = new NetworkTileSource({name: 'world', type: 'MVT', tilejson: 'https://fixtures.test/maps/tilejson.json', attribution: 'author'});
    const levels = [...source.zooms];
    const first = await source.getMetadata(), second = await source.getMetadata();
    expect(first).toEqual(second);
    expect(first).toMatchObject({minZoom: 2, maxZoom: 10, attributions: ['author', 'provider'],
        boundingBox: [[170, -40], [-170, 60]]});
    expect(io).toHaveBeenCalledOnce();
    expect(source.url).toBe('https://fixtures.test/maps/tiles/{z}/{x}/{y}.mvt');
    expect(source.zooms).toEqual(levels);
    expect(source.bounds).toBeUndefined();
});

test('metadata failure remains an explicit rejection rather than silently advertising empty capabilities', async () => {
    vi.spyOn(Utils, 'io').mockRejectedValue(new Error('metadata unavailable'));
    const source = new NetworkTileSource({name: 'world', tilejson: 'fixtures/tilejson.json'});
    await expect(source.getMetadata()).rejects.toThrow('metadata unavailable');
});

test('abort during TileJSON resolution also cancels the subsequently created legacy network request', async () => {
    let resolveMetadata: (response: {status: number; body: string}) => void = () => {};
    const metadata = new Promise<{status: number; body: string}>(resolve => { resolveMetadata = resolve; });
    const io = vi.spyOn(Utils, 'io').mockImplementation(url => url.endsWith('tilejson.json') ? metadata : Promise.resolve({status: 200, body: geojson}));
    const cancelled = vi.spyOn(Utils, 'cancelRequest').mockImplementation(() => {});
    const source = new GeoJSONTileSource({name: 'world', tilejson: 'https://fixtures.test/tilejson.json'});
    const cancel = (context: SourceContext): void => {
        const request = getTileSourceRequest(context);
        if (request.requestId) Utils.cancelRequest(request.requestId);
        updateTileSourceRequest(context, {requestId: null});
    };
    const aligned = new AlignedTangramTileSource(source, {createContext, cancel});
    const controller = new AbortController();
    const loading = aligned.getTile({x: 0, y: 0, z: 0, signal: controller.signal});
    const rejected = expect(loading).rejects.toMatchObject({name: 'AbortError'});
    controller.abort(); await rejected;
    resolveMetadata({status: 200, body: JSON.stringify({tiles: ['tiles/{z}/{x}/{y}.json']})});
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
    expect(io).toHaveBeenCalledTimes(2);
    expect(cancelled.mock.calls[0][0]).toContain('https://fixtures.test/tiles/0/0/0.json');
});
