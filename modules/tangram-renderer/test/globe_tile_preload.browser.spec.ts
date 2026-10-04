// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import {Matrix4} from '@math.gl/core';
import Renderer from '../src/scene/renderer';
import HostFrame from '../src/scene/host_frame';
import TileManager from '../src/tile/tile_manager';
import type {TileReference} from '../src/tile/tile_id';
import {TileID} from '../src/tile/tile_id';
import {createGlobePreloadCoordinates, getGlobePreloadKey, getGlobeFallbackClipBounds} from '../src/tile/globe_tile_preload';

/** Minimal real host frame with configurable camera and geographic detail. */
function createFrame(overrides: Record<string, unknown> = {}) {
    return HostFrame.from({viewport: {width: 512, height: 320},
        geographicAnchor: {longitude: 0, latitude: 0, zoom: 5},
        projection: {type: 'globe', visibleBounds: [-30, -30, 30, 30]},
        renderViews: [{camera: {view: new Matrix4(), projection: new Matrix4(), position: [0, -1000, 0]}}],
        globePreloadZoom: 2, ...overrides});
}

test.each([0, 1, 2, 3])('global preload level %s is bounded, canonical and camera independent', zoom => {
    const coordinates = createGlobePreloadCoordinates(zoom);
    expect(coordinates).toHaveLength(4 ** zoom);
    expect(new Set(coordinates.map(coordinate => coordinate.key)).size).toBe(coordinates.length);
    const renderer = new Renderer({});
    try {
        renderer.setFrame(createFrame({globePreloadZoom: zoom}));
        expect(renderer.scene.view.findPreloadedTileCoordinates()).toEqual(coordinates);
        renderer.setFrame(createFrame({globePreloadZoom: zoom,
            geographicAnchor: {longitude: 180, latitude: 0, zoom: 5},
            projection: {type: 'globe', visibleBounds: [150, -30, -150, 30]}}));
        expect(renderer.scene.view.findPreloadedTileCoordinates()).toEqual(coordinates);
        renderer.setFrame(createFrame({globePreloadZoom: zoom, tileZoom: 0}));
        expect(renderer.scene.view.findPreloadedTileCoordinates()).toHaveLength(1);
        renderer.setFrame(createFrame({globePreloadZoom: undefined}));
        expect(renderer.scene.view.findPreloadedTileCoordinates()).toEqual([]);
    } finally { renderer.destroy(); }
});

test.each([-1, 4, 2.5, Infinity, NaN, null, '2'])('rejects invalid global preload level %s before scene mutation', value => {
    const renderer = new Renderer({});
    try {
        const frame = createFrame();
        renderer.setFrame(frame);
        expect(() => renderer.setFrame(createFrame({globePreloadZoom: value}))).toThrow(/globePreloadZoom/);
        expect(renderer.host_frame).toBe(frame);
        if (typeof value === 'number') expect(() => createGlobePreloadCoordinates(value)).toThrow(/preload zoom/);
    } finally { renderer.destroy(); }
});

test('preloading is globe-only and source normalization cannot multiply the global budget', () => {
    expect(() => createFrame({projection: {type: 'web-mercator'}})).toThrow(/globe projection/);
    const source = {id: 0, name: 'world', zooms: [0, 1, 2, 3, 4]};
    const child = {x: 15, y: 8, z: 4};
    expect(getGlobePreloadKey(child, source, 5, 2)).toBe('world/3/2/2/5');
    expect(getGlobePreloadKey(child, {...source, zoom_bias: 1}, 5, 2)).toBe('world/1/1/1/5');
    expect(getGlobePreloadKey(child, {...source, zooms: [5, 6]}, 5, 2)).toBeUndefined();
});

test('fallback clip bounds partition coarse tiles without overlap, including antimeridian edges', () => {
    expect(getGlobeFallbackClipBounds({x: 3, y: 2, z: 2}, {x: 15, y: 8, z: 4})).toEqual([3072, -1024, 4096, 0]);
    expect(getGlobeFallbackClipBounds({x: 0, y: 0, z: 0}, {x: 0, y: 0, z: 1})).toEqual([0, -2048, 2048, 0]);
    expect(getGlobeFallbackClipBounds({x: 0, y: 0, z: 0}, {x: 1, y: 0, z: 1})).toEqual([2048, -2048, 4096, 0]);
});

test('globe pruning retains only pinned global tiles and releases them when preloading is disabled', () => {
    const renderer = new Renderer({});
    const view = renderer.scene.view;
    const pinnedKeys = new Set(['global']);
    view.scene.tile_manager.isTilePreloaded = key => pinnedKeys.has(key);
    const removed: string[] = [];
    const tiles = ['global', 'offscreen'].map(key => ({key, visible: false, loading: true,
        style_z: 5, coords: TileID.coord({x: 0, y: 0, z: 2}), isProxy: () => false, setupProgram: () => {}}));
    const remove = vi.spyOn(view.scene.tile_manager, 'removeTiles').mockImplementation(filter => {
        for (const tile of tiles) if (filter(tile)) removed.push(tile.key);
    });
    try {
        renderer.setFrame(createFrame());
        removed.length = 0;
        view.pruneTilesForView();
        expect(removed).toEqual(['offscreen']);
        pinnedKeys.clear();
        renderer.setFrame(createFrame({globePreloadZoom: undefined}));
        removed.length = 0;
        view.pruneTilesForView();
        expect(removed).toEqual(['global', 'offscreen']);
    } finally { remove.mockRestore(); renderer.destroy(); }
});

test('rotation uses pinned coarse tiles for pending detail and drops clips as detail completes', () => {
    const source = {id: 0, name: 'world', zooms: [0, 1, 2, 3, 4, 5]};
    type CachedTile = TileReference & {key: string; loaded: boolean; built: boolean; visible: boolean;
        meshes: Record<string, unknown[]>; fallback_for: Map<string, number[]> | null;
        fallback_pending: boolean; setProxyFor: ReturnType<typeof vi.fn>};
    const scene = {id: 'globe-preload-test', sources: {world: source}, view: {tile_zoom: 5}};
    const tiles: Record<string, CachedTile> = {};
    const visibleCoordinates: Record<string, ReturnType<typeof TileID.coord>> = {};
    const preloadState: {preload_zoom: number | undefined} = {preload_zoom: 1};
    const manager = Object.assign(new TileManager({scene}), {scene, tiles, ...preloadState,
        preloaded_keys: new Set<string>(), visible_coords: visibleCoordinates});
    const coarse: CachedTile = {key: 'world/0/0/1/5', coords: {x: 0, y: 0, z: 1}, source, style_z: 5,
        fallback_for: null, fallback_pending: false,
        loaded: true, built: true, visible: false, meshes: {polygons: [{}]}, setProxyFor: vi.fn()};
    const detail: CachedTile = {key: 'world/0/0/2/5', coords: {x: 0, y: 0, z: 2}, source, style_z: 5,
        fallback_pending: false, fallback_for: null,
        loaded: true, built: false, visible: true, meshes: {polygons: [{}]}, setProxyFor: vi.fn()};
    // Exercise production state transitions without a network source or worker timing.
    manager.tiles = {[coarse.key]: coarse, [detail.key]: detail};
    manager.preload_zoom = 1;
    manager.preloaded_keys.add(coarse.key);
    manager.visible_coords = {'0/0/2': TileID.coord(detail.coords)};
    manager.updateGlobeFallbackTiles();
    expect(manager.getRenderableTiles()).toEqual([]);
    expect(manager.updateRenderableTiles()).toEqual([coarse]);
    expect(coarse.fallback_for?.size).toBe(1);
    expect(detail.fallback_pending).toBe(true);
    expect(manager.isTilePreloaded(coarse.key)).toBe(true);
    // Empty and label-only ancestors must not hide partially built detail.
    const unsupportedMeshes: Record<string, unknown[]>[] = [{polygons: []}, {text: [{}]}, {points: [{}]}];
    for (const meshes of unsupportedMeshes) {
        coarse.meshes = meshes;
        coarse.visible = false;
        manager.updateGlobeFallbackTiles();
        expect(coarse.fallback_for).toBeNull();
        expect(detail.fallback_pending).toBe(false);
        expect(manager.updateRenderableTiles()).toEqual([detail]);
    }
    coarse.meshes = {polygons: [{}]};
    manager.updateGlobeFallbackTiles();
    expect(detail.fallback_pending).toBe(true);
    manager.preload_zoom = undefined;
    manager.updateGlobeFallbackTiles();
    expect(coarse.fallback_for).toBeNull();
    expect(detail.fallback_pending).toBe(false);
    manager.preload_zoom = 1;
    detail.built = true;
    coarse.visible = false;
    manager.updateGlobeFallbackTiles();
    expect(manager.updateRenderableTiles()).toEqual([detail]);
    expect(coarse.fallback_for).toBeNull();
    expect(detail.fallback_pending).toBe(false);
    manager.tiles = {};
    manager.destroy();
});
