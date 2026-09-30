// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, expect, test, vi} from 'vitest';
import Renderer from '../src/scene/renderer';
import HostFrame from '../src/scene/host_frame';
import TileManager from '../src/tile/tile_manager';
import {TileID} from '../src/tile/tile_id';
import {NetworkTileSource} from '../src/sources/data_source';
import {Matrix4} from '@math.gl/core';
import Geo from '../src/utils/geo';

afterEach(() => vi.restoreAllMocks());

test.each([256, 512])('%i-pixel sources hide cached ancestors on data-only LOD transitions', tileSize => {
    const renderer = new Renderer({});
    const view = renderer.scene.view;
    const source = new NetworkTileSource({id: 1, name: 'fixture', url: 'data:application/json,{}', max_zoom: 4, tile_size: tileSize});
    source.builds_geometry_tiles = true;
    const manager = new TileManager({scene: {id: 'host-lod-transition-test', view, sources: {fixture: source}, workers: [{}]}});
    const build = vi.spyOn(manager, 'buildTile').mockImplementation(tile => {
        vi.spyOn(tile, 'workerMessage').mockResolvedValue(undefined);
    });
    const visibility = vi.spyOn(view, 'findVisibleTileCoordinates');
    vi.spyOn(manager, 'updateTileStates').mockImplementation(() => {});
    try {
        for (const tileZoom of [2, 3, undefined, 3]) {
            renderer.setFrame(new HostFrame({viewport: {width: 800, height: 600},
                geographicAnchor: {longitude: 0, latitude: 0, zoom: 4.5}, tileZoom,
                renderViews: [{camera: {view: new Matrix4(), projection: new Matrix4(), position: [0, 0, 0]}}]}));
            const dataZoom = tileZoom ?? 4;
            const coordinate = TileID.coord({x: 2 ** (dataZoom - 1), y: 2 ** (dataZoom - 1), z: dataZoom});
            manager.loadCoordinate(coordinate);
            const expectedCoordinate = TileID.normalizedCoord(coordinate, source);
            visibility.mockReturnValue([coordinate]);
            manager.updateTilesForView();
            for (const [cached] of build.mock.calls) {
                manager.updateVisibility(cached);
                expect(cached.visible).toBe(cached.coords.key === expectedCoordinate.key);
                expect(cached.style_z).toBe(4);
            }
        }
        expect(build).toHaveBeenCalledTimes(3);
    } finally {
        manager.destroy();
    }
});

test('data LOD preserves worker style zoom, source limits, display filters and cache keys', () => {
    const renderer = new Renderer({});
    const view = renderer.scene.view;
    const source = new NetworkTileSource({id: 1, name: 'fixture', url: 'data:application/json,{}',
        max_zoom: 2, min_display_zoom: 0, max_display_zoom: 4});
    source.builds_geometry_tiles = true;
    const manager = new TileManager({scene: {id: 'host-lod-test', view, sources: {fixture: source}, workers: [{}]}});
    const build = vi.spyOn(manager, 'buildTile').mockImplementation(() => {});
    try {
        renderer.setFrame(new HostFrame({viewport: {width: 800, height: 600},
            geographicAnchor: {longitude: 0, latitude: 0, zoom: 4.5}, tileZoom: 3,
            renderViews: [{camera: {view: new Matrix4(), projection: new Matrix4(), position: [0, 0, 0]}}]}));
        const coordinate = TileID.coord({x: 4, y: 4, z: 3});
        manager.loadCoordinate(coordinate);
        expect(build).toHaveBeenCalledTimes(1);
        const tile = build.mock.calls[0][0];
        vi.spyOn(tile, 'workerMessage').mockResolvedValue(undefined);
        expect(tile.coords).toMatchObject({x: 2, y: 2, z: 2});
        expect(tile.style_z).toBe(4);
        expect(tile.key).toBe('fixture/2/2/2/4');
        expect(tile.overzoom).toBe(2);
        expect(tile.units_per_pixel).toBe(0.25 * Geo.units_per_pixel);
        expect(tile.workerMessage).toBeTypeOf('function');
        expect(tile.buildAsMessage()).toMatchObject({style_z: 4, overzoom: 2});
        const visibility = vi.spyOn(view, 'findVisibleTileCoordinates').mockReturnValue([coordinate]);
        vi.spyOn(manager, 'updateTileStates').mockImplementation(() => {});
        manager.updateTilesForView();
        manager.updateVisibility(tile);
        expect(tile.visible).toBe(true);
        manager.loadCoordinate(coordinate);
        expect(build).toHaveBeenCalledTimes(1);
        visibility.mockReturnValue([]);
        manager.updateTilesForView();
        manager.updateVisibility(tile);
        expect(tile.visible).toBe(false);
        manager.loadCoordinate(TileID.coord({x: 8, y: 8, z: 4}));
        expect(build).toHaveBeenCalledTimes(1);
        source.max_display_zoom = 3;
        manager.loadCoordinate(TileID.coord({x: 0, y: 0, z: 3}));
        expect(build).toHaveBeenCalledTimes(1);
        source.max_display_zoom = 4;
        source.min_display_zoom = 4;
        manager.loadCoordinate(TileID.coord({x: 0, y: 0, z: 3}));
        expect(build).toHaveBeenCalledTimes(1);
    } finally {
        manager.destroy();
    }
});
