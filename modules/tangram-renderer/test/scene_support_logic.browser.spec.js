// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, describe, expect, test, vi} from 'vitest';
import JSZip from 'jszip';
import Utils from '../src/utils/utils';
import * as URLs from '../src/utils/urls';
import Texture from '../src/gl/texture';
import WorkerBroker from '../src/utils/worker_broker';
import debugSettings from '../src/utils/debug_settings';
import setupSceneDebug from '../src/scene/scene_debug';
import {SceneBundle, ZipSceneBundle, createSceneBundle} from '../src/scene/scene_bundle';

afterEach(() => vi.restoreAllMocks());

describe('scene bundles', () => {
    test('resolves regular resources, parent containers, and global references', async () => {
        const bundle = new SceneBundle('https://example.com/maps/root.yaml');
        expect(bundle.resourceFor('styles/roads.yaml')).toEqual({
            path: 'styles/',
            type: 'yaml',
            url: 'https://example.com/maps/styles/roads.yaml'
        });
        expect(bundle.urlFor('global.sdk')).toBe('global.sdk');
        expect(bundle.isContainer()).toBe(false);

        vi.spyOn(Utils, 'io').mockResolvedValue({body: 'sources: {}'});
        await expect(bundle.load()).resolves.toEqual({sources: {}});
        const object = {sources: {}};
        const objectBundle = new SceneBundle(object);
        await expect(objectBundle.load()).resolves.toEqual(object);
        expect(await objectBundle.load()).not.toBe(object);

        const container = new ZipSceneBundle(new ArrayBuffer(0));
        container.path_for_parent = 'inside/';
        container.files['inside/child.yaml'] = {data: new TextEncoder().encode('layers: {}'), type: 'yaml'};
        const child = new SceneBundle('child.yaml', 'inside/', container);
        expect(child.container).toBe(container);
        expect(child.urlFor('child.yaml')).toMatch(/^blob:/);
    });

    test('selects bundle types and handles zip roots', async () => {
        expect(createSceneBundle('scene.yaml')).toBeInstanceOf(SceneBundle);
        expect(createSceneBundle('https://example.com/scene.zip')).toBeInstanceOf(ZipSceneBundle);
        expect(createSceneBundle({}, null, null, 'zip')).toBeInstanceOf(ZipSceneBundle);

        const zip = new ZipSceneBundle(new ArrayBuffer(0));
        expect(await zip.load()).toBe(zip);
        zip.files = {
            'root.yaml': {data: new TextEncoder().encode('layers: {}'), depth: 0, type: 'yaml'},
            'textures/icon.png': {data: new Uint8Array([1]), depth: 1, type: 'png'}
        };
        zip.findRoot();
        expect(zip.root).toBe('root.yaml');
        expect(zip.typeFor('textures/icon.png')).toBe('png');
        expect(zip.typeFor('https://example.com/a.json')).toBe('json');
        expect(zip.urlFor('global.texture')).toBe('global.texture');
        expect(zip.urlFor('textures/../root.yaml')).toMatch(/^blob:/);

        vi.spyOn(Utils, 'io').mockResolvedValue({body: 'layers: {}'});
        await expect(zip.loadRoot()).resolves.toEqual({layers: {}});
    });

    test('rejects missing and ambiguous zip roots', () => {
        const zip = new ZipSceneBundle('scene.zip');
        zip.files = {};
        expect(() => zip.findRoot()).toThrow('Found NO YAML files');
        zip.files = {
            'first.yaml': {depth: 0},
            'second.yaml': {depth: 0}
        };
        expect(() => zip.findRoot()).toThrow('Found multiple YAML files');
    });

    test('indexes files parsed by JSZip', async () => {
        const archive = new JSZip();
        archive.file('root.yaml', 'layers: {}');
        archive.file('folder/data.json', '{}');
        const zip = new ZipSceneBundle(new ArrayBuffer(0));
        zip.zip = await JSZip.loadAsync(await archive.generateAsync({type: 'arraybuffer'}));
        await zip.parseZipFiles();
        expect(zip.files['root.yaml']).toMatchObject({depth: 0, type: 'yaml'});
        expect(zip.files['folder/data.json']).toMatchObject({depth: 1, type: 'json'});
        expect(zip.urlForZipFile('missing')).toBeUndefined();
        expect(zip.typeForZipFile('missing')).toBeUndefined();
    });
});

describe('scene diagnostics', () => {
    test('summarizes geometry, buffers, textures, and renderable tiles', () => {
        const tiles = [{meshes: {
            roads: [{buffer_size: 100, geometry_count: 4}, {buffer_size: 20, geometry_count: 1}],
            places: [{buffer_size: 30, geometry_count: 2}]
        }}];
        const scene = {
            styles: {
                roads: {baseStyle: () => 'lines'},
                places: {baseStyle: () => 'points'}
            },
            tile_manager: {getRenderableTiles: vi.fn(() => tiles)},
            workers: [{}]
        };
        setupSceneDebug(scene);
        expect(scene.debug.geometryCountByStyle()).toEqual({roads: 5, places: 2});
        expect(scene.debug.geometryCountByBaseStyle()).toEqual({lines: 5, points: 2});
        expect(scene.debug.geometryCountTotal()).toBe(7);
        expect(scene.debug.geometrySizeByStyle()).toEqual({roads: 120, places: 30});
        expect(scene.debug.geometrySizeByBaseStyle()).toEqual({lines: 120, points: 30});
        expect(scene.debug.geometrySizeTotal()).toBe(150);
        expect(scene.debug.renderableTilesCount()).toBe(1);

        const previous = Texture.textures;
        Texture.textures = {a: {byteSize: () => 10}, b: {byteSize: () => 25}};
        expect(scene.debug.textureSizeTotal()).toBe(35);
        Texture.textures = previous;

        debugSettings.layer_stats = false;
        expect(scene.debug.layerStats()).toEqual({});
    });

    test('fans profiling calls out to workers', () => {
        const scene = {tile_manager: {getRenderableTiles: () => []}, workers: [{}]};
        setupSceneDebug(scene);
        vi.spyOn(console, 'profile').mockImplementation(() => {});
        vi.spyOn(console, 'profileEnd').mockImplementation(() => {});
        const post = vi.spyOn(WorkerBroker, 'postMessage').mockImplementation(() => Promise.resolve());
        scene.debug.profile('load');
        scene.debug.profileEnd('load');
        expect(console.profile).toHaveBeenCalledWith('main thread: load');
        expect(console.profileEnd).toHaveBeenCalledWith('main thread: load');
        expect(post).toHaveBeenCalledWith(scene.workers, 'self.profile', 'load');
        expect(post).toHaveBeenCalledWith(scene.workers, 'self.profileEnd', 'load');
    });
});
