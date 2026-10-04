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
import Tile from '../src/tile/tile';
import Scene from '../src/scene/scene';
import SceneWorker from '../src/scene/scene_worker';
import WorkerBroker from '../src/utils/worker_broker';
import {registerMvtTileProvider} from '../src/procedures/mvt-tile-provider';
import type {MvtProviderMetadata} from '../src/procedures/mvt-tile-provider';

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

test('archive factories expose metadata and keep authored overrides without fetching tiles', async () => {
    const getTile = vi.fn(async () => mvt);
    const dispose = vi.fn();
    const createSource = vi.fn(() => ({getTile, dispose, getMetadata: async () => ({format: 'pmtiles',
        tileMIMEType: 'application/vnd.mapbox-vector-tile', minZoom: 2, maxZoom: 14,
        boundingBox: [[170, -40], [-170, 60]], attributions: [' provider ', 'author']} satisfies MvtProviderMetadata)}));
    const unregister = registerMvtTileProvider('archive-metadata', {createSource});
    const source = new MVTSource({name: 'world', url: 'archive.pmtiles', tile_provider: 'archive-metadata',
        attribution: 'author', max_zoom: 10, request_headers: {Authorization: 'token'}});
    try {
        const metadata = await source.getMetadata();
        expect(metadata).toMatchObject({format: 'pmtiles', minZoom: 2, maxZoom: 10,
            boundingBox: [[170, -40], [-170, 60]], attributions: ['author', 'provider']});
        await source.getMetadata();
        expect(createSource).toHaveBeenCalledExactlyOnceWith('archive.pmtiles', {headers: {Authorization: 'token'}});
        expect(getTile).not.toHaveBeenCalled();
        expect(source.decoder).toBe('tangram');
        expect(source.bounds).toBeUndefined();
        const context = createContext({index: {x: 0, y: 0, z: 2}, id: 'archive', bbox: {west: 0, south: 0, east: 1, north: 1}});
        await source.load(context);
        expect(context.source_data?.layers).toHaveProperty('roads');
        source.dispose(); source.dispose();
        expect(dispose).toHaveBeenCalledOnce();
        await expect(source.getMetadata()).rejects.toThrow('disposed');
    } finally { source.dispose(); unregister(); }
});

test.each(['cancel', 'dispose'])('archive %s aborts its signal and ignores late bytes', async action => {
    let resolveTile: (value: Uint8Array) => void = () => {};
    const response = new Promise<Uint8Array>(resolve => { resolveTile = resolve; });
    let signal: AbortSignal | undefined;
    const dispose = vi.fn();
    const unregister = registerMvtTileProvider('archive-cancel', {createSource: () => ({dispose,
        getTile: async (_index, requestSignal) => { signal = requestSignal; return response; }})});
    const source = new MVTSource({name: 'world', url: 'archive.pmtiles', tile_provider: 'archive-cancel'});
    const context = createContext({index: {x: 0, y: 0, z: 0}, id: 'pending', bbox: {west: 0, south: 0, east: 1, north: 1}});
    const parse = vi.spyOn(source, 'parseSourceData');
    try {
        const loading = source.load(context);
        await vi.waitFor(() => expect(signal).toBeDefined());
        if (action === 'cancel') Tile.cancel(context); else source.dispose();
        expect(signal?.aborted).toBe(true);
        resolveTile(mvt);
        await loading;
        expect(parse).not.toHaveBeenCalled();
        expect(getTileSourceRequest(context).error).toContain('aborted');
        expect(getTileSourceRequest(context).cancel).toBeUndefined();
    } finally { source.dispose(); unregister(); }
});

test('worker cancellation during TileJSON resolution does not open an archive or publish a tile', async () => {
    let resolveMetadata: (value: {status: number; body: string}) => void = () => {};
    vi.spyOn(Utils, 'io').mockImplementation(() => new Promise(resolve => { resolveMetadata = resolve; }));
    const createSource = vi.fn(() => ({getTile: async () => mvt, dispose() {}}));
    const unregister = registerMvtTileProvider('archive-late-url', {createSource});
    const source = new MVTSource({name: 'world', tilejson: 'https://fixtures.test/tilejson.json', tile_provider: 'archive-late-url'});
    const context = createContext({index: {x: 0, y: 0, z: 0}, id: 'late-url', bbox: {west: 0, south: 0, east: 1, north: 1}});
    const parse = vi.spyOn(source, 'parseSourceData');
    try {
        const loading = source.load(context);
        Tile.cancel(context);
        resolveMetadata({status: 200, body: JSON.stringify({tiles: ['archive.pmtiles']})});
        await loading;
        expect(createSource).not.toHaveBeenCalled();
        expect(parse).not.toHaveBeenCalled();
        expect(getTileSourceRequest(context).error).toContain('aborted');
    } finally { source.dispose(); unregister(); }
});

test('each source instance owns a separate archive and missing metadata is not silently swallowed', async () => {
    const createSource = vi.fn(() => ({getTile: async () => null, dispose: vi.fn(),
        getMetadata: async () => { throw new Error('archive metadata unavailable'); }}));
    const unregister = registerMvtTileProvider('archive-failure', {createSource});
    const config = {name: 'world', url: 'archive.pmtiles', tile_provider: 'archive-failure'};
    const first = new MVTSource(config), second = new MVTSource(config);
    try {
        await expect(first.getMetadata()).rejects.toThrow('archive metadata unavailable');
        await expect(second.getMetadata()).rejects.toThrow('archive metadata unavailable');
        expect(createSource).toHaveBeenCalledTimes(2);
    } finally { first.dispose(); second.dispose(); unregister(); }
});

test('TileJSON disposal cancels metadata and prevents a late URL from reviving the source', async () => {
    let resolveMetadata: (value: {status: number; body: string}) => void = () => {};
    vi.spyOn(Utils, 'io').mockImplementation(() => new Promise(resolve => { resolveMetadata = resolve; }));
    const cancel = vi.spyOn(Utils, 'cancelRequest').mockImplementation(() => {});
    const source = new NetworkTileSource({name: 'world', tilejson: 'fixtures/tilejson.json'});
    const metadata = source.getMetadata();
    source.dispose(); source.dispose();
    expect(cancel).toHaveBeenCalledOnce();
    resolveMetadata({status: 200, body: JSON.stringify({tiles: ['tiles/{z}/{x}/{y}.mvt']})});
    await expect(metadata).rejects.toThrow('disposed');
    expect(source.url).toBeNull();
});

test('scene credits include worker archive metadata and reject stale source snapshots', async () => {
    const scene = Object.assign(Scene.create({}), {workers: [{}], generation: 0});
    scene.sources = {archive: new MVTSource({name: 'archive', url: 'archive.pmtiles', tile_provider: 'worker-only', attribution: 'author'})};
    const original = Reflect.get(WorkerBroker, 'postMessage');
    const broker = vi.fn(async () => ({archive: {format: 'pmtiles', attributions: ['author', 'archive credit']}}));
    Reflect.set(WorkerBroker, 'postMessage', broker);
    try {
    expect(await scene.getAttributions()).toEqual(['author', 'archive credit']);
    expect(broker).toHaveBeenCalledWith(scene.workers[0], 'self.getSourceMetadata', ['archive'], scene.generation);
    broker.mockImplementation(async () => { scene.sources = {}; return {archive: {format: 'pmtiles', attributions: ['stale']}}; });
    await expect(scene.getSourceMetadata()).rejects.toThrow('changed during metadata');
    } finally { Reflect.set(WorkerBroker, 'postMessage', original); }
});

test('worker metadata rejects a different scene generation rather than returning obsolete credits', async () => {
    const originalGeneration = Reflect.get(SceneWorker, 'generation');
    const worker = Object.assign(SceneWorker, {generation: 12});
    vi.spyOn(SceneWorker, 'awaitConfiguration').mockResolvedValue(undefined);
    try {
        await expect(worker.getSourceMetadata([], 11)).rejects.toThrow('configuration changed');
        expect(await worker.getSourceMetadata([], 12)).toEqual({});
    } finally { Reflect.set(SceneWorker, 'generation', originalGeneration); }
});

test('main scene replacement and removal dispose old sources', () => {
    const scene = Scene.create({});
    const config: {sources: Record<string, {type: string; url: string}>; layers: Record<string, unknown>} =
        {sources: {world: {type: 'MVT', url: 'tiles/{z}/{x}/{y}.mvt'}}, layers: {}};
    Object.assign(scene, {config});
    scene.createDataSources();
    const first = vi.spyOn(scene.sources.world, 'dispose');
    scene.createDataSources();
    expect(first).toHaveBeenCalledOnce();
    const second = vi.spyOn(scene.sources.world, 'dispose');
    config.sources = {};
    scene.createDataSources();
    expect(second).toHaveBeenCalledOnce();
});

test('worker reset disposes archive sources and metadata detects a source replaced during discovery', async () => {
    const originalSources = SceneWorker.sources, originalTiles = SceneWorker.tiles;
    const dispose = vi.fn();
    const source = new MVTSource({name: 'world', url: 'archive.pmtiles'});
    vi.spyOn(source, 'getMetadata').mockImplementation(async () => {
        SceneWorker.sources = {};
        return {attributions: ['retired']};
    });
    vi.spyOn(SceneWorker, 'awaitConfiguration').mockResolvedValue(undefined);
    vi.spyOn(SceneWorker.sharedTileSources, 'finalize').mockImplementation(() => {});
    try {
        SceneWorker.sources = {world: source}; SceneWorker.tiles = {};
        await expect(SceneWorker.getSourceMetadata(['world'])).rejects.toThrow('changed during metadata');
        SceneWorker.sources = {world: {dispose}};
        SceneWorker.finalizeTileSources(); SceneWorker.finalizeTileSources();
        expect(dispose).toHaveBeenCalledOnce();
    } finally { SceneWorker.sources = originalSources; SceneWorker.tiles = originalTiles; }
});
