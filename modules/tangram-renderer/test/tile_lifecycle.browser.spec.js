// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, describe, expect, test, vi} from 'vitest';
import Tile, {debugSumLayerStats} from '../src/tile/tile';
import Collision from '../src/labels/collision';
import WorkerBroker from '../src/utils/worker_broker';
import Task from '../src/utils/task';
import Texture from '../src/gl/texture';
import Utils from '../src/utils/utils';
import Geo from '../src/utils/geo';

function createTile(overrides = {}) {
    const workers = [{id: 0}, {id: 1}];
    const source = {
        id: 1,
        max_zoom: 18,
        name: 'osm',
        preserve_tiles_within_zoom: 1,
        tiled: true,
        zoom_bias: 0,
        zooms: Array.from({length: 19}, (_, zoom) => zoom)
    };
    return new Tile({
        coords: {x: 1, y: 2, z: 3},
        source,
        style_z: 4,
        view: {},
        workers,
        ...overrides
    });
}

function createMesh(overrides = {}) {
    return {
        buffer_size: 32,
        destroy: vi.fn(),
        geometry_count: 2,
        variant: {mesh_order: null},
        ...overrides
    };
}

afterEach(() => vi.restoreAllMocks());

describe('tile lifecycle', () => {
    test('constructs normalized tile metadata and pins workers', () => {
        const tile = createTile();
        expect(tile).toMatchObject({
            built: false,
            generation: null,
            loaded: false,
            loading: false,
            overzoom: 1,
            overzoom2: 2,
            source: expect.objectContaining({name: 'osm'}),
            style_z: 4,
            valid: true
        });
        expect(tile.worker).toBeDefined();
        expect(tile.buildAsMessage()).toMatchObject({key: tile.key, source: 'osm', style_z: 4});

        const untiled = createTile({source: {...tile.source, id: 3, name: 'geojson', tiled: false}});
        expect(untiled.worker_id).toBe(1);
    });

    test('builds through its worker and destroys owned resources', async () => {
        const tile = createTile();
        const post = vi.spyOn(WorkerBroker, 'postMessage').mockResolvedValue('built');
        await expect(tile.build(5, {fade_in: false})).resolves.toBe('built');
        expect(tile).toMatchObject({built: false, fade_in: false, generation: 5, labeled: false, loading: true});
        expect(post).toHaveBeenCalledWith(tile.worker, 'self.buildTile', {tile: expect.objectContaining({generation: 5})});

        const mesh = createMesh();
        const pending = createMesh();
        tile.meshes = {polygons: [mesh]};
        tile.pending_label_meshes = {text: [pending]};
        vi.spyOn(Task, 'removeForTile').mockImplementation(() => {});
        tile.destroy();
        expect(mesh.destroy).toHaveBeenCalled();
        expect(pending.destroy).toHaveBeenCalled();
        expect(tile.valid).toBe(false);
        expect(tile.worker).toBeNull();
    });

    test('cancels network requests and aborts transferred resources', () => {
        vi.spyOn(Utils, 'cancelRequest').mockImplementation(() => {});
        vi.spyOn(Task, 'removeForTile').mockImplementation(() => {});
        vi.spyOn(Collision, 'abortTile').mockImplementation(() => {});
        const release = vi.fn();
        const previous = Texture.textures;
        Texture.textures = {atlas: {release}};
        const tile = {id: 3, key: 'tile', mesh_data: {text: {textures: ['atlas', 'missing']}}, source_data: {request_id: 12}};
        Tile.cancel(tile);
        expect(tile.canceled).toBe(true);
        expect(tile.source_data.request_id).toBeNull();
        expect(Utils.cancelRequest).toHaveBeenCalledWith(12);
        expect(release).toHaveBeenCalled();
        Texture.textures = previous;
        Tile.cancel(null);
    });

    test('selects source layers for defaults, names, arrays, and wildcards', () => {
        const sourceData = {layers: {_default: {id: 'default'}, roads: {id: 'roads'}, water: {id: 'water'}}};
        expect(Tile.getDataForSource(sourceData, {}, 'scene')[0].geom.id).toBe('default');
        const withoutDefault = {layers: {scene: {id: 'scene'}}};
        expect(Tile.getDataForSource(withoutDefault, {}, 'scene')).toEqual([{layer: 'scene', geom: {id: 'scene'}}]);
        expect(Tile.getDataForSource(sourceData, {layer: 'roads'}, 'scene')).toEqual([{layer: 'roads', geom: {id: 'roads'}}]);
        expect(Tile.getDataForSource(sourceData, {layer: ['roads', 'water']}, 'scene')).toHaveLength(2);
        expect(Tile.getDataForSource(sourceData, {all_layers: true, layer: 'ignored'}, 'scene')).toHaveLength(3);
        expect(Tile.getDataForSource(null, {}, 'scene')).toEqual([]);
    });

    test('parses scene layers and dispatches features to styles', () => {
        const feature = {geometry: {type: 'Point', coordinates: [0, 0]}, properties: {name: 'Cafe'}};
        const tile = {
            coords: {x: 0, y: 0, z: 0},
            debug: {},
            default_winding: 'CW',
            id: 5,
            min: {x: 0, y: 0},
            source: 'osm',
            source_data: {layers: {places: {features: [feature]}}}
        };
        const style = {
            addFeature: vi.fn(),
            collision: false,
            hasDataForTile: vi.fn(() => true),
            name: 'points',
            preprocess: vi.fn(group => group)
        };
        const layers = {
            empty: null,
            other: {config_data: {source: 'other'}},
            places: {
                buildDrawGroups: vi.fn(() => ({points: {layers: ['places'], style: 'points'}})),
                config_data: {layer: 'places', source: 'osm'}
            }
        };
        vi.spyOn(Collision, 'startTile').mockImplementation(() => {});
        vi.spyOn(Tile, 'buildStyleGroups').mockImplementation(() => {});
        Tile.buildGeometry(tile, {global: {}, layers, scene_id: 'scene', styles: {points: style}});
        expect(style.addFeature).toHaveBeenCalledWith(feature, expect.anything(), expect.objectContaining({layer: 'places', source: 'osm'}));
        expect(tile.debug.feature_count).toBe(1);
        expect(Tile.buildStyleGroups).toHaveBeenCalled();
    });

    test('finds styles with tile data and completes empty style groups', () => {
        const tile = {debug: {}, id: 8, key: 'tile'};
        const styles = {a: {hasDataForTile: () => true}, b: {hasDataForTile: () => false}};
        expect(Tile.stylesForTile(tile, styles)).toEqual(['a']);
        vi.spyOn(WorkerBroker, 'postMessage').mockImplementation(() => {});
        vi.spyOn(Collision, 'resetTile').mockImplementation(() => {});
        Tile.buildStyleGroups(tile, [], 'scene', style => style.name);
        expect(WorkerBroker.postMessage).toHaveBeenCalledWith(
            'TileManager_scene.buildTileStylesCompleted',
            expect.anything()
        );
        expect(Collision.resetTile).toHaveBeenCalledWith(8);
    });

    test('builds and posts grouped style meshes', async () => {
        const tile = {debug: {}, id: 9, key: 'tile'};
        const first = {name: 'polygons', endData: vi.fn().mockResolvedValue({meshes: {}})};
        const second = {name: 'empty', endData: vi.fn().mockResolvedValue(null)};
        const groups = {main: [first, second]};
        const progress = {};
        vi.spyOn(WorkerBroker, 'postMessage').mockImplementation(() => {});
        vi.spyOn(Collision, 'resetTile').mockImplementation(() => {});
        await Tile.buildStyleGroup({group_name: 'main', groups, progress, scene_id: 'scene', tile});
        expect(progress.done).toBe(true);
        expect(WorkerBroker.postMessage).toHaveBeenCalledWith(
            'TileManager_scene.buildTileStylesCompleted',
            expect.anything()
        );
        expect(Collision.resetTile).toHaveBeenCalledWith(9);
    });

    test('drains failed style groups and forwards late batches for cleanup instead of publishing them', async () => {
        const tile = {debug: {}, id: 9, key: 'tile', generation: 3};
        const textureBatch = {meshes: {}, textures: ['retained-texture']};
        let release;
        const pending = new Promise(resolve => {release = resolve;});
        const groups = {
            failed: [{name: 'raster', endData: vi.fn().mockRejectedValue(new Error('vertex budget exceeded'))},
                {name: 'sibling', endData: vi.fn().mockResolvedValue(textureBatch)}],
            late: [{name: 'late', endData: vi.fn(() => pending)}]
        };
        const progress = {};
        vi.spyOn(WorkerBroker, 'postMessage').mockImplementation(() => {});
        vi.spyOn(WorkerBroker, 'withTransferables').mockImplementation(value => value);
        vi.spyOn(Collision, 'resetTile').mockImplementation(() => {});
        const late = Tile.buildStyleGroup({group_name: 'late', groups, progress, scene_id: 'scene', tile});
        await Tile.buildStyleGroup({group_name: 'failed', groups, progress, scene_id: 'scene', tile});
        expect(WorkerBroker.postMessage).toHaveBeenCalledExactlyOnceWith('TileManager_scene.buildTileError',
            expect.objectContaining({error: expect.stringContaining('vertex budget exceeded'),
                generation: 3, mesh_data: {sibling: textureBatch}}));
        expect(Collision.resetTile).not.toHaveBeenCalled();
        release(textureBatch);
        await late;
        expect(WorkerBroker.postMessage).toHaveBeenLastCalledWith('TileManager_scene.buildTileError',
            expect.objectContaining({mesh_data: {late: textureBatch}}));
        expect(Collision.resetTile).toHaveBeenCalledExactlyOnceWith(9);
    });

    test('creates, sorts, swaps, and releases main-thread meshes', () => {
        const tile = createTile();
        tile.debug.feature_count = 2;
        const old = createMesh();
        const obsolete = createMesh();
        tile.meshes = {polygons: [old], obsolete: [obsolete]};
        tile.mesh_data = {
            polygons: {meshes: {
                late: {variant: {mesh_order: 2}, vertex_data: new Uint8Array([1])},
                early: {variant: {mesh_order: 1}, vertex_data: new Uint8Array([2])}
            }, textures: [], uniforms: {}},
            text: {meshes: {label: {labels: {1: {}}, variant: {}, vertex_data: new Uint8Array([3])}}, textures: [], uniforms: {}}
        };
        const made = [];
        const styles = {
            polygons: {collision: false, makeMesh: vi.fn((data, elements, options) => {
                const result = createMesh({variant: {...options.variant}});
                made.push(result);
                return result;
            })},
            text: {collision: true, makeMesh: vi.fn((data, elements, options) => createMesh({variant: {...options.variant}}))}
        };
        tile.buildMeshes(styles, {done: true, start: true});
        expect(old.destroy).toHaveBeenCalled();
        expect(obsolete.destroy).toHaveBeenCalled();
        expect(tile.meshes.polygons.map(item => item.variant.mesh_order)).toEqual([1, 2]);
        expect(tile.pendingLabelStyleCount()).toBe(1);
        tile.swapPendingLabels();
        expect(tile.labeled).toBe(true);
        expect(tile.pendingLabelStyleCount()).toBe(0);
        expect(tile.meshes.text).toHaveLength(1);
    });

    test('tracks proxy relationships and style readiness', () => {
        const proxy = createTile();
        const child = createTile({style_z: 6});
        proxy.setProxyFor(child);
        expect(proxy.isProxy()).toBe(true);
        expect(proxy.proxy_level).toBe(2);
        expect(child.proxied_as).toBe('child');
        expect(proxy.shouldProxyForStyle('roads')).toBe(true);
        child.meshes.roads = [createMesh()];
        expect(proxy.shouldProxyForStyle('roads')).toBe(false);
        proxy.setProxyFor(null);
        expect(proxy.isProxy()).toBe(false);
    });

    test('updates classic and uniform-buffer tile transforms', () => {
        const tile = createTile();
        const model = new Float64Array(16);
        const model32 = new Float32Array(16);
        const program = {uniform: vi.fn()};
        tile.setupProgram({model, model32}, program);
        expect(program.uniform).toHaveBeenCalledTimes(4);
        expect(model[0]).toBe(tile.span.x / Geo.tile_scale);
        expect(model[5]).toBe(tile.span.y / Geo.tile_scale);
        expect(model[12]).toBe(tile.min.x);
        expect(model[13]).toBe(tile.min.y);
        expect(Array.from(model32)).toEqual(Array.from(model, Math.fround));

        const uniformBuffer = {setUniforms: vi.fn()};
        tile.setupProgram({model, model32}, program, uniformBuffer);
        expect(uniformBuffer.setUniforms).toHaveBeenCalledWith(expect.objectContaining({
            u_tile_fade_in: true,
            u_tile_origin: [tile.min.x, tile.min.y, tile.style_z, tile.coords.z]
        }));
    });

    test('slices, merges, and aggregates nested debug statistics', () => {
        const tile = createTile();
        tile.loading = true;
        expect(Tile.slice(tile, ['source'])).toMatchObject({key: tile.key, loading: true, source: tile.source});
        expect(tile.merge({debug: {feature_count: 2}, error: null, generation: 4, loaded: true, loading: false, mesh_data: {}})).toBe(tile);
        expect(tile).toMatchObject({generation: 4, loaded: true, loading: false});

        const stats = debugSumLayerStats([{debug: {layers: {
            list: {roads: {base: {lines: 2}, features: 1, geoms: 2, styles: {roads: 2}}},
            tree: {roads: {base: {lines: 2}, features: 1, geoms: 2, layers: {
                major: {base: {lines: 2}, features: 1, geoms: 2, styles: {roads: 2}}
            }, styles: {roads: 2}}}
        }}}]);
        expect(stats.list.roads.geoms).toBe(2);
        expect(stats.tree.roads.layers.major.features).toBe(1);
    });
});
