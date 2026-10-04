// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import sceneWorker from '../src/scene/scene_worker';
import SharedTileSourceAdapter, {supportsSharedTileAcquisition} from '../src/sources/shared_tile_source_adapter';
import type {SharedTileContext} from '../src/sources/shared_tile_source_adapter';
import DataSource from '../src/sources/data_source';
import {GeoJSONTileSource} from '../src/sources/geojson';
import {MVTSource} from '../src/sources/mvt';
import {RasterTileSource} from '../src/sources/raster';
import Utils from '../src/utils/utils';
import Tile from '../src/tile/tile';
import WorkerBroker from '../src/utils/worker_broker';
import FeatureSelection from '../src/selection/selection';
import {Style} from '../src/styles/style';
import {getFeatureRenderedGeneration} from '../src/styles/feature_annotations';
import Geo from '../src/utils/geo';

/** One consumer's worker build identity, distinct from the shared normalized data index. */
interface BuildContext extends SharedTileContext {
    /** Mesh style zoom never enters decoded identity. */
    style_z: number;
    /** Scene generation carried by the existing protocol. */
    generation: number;
    /** Loaded consumer state, not decoded-store state. */
    loaded?: boolean;
    /** Worker error state, independent of provider content. */
    error?: unknown;
}

/** Explicitly typed state for the legacy worker's dynamically assigned properties. */
const sources: Record<string, DataSource> = {};
/** Worker build table preserves object identity across delayed completions. */
const tiles: Record<string, BuildContext> = {};
/** Exercise the real worker methods without adding assertions to its legacy dynamic state. */
const worker = Object.assign(sceneWorker, {sources, tiles, generation: 7,
    config_sources: {}, configuring: Promise.resolve()});

/** Fresh consumer with deterministic transform anchors. */
function createTile(key = 'world/0/0/0/1', styleZoom = 1): BuildContext {
    return {source: 'world', key, style_z: styleZoom, generation: 7,
        coords: {x: 0, y: 0, z: 0, key: '0/0/0'},
        min: Geo.metersForTile({x: 0, y: 0, z: 0}), max: Geo.metersForTile({x: 1, y: 1, z: 0})};
}

/** Small hermetic GeoJSON response exercises the real parser and postprocessing. */
const response = {status: 200, body: JSON.stringify({type: 'FeatureCollection', features: [
    {type: 'Feature', id: 7, properties: {kind: 'road'}, geometry: {type: 'Point', coordinates: [0, 0]}}
]})};

/** Provider completion controlled independently of consumer lifetimes. */
function createDeferred<ValueT>() {
    let resolve: (value: ValueT) => void = () => {};
    let reject: (error: unknown) => void = () => {};
    const promise = new Promise<ValueT>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
    return {promise, resolve, reject};
}

beforeEach(() => {
    worker.finalizeTileSources();
    worker.sharedTileSources = new SharedTileSourceAdapter();
    worker.sources = {}; worker.tiles = {}; worker.generation = 7;
    worker.config_sources = {}; worker.configuring = Promise.resolve();
});
afterEach(() => { worker.finalizeTileSources(); vi.restoreAllMocks(); });

test.each(['MVT', 'GeoJSON', 'Raster'])('only exact built-in %s sources without custom hooks share acquisition', format => {
    const config = {name: 'world', type: format, url: '/fixtures/{z}/{x}/{y}.json'};
    const source = format === 'MVT' ? new MVTSource(config, {}) : format === 'GeoJSON' ? new GeoJSONTileSource(config, {}) : new RasterTileSource(config, {});
    expect(supportsSharedTileAcquisition(source)).toBe(true);
    source.transform = () => ({}); expect(supportsSharedTileAcquisition(source)).toBe(false);
    source.transform = undefined; source.preprocess = () => ({}); expect(supportsSharedTileAcquisition(source)).toBe(false);
    source.preprocess = undefined; source.scripts = ['plugin']; expect(supportsSharedTileAcquisition(source)).toBe(false);
});

test('custom subclasses, providers, decoders, standalone sources and instance overrides retain legacy loading', () => {
    class CustomSource extends MVTSource {}
    const config = {name: 'world', type: 'MVT', url: '/fixtures/{z}/{x}/{y}.mvt'};
    expect(supportsSharedTileAcquisition(new CustomSource(config, {}))).toBe(false);
    expect(supportsSharedTileAcquisition(new MVTSource({...config, tile_provider: 'pmtiles'}, {}))).toBe(false);
    expect(supportsSharedTileAcquisition(new MVTSource({...config, decoder: 'custom'}, {}))).toBe(false);
    expect(supportsSharedTileAcquisition(DataSource.create({name: 'world', type: 'GeoJSON', url: 'standalone.json'}, {}))).toBe(false);
    const overridden = new MVTSource(config, {}); overridden.load = async tile => tile;
    expect(supportsSharedTileAcquisition(overridden)).toBe(false); expect(supportsSharedTileAcquisition(undefined)).toBe(false);
});

test('two style builds acquire/decode once, retain detached diagnostics, and share only decoded layers', async () => {
    const pending = createDeferred<typeof response>(), io = vi.spyOn(Utils, 'io').mockReturnValue(pending.promise);
    worker.sources.world = new GeoJSONTileSource({name: 'world', url: '/fixtures/{z}/{x}/{y}.json'}, {});
    const first = createTile(), second = createTile('world/0/0/0/12', 12);
    const firstLoad = worker.loadTileSourceData(first), secondLoad = worker.loadTileSourceData(second);
    await vi.waitFor(() => expect(io).toHaveBeenCalledOnce());
    pending.resolve(response); await Promise.all([firstLoad, secondLoad]);
    expect(first.source_data?.layers).toBe(second.source_data?.layers);
    expect(first.source_data).not.toBe(second.source_data); expect(first.rasters).not.toBe(second.rasters);
    expect(first.debug).not.toBe(second.debug); expect(first.style_z).toBe(1); expect(second.style_z).toBe(12);
    expect(first.source_data).not.toHaveProperty('request_id');
    expect(first.source_data?.url).toBe('/fixtures/0/0/0.json');
    expect(worker.getTileSourceStatistics()).toMatchObject({acquisitions: 1, sharedAcquisitions: 1, consumers: 2, readyTiles: 1, decodedBytes: undefined});
    worker.sharedTileSources.releaseTile(first); worker.sharedTileSources.releaseTile(second);
    expect(worker.getTileSourceStatistics()).toMatchObject({readyTiles: 0, consumers: 0});
});

test('cancelling either pending style consumer leaves the other request and decoded result intact', async () => {
    const pending = createDeferred<typeof response>(), io = vi.spyOn(Utils, 'io').mockReturnValue(pending.promise);
    const cancel = vi.spyOn(Utils, 'cancelRequest').mockImplementation(() => {});
    worker.sources.world = new GeoJSONTileSource({name: 'world', url: '/fixtures/{z}/{x}/{y}.json'}, {});
    const first = createTile(), second = createTile('style-12', 12);
    const firstLoad = worker.loadTileSourceData(first), secondLoad = worker.loadTileSourceData(second);
    const rejected = expect(firstLoad).rejects.toMatchObject({name: 'AbortError'});
    await vi.waitFor(() => expect(io).toHaveBeenCalledOnce());
    worker.sharedTileSources.releaseTile(first); await rejected; expect(cancel).not.toHaveBeenCalled();
    pending.resolve(response); expect(await secondLoad).toBe(second); expect(first.source_data).toBeUndefined();
    worker.sharedTileSources.releaseTile(second); expect(cancel).not.toHaveBeenCalled();
});

test('final cancellation during TileJSON discovery cancels the subsequently assigned network ID', async () => {
    const metadata = createDeferred<{status: number; body: string}>();
    vi.spyOn(Utils, 'io').mockImplementation(url => url.endsWith('tilejson.json') ? metadata.promise : Promise.resolve(response));
    const cancel = vi.spyOn(Utils, 'cancelRequest').mockImplementation(() => {});
    worker.sources.world = new GeoJSONTileSource({name: 'world', tilejson: 'https://fixtures.test/tilejson.json'}, {});
    const tile = createTile(), loading = worker.loadTileSourceData(tile);
    const rejected = expect(loading).rejects.toMatchObject({name: 'AbortError'});
    await vi.waitFor(() => expect(Utils.io).toHaveBeenCalledOnce());
    worker.sharedTileSources.releaseTile(tile); await rejected;
    metadata.resolve({status: 200, body: JSON.stringify({tiles: ['tiles/{z}/{x}/{y}.json']})});
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(tile.source_data).toBeUndefined(); expect(worker.getTileSourceStatistics()).toMatchObject({readyTiles: 0, loadingTiles: 0});
});

test('source replacement and removal release pending work, while style-only configuration retains leases', async () => {
    const pending = createDeferred<typeof response>(); vi.spyOn(Utils, 'io').mockReturnValue(pending.promise);
    vi.spyOn(Utils, 'cancelRequest').mockImplementation(() => {});
    const config = {sources: {world: {type: 'GeoJSON', url: '/fixtures/{z}/{x}/{y}.json'}}};
    worker.createDataSources(config);
    const tile = createTile(); worker.tiles[tile.key] = tile;
    const loading = worker.loadTileSourceData(tile), rejected = expect(loading).rejects.toMatchObject({name: 'AbortError'});
    const source = worker.sources.world;
    worker.createDataSources(config); expect(worker.sources.world).toBe(source);
    expect(worker.getTileSourceStatistics().consumers).toBe(1);
    worker.createDataSources({sources: {}}); await rejected;
    expect(worker.tiles[tile.key]).toBeUndefined(); expect(worker.getTileSourceStatistics().consumers).toBe(0);
    pending.resolve(response);
});

test('resolved provider errors continue to resolve and are visible to every consuming build', async () => {
    vi.spyOn(Utils, 'io').mockRejectedValue(new Error('provider offline'));
    worker.sources.world = new GeoJSONTileSource({name: 'world', url: '/fixtures/{z}/{x}/{y}.json'}, {});
    const first = createTile(), second = createTile('style-12', 12);
    await Promise.all([worker.loadTileSourceData(first), worker.loadTileSourceData(second)]);
    expect(first.source_data?.error).toContain('provider offline'); expect(second.source_data?.error).toBe(first.source_data?.error);
    expect(worker.getTileSourceStatistics().failedAcquisitions).toBe(0);
    worker.sharedTileSources.releaseTile(first); worker.sharedTileSources.releaseTile(second);
});

test('custom hooks load on their original context and never acquire store leases', async () => {
    vi.spyOn(Utils, 'io').mockResolvedValue(response);
    const transform = vi.fn(data => data);
    worker.sources.world = new GeoJSONTileSource({name: 'world', url: '/fixtures/{z}/{x}/{y}.json', transform}, {});
    const first = createTile(), second = createTile('style-12', 12);
    await Promise.all([worker.loadTileSourceData(first), worker.loadTileSourceData(second)]);
    expect(transform).toHaveBeenCalledTimes(2); expect(worker.getTileSourceStatistics().acquisitions).toBe(0);
    expect(first.source_data?.layers).not.toBe(second.source_data?.layers);
});

test('workers with external scripts retain legacy concurrent acquisition even for built-in sources', async () => {
    const io = vi.spyOn(Utils, 'io').mockResolvedValue(response);
    worker.sharedTileSources = new SharedTileSourceAdapter(false, {maxConcurrentLoads: 1});
    worker.sources.world = new GeoJSONTileSource({name: 'world', url: '/fixtures/{z}/{x}/{y}.json'}, {});
    const first = createTile(), second = createTile('style-12', 12);
    await Promise.all([worker.loadTileSourceData(first), worker.loadTileSourceData(second)]);
    expect(io).toHaveBeenCalledTimes(2);
    expect(worker.getTileSourceStatistics()).toMatchObject({acquisitions: 0, consumers: 0, sharingEnabled: false, queuedTiles: 0});
    expect(first.source_data?.layers).not.toBe(second.source_data?.layers);
});

test('a worker queues unique data while duplicate style consumers share the same source-procedure slot', async () => {
    worker.sharedTileSources = new SharedTileSourceAdapter(true, {maxConcurrentLoads: 1});
    worker.sources.world = new GeoJSONTileSource({name: 'world', url: '/fixtures/{z}/{x}/{y}.json'}, {});
    const pending = createDeferred<typeof response>();
    const io = vi.spyOn(Utils, 'io').mockReturnValueOnce(pending.promise).mockResolvedValue(response);
    const first = createTile(), duplicate = createTile('style-12', 12), next = createTile('world/1/0/1/1');
    next.coords = {x: 1, y: 0, z: 1, key: '1/0/1'};
    next.min = Geo.metersForTile(next.coords); next.max = Geo.metersForTile({x: 2, y: 1, z: 1});
    const firstLoad = worker.loadTileSourceData(first), duplicateLoad = worker.loadTileSourceData(duplicate), nextLoad = worker.loadTileSourceData(next);
    await vi.waitFor(() => expect(io).toHaveBeenCalledOnce(), {interval: 1});
    expect(worker.getTileSourceStatistics()).toMatchObject({activeAcquisitions: 1, queuedTiles: 1, consumers: 3, acquisitions: 1, sharedAcquisitions: 1});
    const rejected = expect(firstLoad).rejects.toMatchObject({name: 'AbortError'});
    worker.sharedTileSources.releaseTile(first); await rejected;
    expect(worker.getTileSourceStatistics().activeAcquisitions).toBe(1);
    pending.resolve(response);
    await Promise.all([duplicateLoad, nextLoad]);
    expect(io).toHaveBeenCalledTimes(2);
    expect(duplicate.source_data?.layers).not.toBe(next.source_data?.layers);
    expect(worker.getTileSourceStatistics()).toMatchObject({queuedTiles: 0, readyTiles: 2, consumers: 2, maxConcurrentLoads: 1});
});

test('removing a queued worker tile prevents its provider from being invoked', async () => {
    worker.sharedTileSources = new SharedTileSourceAdapter(true, {maxConcurrentLoads: 1});
    worker.sources.world = new GeoJSONTileSource({name: 'world', url: '/fixtures/{z}/{x}/{y}.json'}, {});
    const pending = createDeferred<typeof response>(), io = vi.spyOn(Utils, 'io').mockReturnValue(pending.promise);
    const first = createTile(), next = createTile('queued');
    next.coords = {x: 1, y: 0, z: 1, key: '1/0/1'};
    worker.tiles[next.key] = next;
    const firstLoad = worker.loadTileSourceData(first), nextLoad = worker.loadTileSourceData(next);
    await vi.waitFor(() => expect(io).toHaveBeenCalledOnce(), {interval: 1});
    const rejected = expect(nextLoad).rejects.toMatchObject({name: 'AbortError'});
    worker.removeTile(next.key); await rejected;
    pending.resolve(response); await firstLoad;
    expect(io).toHaveBeenCalledOnce();
    expect(next.source_data).toBeUndefined();
    expect(worker.getTileSourceStatistics()).toMatchObject({queuedTiles: 0, readyTiles: 1, consumers: 1});
});

test.each(['MVT', 'Raster'])('%s payloads share content without sharing attached-raster arrays or mesh ownership', async format => {
    // Tiny valid MVT roads layer: point ID 7, local origin, extent 4096.
    const bytes = new Uint8Array([26, 23, 10, 5, 114, 111, 97, 100, 115,
        18, 9, 8, 7, 24, 1, 34, 3, 9, 0, 0, 40, 128, 32, 120, 2]);
    const io = vi.spyOn(Utils, 'io').mockResolvedValue({status: 200, body: bytes.buffer});
    const config = {name: 'world', url: '/fixtures/{z}/{x}/{y}.tile', rasters: ['terrain']};
    worker.sources.world = format === 'MVT' ? new MVTSource(config, {}) : new RasterTileSource(config, {});
    const first = createTile(), second = createTile('style-12', 12);
    await Promise.all([worker.loadTileSourceData(first), worker.loadTileSourceData(second)]);
    expect(first.source_data?.layers).toBe(second.source_data?.layers);
    expect(first.source_data?.layers).toHaveProperty(format === 'MVT' ? 'roads' : '_default');
    expect(first.default_winding).toBe(format === 'MVT' ? 'CCW' : 'CW');
    const rasters = format === 'MVT' ? ['terrain'] : ['world', 'terrain'];
    expect(second.rasters).toEqual(rasters);
    first.rasters?.push('consumer-only'); expect(second.rasters).toEqual(rasters);
    expect(io).toHaveBeenCalledTimes(format === 'MVT' ? 1 : 0);
    expect(worker.getTileSourceStatistics()).toMatchObject({acquisitions: 1, sharedAcquisitions: 1, consumers: 2});
});

test('failed source replacement cancels obsolete leases and cannot retain the old source', async () => {
    const pending = createDeferred<typeof response>(); vi.spyOn(Utils, 'io').mockReturnValue(pending.promise);
    vi.spyOn(Utils, 'cancelRequest').mockImplementation(() => {});
    worker.createDataSources({sources: {world: {type: 'GeoJSON', url: '/fixtures/{z}/{x}/{y}.json'}}});
    const tile = createTile(); worker.tiles[tile.key] = tile;
    const loading = worker.loadTileSourceData(tile), rejected = expect(loading).rejects.toMatchObject({name: 'AbortError'});
    worker.createDataSources({sources: {world: {type: 'unregistered'}}}); await rejected;
    expect(worker.sources.world).toBeUndefined(); expect(worker.tiles[tile.key]).toBeUndefined();
    expect(worker.getTileSourceStatistics().consumers).toBe(0); pending.resolve(response);
});

test('final release forces fresh acquisition instead of retaining unreferenced decoded content', async () => {
    const io = vi.spyOn(Utils, 'io').mockResolvedValue(response);
    worker.sources.world = new GeoJSONTileSource({name: 'world', url: '/fixtures/{z}/{x}/{y}.json'}, {});
    const first = createTile(); await worker.loadTileSourceData(first); worker.sharedTileSources.releaseTile(first);
    const second = createTile(); await worker.loadTileSourceData(second);
    expect(io).toHaveBeenCalledTimes(2); expect(first.source_data?.layers).not.toBe(second.source_data?.layers);
    expect(worker.getTileSourceStatistics()).toMatchObject({acquisitions: 2, consumers: 1, readyTiles: 1});
});

test('a late obsolete source revision cannot overwrite the successor payload for the same tile key', async () => {
    const pending = createDeferred<typeof response>();
    const io = vi.spyOn(Utils, 'io').mockImplementation(url => url.includes('old/') ? pending.promise : Promise.resolve(response));
    vi.spyOn(Utils, 'cancelRequest').mockImplementation(() => {});
    worker.createDataSources({sources: {world: {type: 'GeoJSON', url: '/old/{z}/{x}/{y}.json'}}});
    const first = createTile(); worker.tiles[first.key] = first;
    const firstLoad = worker.loadTileSourceData(first), rejected = expect(firstLoad).rejects.toMatchObject({name: 'AbortError'});
    await vi.waitFor(() => expect(io).toHaveBeenCalledOnce());
    worker.createDataSources({sources: {world: {type: 'GeoJSON', url: '/new/{z}/{x}/{y}.json'}}}); await rejected;
    const second = createTile(); worker.tiles[second.key] = second; await worker.loadTileSourceData(second);
    pending.resolve(response); await pending.promise; await Promise.resolve();
    expect(first.source_data).toBeUndefined(); expect(second.source_data?.url).toBe('/new/0/0/0.json');
    expect(worker.tiles[second.key]).toBe(second);
    expect(worker.getTileSourceStatistics()).toMatchObject({acquisitions: 2, consumers: 1, readyTiles: 1});
});

test('switching an existing pending consumer to a custom path releases its obsolete shared lease', async () => {
    const pending = createDeferred<typeof response>();
    vi.spyOn(Utils, 'io').mockReturnValueOnce(pending.promise).mockResolvedValue(response);
    vi.spyOn(Utils, 'cancelRequest').mockImplementation(() => {});
    const source = new GeoJSONTileSource({name: 'world', url: '/fixtures/{z}/{x}/{y}.json'}, {});
    worker.sources.world = source;
    const tile = createTile(), firstLoad = worker.loadTileSourceData(tile);
    const rejected = expect(firstLoad).rejects.toMatchObject({name: 'AbortError'});
    await vi.waitFor(() => expect(Utils.io).toHaveBeenCalledOnce());
    source.transform = (data: unknown) => data;
    await worker.loadTileSourceData(tile); await rejected; pending.resolve(response);
    expect(tile.source_data?.layers).toBeDefined();
    expect(worker.getTileSourceStatistics()).toMatchObject({consumers: 0, readyTiles: 0, cancelledAcquisitions: 1});
});

test.each(['resolve', 'reject'])('stale %s cannot build or report errors for a recreated tile key', async completion => {
    const pending = createDeferred<BuildContext>(), build = vi.spyOn(Tile, 'buildGeometry').mockImplementation(() => {});
    const post = vi.fn(() => Promise.resolve());
    const descriptor = Object.getOwnPropertyDescriptor(WorkerBroker, 'postMessage');
    Object.defineProperty(WorkerBroker, 'postMessage', {value: post, configurable: true});
    try {
        vi.spyOn(worker, 'loadTileSourceData').mockReturnValue(pending.promise);
        const tile = createTile(); await worker.buildTile({tile});
        worker.removeTile(tile.key); worker.tiles[tile.key] = createTile(tile.key);
        if (completion === 'resolve') pending.resolve(tile);
        else pending.reject(new Error('obsolete provider failure'));
        await Promise.resolve(); await Promise.resolve();
        expect(build).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
        expect(worker.tiles[tile.key].error).toBeUndefined();
    } finally {
        if (descriptor) Object.defineProperty(WorkerBroker, 'postMessage', descriptor);
        else Reflect.deleteProperty(WorkerBroker, 'postMessage');
    }
});

test('built-in styling accepts frozen decoded features; queries retain visibility and geometry semantics', () => {
    const feature = Object.freeze({type: 'Feature', id: 7, properties: Object.freeze({kind: 'road'}),
        geometry: Object.freeze({type: 'Point', coordinates: Object.freeze([0, 0])})});
    const tile = {...createTile(), id: 1, loaded: true, debug: {}, source_data: {layers: {roads: {features: [feature]}}}};
    const style = Object.assign(Object.create(Style), {generation: 7, tile_data: {[tile.id]: {}},
        parseFeature: () => ({}), buildGeometry: () => 1});
    style.addFeature(feature, {}, {tile});
    expect(getFeatureRenderedGeneration(feature)).toBe(7); expect(feature).not.toHaveProperty('generation');
    worker.tiles[tile.key] = tile;
    const visible = worker.queryFeatures({filter: null, visible: true, geometry: true, tile_keys: [tile.key]});
    expect(visible).toHaveLength(1); expect(visible[0].properties.$visible).toBe(true);
    expect(visible[0].geometry).not.toBe(feature.geometry);
    worker.generation = 8;
    expect(worker.queryFeatures({filter: null, visible: true, geometry: false, tile_keys: [tile.key]})).toHaveLength(0);
});

test('picking entries remain build-owned when two builds share decoded feature properties', () => {
    const feature = {id: 7, properties: {kind: 'road'}}, first = createTile(), second = createTile('style-12', 12);
    const firstColor = FeatureSelection.makeColor(feature, first, {source: 'world', layer: 'roads', layers: ['roads']});
    FeatureSelection.makeColor(feature, second, {source: 'world', layer: 'roads', layers: ['roads']});
    expect(FeatureSelection.getMapSize()).toBe(2);
    FeatureSelection.clearTile(first.key); expect(FeatureSelection.getMapSize()).toBe(1);
    expect(Reflect.get(FeatureSelection, 'tiles')).toHaveProperty(second.key); expect(firstColor).toHaveLength(4);
    FeatureSelection.clearTile(second.key);
});

test.each([false, true])('native worker bounds real local GeoJSON loads with consumer cancellation=%s', async cancelFirst => {
    const workerUrl = new URL('../build/worker.test.js', import.meta.url).href;
    const fixtureUrl = new URL('./fixtures/shared-tile-source.json', import.meta.url).href;
    const script = `importScripts(${JSON.stringify(workerUrl)});
      self.addEventListener('message', async event => {
        if (event.data?.type !== 'test-run') return;
        try {
          self.init('queue-probe', 0, 1, 'warn', 1, true, [], 1);
          let requests = 0, activeRequests = 0, peakRequests = 0;
          const send = XMLHttpRequest.prototype.send;
          XMLHttpRequest.prototype.send = function(...parameters) {
            requests++; activeRequests++; peakRequests = Math.max(peakRequests, activeRequests);
            let active = true;
            const complete = () => { if (active) { active = false; activeRequests--; } };
            const onReadyStateChange = this.onreadystatechange;
            this.onreadystatechange = function(event) {
              if (this.readyState === 4) complete();
              return onReadyStateChange?.call(this, event);
            };
            this.addEventListener('loadend', complete, {once:true});
            return send.apply(this, parameters);
          };
          self.createDataSources({sources:{world:{type:'GeoJSON',url:${JSON.stringify(`${fixtureUrl}?tile={z}/{x}/{y}`)}}}});
          const create = key => ({source:'world',key,coords:{x:0,y:0,z:0,key:'0/0/0'},min:{x:-20037508.342789244,y:20037508.342789244},max:{x:20037508.342789244,y:-20037508.342789244}});
          const first = create('style-1'), second = create('style-12');
          const firstLoad = self.loadTileSourceData(first).then(()=>'ready', error=>error.name);
          const secondLoad = self.loadTileSourceData(second);
          const next = {...create('other-coordinate'), coords:{x:1,y:0,z:1,key:'1/0/1'}, min:{x:0,y:20037508.342789244},max:{x:20037508.342789244,y:0}};
          const nextLoad = self.loadTileSourceData(next);
          if (${cancelFirst}) self.sharedTileSources.releaseTile(first);
          const firstState = await firstLoad; await secondLoad; await nextLoad;
          self.postMessage({type:'result',requests,peakRequests,firstState,shared:${cancelFirst} ? first.source_data === undefined : first.source_data.layers === second.source_data.layers,stats:self.getTileSourceStatistics()});
          self.sharedTileSources.releaseTile(first); self.sharedTileSources.releaseTile(second); self.sharedTileSources.releaseTile(next);
        } catch(error) { self.postMessage({type:'failure',message:String(error)}); }
      });`;
    const url = URL.createObjectURL(new Blob([script], {type: 'text/javascript'})), nativeWorker = new Worker(url);
    try {
        const result = await new Promise<unknown>((resolve, reject) => {
            nativeWorker.addEventListener('message', event => { if (event.data?.type === 'result') resolve(event.data); else if (event.data?.type === 'failure') reject(new Error(event.data.message)); });
            nativeWorker.addEventListener('error', event => reject(new Error(event.message)));
            nativeWorker.postMessage({type: 'test-run'});
        });
        expect(result).toMatchObject({requests: 2, peakRequests: 1, firstState: cancelFirst ? 'AbortError' : 'ready', shared: true,
            stats: {acquisitions: 2, sharedAcquisitions: 1, consumers: cancelFirst ? 2 : 3, readyTiles: 2, queuedTiles: 0, maxConcurrentLoads: 1}});
    } finally { nativeWorker.terminate(); URL.revokeObjectURL(url); }
});
