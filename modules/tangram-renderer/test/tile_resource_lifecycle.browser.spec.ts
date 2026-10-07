// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Matrix4} from '@math.gl/core';
import {afterEach, expect, test, vi} from 'vitest';
import HostFrame from '../src/scene/host_frame';
import Renderer from '../src/scene/renderer';
import TileManager from '../src/tile/tile_manager';
import Tile from '../src/tile/tile';
import {TileID} from '../src/tile/tile_id';
import {NetworkTileSource} from '../src/sources/data_source';

afterEach(() => vi.restoreAllMocks());

/** Typed real frame with independently selectable resource limits. */
function createFrame(tileResources: unknown = undefined) {
    return HostFrame.from({viewport: {width: 400, height: 300},
        geographicAnchor: {longitude: 0, latitude: 0, zoom: 2}, tileResources,
        renderViews: [{camera: {view: new Matrix4(), projection: new Matrix4(), position: [0, 0, 0]}}]});
}

test.each(['maxConcurrentBuilds', 'maxCachedTiles', 'maxCachedMeshBytes'])('%s rejects invalid resource limits atomically', name => {
    const renderer = new Renderer({});
    const frame = createFrame({maxConcurrentBuilds: 2});
    renderer.setFrame(frame);
    try {
        for (const value of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, null, '2']) {
            expect(() => renderer.setFrame(createFrame({[name]: value}))).toThrow(/tileResources/);
            expect(renderer.host_frame).toBe(frame);
        }
        if (name === 'maxConcurrentBuilds') expect(() => createFrame({[name]: 0})).toThrow(/positive/);
        else expect(createFrame({[name]: 0}).tileResources).toEqual({[name]: 0});
    } finally { renderer.destroy(); }
});

test('resource policies are copied, frozen, applied without camera movement and restored by omission', () => {
    const renderer = new Renderer({});
    const options = {maxConcurrentBuilds: 1, maxCachedTiles: 0};
    const first = createFrame(options);
    options.maxConcurrentBuilds = 100;
    const install = vi.spyOn(renderer.scene.view.scene.tile_manager, 'setResourceLimits');
    const visibility = vi.spyOn(renderer.scene.view, 'updateBounds');
    try {
        renderer.setFrame(first);
        expect(first.tileResources?.maxConcurrentBuilds).toBe(1);
        expect(Object.isFrozen(first.tileResources)).toBe(true);
        const count = visibility.mock.calls.length;
        renderer.setFrame(createFrame({maxConcurrentBuilds: 2}));
        expect(visibility.mock.calls.length).toBeGreaterThan(count);
        expect(install).toHaveBeenLastCalledWith({maxConcurrentBuilds: 2});
        renderer.setFrame(createFrame());
        expect(install).toHaveBeenLastCalledWith(undefined);
        expect(renderer.getTileResourceStatistics()).toEqual({activeBuilds: 0, queuedBuilds: 0,
            residentTiles: 0, cachedTiles: 0, cachedMeshBytes: 0, protectedTiles: 0, protectedMeshBytes: 0});
        for (const value of [null, [], 1]) expect(() => createFrame(value)).toThrow(/tileResources/);
    } finally { renderer.destroy(); }
});

/** A real source and real tile lifecycle with deterministic worker replies and no GPU allocation. */
function createManager() {
    const source = new NetworkTileSource({id: 1, name: 'fixture', url: 'data:application/json,{}', max_zoom: 2});
    source.builds_geometry_tiles = true;
    const scene = {id: 'resource-lifecycle', generation: 1, workers: [{}], sources: {fixture: source}, styles: {},
        view: {tile_zoom: 2, center: {tile: TileID.coord({x: 2, y: 2, z: 2})}},
        tileManagerBuildDone: vi.fn(), tileManagerBuildError: vi.fn(), requestRedraw: vi.fn(), withWebGLContext: (callback: () => void) => callback()};
    const tiles: Record<string, Tile> = {};
    const manager = Object.assign(new TileManager({scene}), {tiles});
    const workerMessage = vi.spyOn(Tile.prototype, 'workerMessage').mockResolvedValue(undefined);
    vi.spyOn(Tile.prototype, 'buildMeshes').mockImplementation(() => {});
    vi.spyOn(manager, 'updateTileStates').mockImplementation(() => {});
    manager.setResourceLimits({maxConcurrentBuilds: 1, maxCachedTiles: 0});
    return {manager, scene, workerMessage};
}

/** Complete an actual tile generation through the production callback. */
function completeTile(manager: TileManager, tile: Tile) {
    manager.buildTileStylesCompleted({tile: {...Tile.slice(tile), loading: false, loaded: true},
        progress: {start: true, done: true}});
}

test('source-normalized deduplication, partial replies, completion and removal share one worker budget', () => {
    const {manager, scene, workerMessage} = createManager();
    try {
        const coordinates = [0, 1, 2].map(x => TileID.coord({x, y: 1, z: 2}));
        for (const coordinate of coordinates) manager.visible_coords[coordinate.key] = coordinate;
        for (const coordinate of coordinates) manager.loadCoordinate(coordinate);
        manager.loadCoordinate(coordinates[0]);
        expect(manager.getResourceStatistics()).toMatchObject({activeBuilds: 1, queuedBuilds: 2, residentTiles: 3});
        const [first, second, third] = Object.values(manager.tiles);
        expect(workerMessage.mock.calls.filter(call => call[0] === 'self.buildTile')).toHaveLength(1);
        manager.buildTileStylesCompleted({tile: {...Tile.slice(first), loading: false, loaded: true},
            progress: {start: true, done: false}});
        expect(manager.getResourceStatistics().activeBuilds).toBe(1);
        manager.checkBuildQueue();
        expect(scene.tileManagerBuildDone).not.toHaveBeenCalled();
        completeTile(manager, first);
        expect(manager.getResourceStatistics()).toMatchObject({activeBuilds: 1, queuedBuilds: 1});
        manager.removeTile(second.key);
        expect(third.generation).toBe(1);
        expect(manager.getResourceStatistics()).toMatchObject({activeBuilds: 1, queuedBuilds: 0});
        completeTile(manager, third);
        expect(manager.getResourceStatistics().activeBuilds).toBe(0);
        expect(scene.tileManagerBuildDone).toHaveBeenCalled();
    } finally { manager.destroy(); }
});

test('scene rebuilds wait behind old generations and ignore their stale errors', () => {
    const {manager, scene} = createManager();
    try {
        const coordinate = TileID.coord({x: 0, y: 1, z: 2});
        manager.visible_coords[coordinate.key] = coordinate;
        manager.loadCoordinate(coordinate);
        const tile = Object.values(manager.tiles)[0];
        const old = Tile.slice(tile);
        scene.generation = 2;
        manager.buildTile(tile, {fade_in: false});
        expect(manager.getResourceStatistics()).toMatchObject({activeBuilds: 1, queuedBuilds: 1});
        manager.buildTileError({...old, error: new Error('stale')});
        expect(scene.tileManagerBuildError).not.toHaveBeenCalled();
        expect(manager.hasTile(tile.key)).toBe(true);
        expect(tile.generation).toBe(2);
        expect(manager.getResourceStatistics()).toMatchObject({activeBuilds: 1, queuedBuilds: 0});
        manager.buildTileStylesCompleted({tile: old, progress: {done: true}});
        expect(manager.getResourceStatistics().activeBuilds).toBe(1);
        completeTile(manager, tile);
        expect(manager.getResourceStatistics().activeBuilds).toBe(0);
    } finally { manager.destroy(); }
});

test('rejected worker promises destroy owned resources and release the next slot', async () => {
    const {manager, scene, workerMessage} = createManager();
    workerMessage.mockRejectedValueOnce(new Error('fixture failure'));
    const destroy = vi.spyOn(Tile.prototype, 'destroy');
    try {
        for (const x of [0, 1]) manager.loadCoordinate(TileID.coord({x, y: 1, z: 2}));
        await vi.waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
        expect(scene.tileManagerBuildError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({message: 'fixture failure'}));
        expect(manager.getResourceStatistics()).toMatchObject({activeBuilds: 1, queuedBuilds: 0, residentTiles: 1});
    } finally { manager.destroy(); }
});

test('cache eviction calls actual tile destruction while preserving eye visibility and pinned fallback', () => {
    const {manager} = createManager();
    manager.setResourceLimits(undefined);
    try {
        for (const x of [0, 1, 2]) manager.loadCoordinate(TileID.coord({x, y: 1, z: 2}));
        const [visible, pinned, cached] = Object.values(manager.tiles);
        for (const tile of [visible, pinned, cached]) completeTile(manager, tile);
        visible.visible = true;
        manager.preloaded_keys.add(pinned.key);
        const destroy = vi.spyOn(cached, 'destroy');
        manager.setResourceLimits({maxCachedTiles: 0, maxCachedMeshBytes: 0});
        manager.enforceCacheLimits();
        expect(destroy).toHaveBeenCalledOnce();
        expect(manager.hasTile(visible.key)).toBe(true);
        expect(manager.hasTile(pinned.key)).toBe(true);
        expect(manager.getResourceStatistics()).toMatchObject({residentTiles: 2, cachedTiles: 0, protectedTiles: 2});
    } finally { manager.destroy(); }
});

test('main-thread rejection releases owned mesh batches once and late replies cannot release replacement work', () => {
    const {manager} = createManager();
    const abort = vi.spyOn(Tile, 'abortBuild');
    try {
        const coordinate = TileID.coord({x: 0, y: 1, z: 2});
        manager.loadCoordinate(coordinate);
        const tile = Object.values(manager.tiles)[0];
        const meshData = {};
        Object.assign(tile, {mesh_data: meshData});
        manager.buildTileError({...Tile.slice(tile), error: new Error('fixture'), mesh_data: meshData});
        expect(abort).toHaveBeenLastCalledWith(expect.objectContaining({mesh_data: undefined}));
        expect(manager.hasTile(tile.key)).toBe(false);
        manager.loadCoordinate(coordinate);
        const replacement = Object.values(manager.tiles)[0];
        manager.buildTileStylesCompleted({tile: Tile.slice(tile), progress: {done: true}});
        expect(manager.hasTile(replacement.key)).toBe(true);
        expect(manager.getResourceStatistics().activeBuilds).toBe(1);
        manager.buildTileError({...Tile.slice(tile), error: new Error('late')});
        expect(manager.getResourceStatistics().activeBuilds).toBe(1);
    } finally { manager.destroy(); }
});
