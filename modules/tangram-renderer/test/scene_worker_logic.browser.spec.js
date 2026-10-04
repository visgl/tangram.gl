// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, beforeAll, beforeEach, describe, expect, test, vi} from 'vitest';
import Utils from '../src/utils/utils';
import Tile from '../src/tile/tile';
import FeatureSelection from '../src/selection/selection';
import Texture from '../src/gl/texture';
import WorkerBroker from '../src/utils/worker_broker';

let worker;

beforeAll(async () => {
    await import('../src/scene/scene_worker');
    worker = self;
});

beforeEach(() => {
    worker.sources = {};
    worker.styles = {};
    worker.layers = {};
    worker.tiles = {};
    worker.global = {};
    worker.generation = 7;
    worker.configuring = Promise.resolve();
});

afterEach(() => vi.restoreAllMocks());

describe('scene worker lifecycle', () => {
    test('initializes worker identity, selection, styles, and pixel ratio', () => {
        const importScripts = vi.spyOn(worker, 'importExternalScripts').mockImplementation(() => {});
        expect(worker.init('scene-1', 2, 4, 'warn', 3, true, [])).toBe(2);
        expect(worker.scene_id).toBe('scene-1');
        expect(worker.num_workers).toBe(4);
        expect(Utils.device_pixel_ratio).toBe(3);
        expect(worker.style_manager.constructor.name).toBe('StyleManager');
        expect(importScripts).toHaveBeenCalledWith([]);
    });

    test('skips empty external scripts and copies imported window globals', () => {
        worker.importExternalScripts([]);
        const original = globalThis.importScripts;
        globalThis.importScripts = vi.fn(() => { window.__tangramImported = 'ready'; });
        worker.importExternalScripts(['plugin.js']);
        expect(globalThis.importScripts).toHaveBeenCalledWith('plugin.js');
        expect(worker.__tangramImported).toBe('ready');
        delete window.__tangramImported;
        if (original) {
            globalThis.importScripts = original;
        }
        else {
            delete globalThis.importScripts;
        }
    });

    test('creates, reuses, and invalidates data sources', () => {
        const retained = {name: 'same'};
        worker.sources = {same: retained};
        worker.config_sources = {same: {type: 'GeoJSON', url: 'same.json'}};
        worker.tiles = {
            old: {source: 'changed'},
            keep: {source: 'same'}
        };
        worker.createDataSources({sources: {
            same: {type: 'GeoJSON', url: 'same.json'},
            changed: {type: 'GeoJSON', url: 'changed.json'},
            invalid: {type: 'not-a-source'}
        }});
        expect(worker.sources.same).toBe(retained);
        expect(worker.sources.changed.name).toBe('changed');
        expect(worker.sources.invalid).toBeUndefined();
        expect(worker.tiles.old).toBeUndefined();
        expect(worker.tiles.keep).toBeDefined();
    });

    test('updates parsed config and awaits texture synchronization', async () => {
        worker.style_manager = {
            build: vi.fn(() => ({})),
            initStyles: vi.fn()
        };
        vi.spyOn(worker, 'syncTextures').mockResolvedValue(undefined);
        await worker.updateConfig({
            config: JSON.stringify({global: {}, layers: {}, sources: {}, styles: {}, textures: {}}),
            generation: 8,
            introspection: true,
            shader_language: 'wgsl'
        }, {});
        expect(worker.generation).toBe(8);
        expect(worker.introspection).toBe(true);
        expect(worker.style_manager.initStyles).toHaveBeenCalledWith(expect.objectContaining({
            generation: 8,
            shader_language: 'wgsl'
        }));
        await expect(worker.awaitConfiguration()).resolves.toBeUndefined();
    });

    test('loads source data, reuses matching tiles, and handles missing sources', async () => {
        const source = {
            copyTileData: vi.fn((reference, tile) => ({reference, tile})),
            load: vi.fn(async tile => tile)
        };
        worker.sources.osm = source;
        const reference = {source: 'osm', coords: {key: '1/2/3'}, loaded: true};
        worker.tiles.reference = reference;
        const reused = {source: 'osm', coords: {key: '1/2/3'}};
        await worker.loadTileSourceData(reused);
        expect(source.copyTileData).toHaveBeenCalledWith(reference, reused);

        worker.tiles = {};
        const loaded = {source: 'osm', coords: {key: 'new'}};
        await expect(worker.loadTileSourceData(loaded)).resolves.toBe(loaded);
        const missing = {source: 'missing'};
        await expect(worker.loadTileSourceData(missing)).resolves.toBe(missing);
        expect(missing.source_data).toEqual({});
    });

    test('builds cached and newly loaded tiles and reports failures', async () => {
        const build = vi.spyOn(Tile, 'buildGeometry').mockImplementation(() => {});
        const postMessage = vi.spyOn(WorkerBroker, 'postMessage').mockImplementation(() => {});
        worker.scene_id = 'scene-1';

        worker.tiles.cached = {key: 'cached', loaded: true};
        await worker.buildTile({tile: {key: 'cached'}});
        expect(build).toHaveBeenCalledWith(worker.tiles.cached, worker);

        build.mockImplementationOnce(() => { throw new Error('geometry failed'); });
        await worker.buildTile({tile: {key: 'cached'}});
        expect(worker.tiles.cached.error).toBe('Error: geometry failed');
        expect(postMessage).toHaveBeenCalled();

        vi.spyOn(worker, 'loadTileSourceData').mockImplementation(async tile => {
            tile.source_data = {layers: {}};
            return tile;
        });
        await worker.buildTile({tile: {key: 'new', loaded: false}});
        await Promise.resolve();
        expect(worker.tiles.new.loaded).toBe(true);
        expect(build).toHaveBeenCalledWith(worker.tiles.new, worker);

        worker.loadTileSourceData.mockRejectedValueOnce(new Error('load failed'));
        await worker.buildTile({tile: {key: 'broken', loaded: false}});
        await Promise.resolve();
        expect(worker.tiles.broken.error).toContain('load failed');
        expect(postMessage).toHaveBeenCalledWith('TileManager_scene-1.buildTileError', expect.anything());
    });

    test('ignores duplicate loads and loaded tiles removed during fetch', async () => {
        worker.tiles.loading = {key: 'loading', loading: true};
        expect(worker.buildTile({tile: {key: 'loading'}})).toBeUndefined();

        let resolveLoad;
        vi.spyOn(worker, 'loadTileSourceData').mockReturnValue(new Promise(resolve => { resolveLoad = resolve; }));
        const building = worker.buildTile({tile: {key: 'removed'}});
        await building;
        delete worker.tiles.removed;
        resolveLoad();
        await Promise.resolve();
        expect(worker.tiles.removed).toBeUndefined();
    });

    test('removes cached and loading tiles', () => {
        vi.spyOn(Tile, 'cancel').mockImplementation(() => {});
        vi.spyOn(FeatureSelection, 'clearTile').mockImplementation(() => {});
        worker.tiles.busy = {key: 'busy', loading: true};
        worker.removeTile('busy');
        expect(Tile.cancel).toHaveBeenCalled();
        expect(FeatureSelection.clearTile).toHaveBeenCalledWith('busy');
        expect(worker.getTile('busy')).toBeUndefined();
        worker.removeTile('missing');
    });

    test('queries visible features and optional geometry', () => {
        worker.tiles.a = {
            loaded: true,
            source: 'osm',
            coords: {z: 0},
            min: {x: 0, y: 0},
            source_data: {layers: {roads: {features: [
                {generation: 7, geometry: {type: 'Point', coordinates: [0, 0]}, id: 1, properties: {kind: 'road'}, type: 'Feature'},
                {generation: 6, geometry: {type: 'Point', coordinates: [0, 0]}, id: 2, properties: {kind: 'path'}, type: 'Feature'}
            ]}, empty: null}}
        };
        const visible = worker.queryFeatures({filter: '{"kind":"road"}', visible: true, geometry: true, tile_keys: ['a', 'missing']});
        expect(visible).toHaveLength(1);
        expect(visible[0].properties).toMatchObject({$source: 'osm', $layer: 'roads', $visible: true});
        expect(visible[0].geometry).toBeDefined();
        expect(worker.queryFeatures({filter: null, visible: false, geometry: false, tile_keys: ['a']})).toHaveLength(1);
    });

    test('manages selection, textures, pixel ratio, and function cache', async () => {
        FeatureSelection.map.selection = {feature: {id: 3}};
        expect(worker.getFeatureSelection({id: 9, key: 'selection'})).toEqual({id: 9, feature: {id: 3}});
        expect(worker.getFeatureSelection({id: 10, key: 'missing'})).toEqual({id: 10, feature: undefined});
        worker.resetFeatureSelection();
        expect(worker.getFeatureSelectionMapSize()).toBe(0);

        const sync = vi.spyOn(Texture, 'syncTexturesToWorker').mockResolvedValue(undefined);
        await worker.syncTextures({icons: {}, labels: {}});
        expect(sync).toHaveBeenCalledWith(['icons', 'labels']);
        await expect(worker.syncTextures(null)).resolves.toBeUndefined();
        worker.updateDevicePixelRatio(4);
        expect(Utils.device_pixel_ratio).toBe(4);
        worker.clearFunctionStringCache();
    });
});
