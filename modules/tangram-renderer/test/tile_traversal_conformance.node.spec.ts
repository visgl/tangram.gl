// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {Tileset2D} from '@loaders.gl/tiles';
import type {Tileset2DAdapter} from '@loaders.gl/tiles';
import TangramTileset2D from '../src/tile/tangram_tileset_2d';
import type {ResourceTile} from '../src/tile/tile_resource_cache';
import TangramTileTraversalAdapter, {getTileGeographicBounds, countProjectedTileCoordinates} from '../src/tile/tile_traversal_adapter';
import type {TangramTraversalState} from '../src/tile/tile_traversal_adapter';
import {WebMercatorVisibilityAdapter, WebMercatorGlobeVisibilityAdapter} from '../src/scene/visibility_adapter';
import {TileID} from '../src/tile/tile_id';
import {createTraversalView as createView, traversalFixtures as fixtures} from './helpers/tile_traversal_fixtures';

const adapter = new TangramTileTraversalAdapter(new WebMercatorVisibilityAdapter(), new WebMercatorGlobeVisibilityAdapter());
/** Compile-time verification against the actual published adapter type. */
const sharedAdapter: Tileset2DAdapter<TangramTraversalState> = adapter;

test.each([
    [-180, -85.0511287798066, 180, 85.0511287798066],
    [-170, 5, -40, 75], [-180, 0, 0, 85.0511287798066], [0, 0, 0, 0],
    [179, -1, 180, 1], [-180, -1, -179, 1]
] as const)('projected candidate counts match real traversal, including tile/world edges: %j', (...bounds) => {
    for (let tileZoom = 0; tileZoom <= 6; tileZoom++) {
        const count = countProjectedTileCoordinates(bounds, tileZoom);
        const selected = adapter.getTileIndices({viewState: {eyes: [{view: createView({tile_zoom: tileZoom,
            buffer: 0}), projection: {type: 'projected', visibleBounds: bounds}}]}});
        expect(count).toBe(selected.length);
        expect(count).toBeLessThanOrEqual(4 ** tileZoom);
    }
});

test('projected tile counts reject invalid footprints and unbounded detail before traversal', () => {
    for (const bounds of [[-181, 0, 0, 1], [0, 0, 181, 1], [1, 0, -1, 1], [0, 2, 1, 1],
        [0, -90, 1, 1], [0, 0, 1, 90], [0, 0, NaN, 1]] as const) {
        expect(() => countProjectedTileCoordinates(bounds, 2)).toThrow('single-world');
    }
    for (const tileZoom of [-1, 1.5, 7, Infinity, NaN]) {
        expect(() => countProjectedTileCoordinates([-180, -80, 180, 80], tileZoom)).toThrow('detail');
    }
    for (const bounds of [null, [], new Array(4)]) {
        expect(() => Reflect.apply(countProjectedTileCoordinates, null, [bounds, 2])).toThrow('single-world');
    }
    expect(countProjectedTileCoordinates([-180, -85.0511287798066, 180, 85.0511287798066], 4)).toBe(256);
});

test.each(fixtures)('Tangram and published loaders.gl select the frozen $name footprint', ({state, keys}) => {
    const tangram = new TangramTileset2D<ResourceTile>();
    const loaders = new Tileset2D<unknown, TangramTraversalState>({adapter: sharedAdapter, getTileData: () => null});
    try {
        const original = JSON.stringify(state);
        const first = tangram.getTileIndices({viewState: state}, adapter);
        const second = loaders.getTileIndices({viewState: state, zRange: null});
        expect(first.map(TileID.coordKey)).toEqual(keys);
        expect(second).toEqual(first);
        expect(JSON.stringify(state)).toBe(original);
        for (const index of second) {
            const bounds = adapter.getTileBoundingBox({viewState: state}, index);
            expect(loaders.getTileMetadata(index)).toEqual({bbox: bounds});
        }
    } finally { loaders.finalize(); tangram.finalize(() => {}); }
});

test('per-eye bounds and projected data zoom do not overwrite style zoom', () => {
    const view = createView({bounds: null, zoom: 12, tile_zoom: 4});
    const state: TangramTraversalState = {eyes: [{view, projection: {type: 'web-mercator'}, calculateBounds: true, dataZoom: 2}]};
    const selected = adapter.getTileIndices({viewState: state});
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.every(index => index.z === 2)).toBe(true);
    expect(view.zoom).toBe(12); expect(view.bounds).toBeNull();
});

test('host collections deduplicate one eye without changing classic custom-adapter ordering', () => {
    const planar = new WebMercatorVisibilityAdapter();
    const coordinate = {x: 1, y: 1, z: 2, key: '1/1/2'};
    planar.findVisibleTileCoordinates = () => [coordinate, coordinate];
    const custom = new TangramTileTraversalAdapter(planar, new WebMercatorGlobeVisibilityAdapter());
    const state: TangramTraversalState = {eyes: [{view: createView(), projection: {type: 'web-mercator'}}]};
    expect(custom.getTileIndices({viewState: state})).toEqual([coordinate, coordinate]);
    expect(custom.getTileIndices({viewState: {...state, union: true}})).toEqual([coordinate]);
});

test('structured bounds preserve XYZ north-down Y and unwrapped world copies', () => {
    const first = getTileGeographicBounds({x: 0, y: 0, z: 1});
    expect(first.west).toBeCloseTo(-180); expect(first.east).toBeCloseTo(0);
    expect(first.north).toBeCloseTo(85.05112878); expect(first.south).toBeCloseTo(0);
    const unwrapped = getTileGeographicBounds({x: -1, y: 0, z: 1});
    expect(unwrapped.west).toBeCloseTo(-360); expect(unwrapped.east).toBeCloseTo(-180);
    expect(unwrapped.south).toBe(first.south);
});

test('sparse source zooms/bias retain separate data and style identities after traversal', () => {
    const source = {id: 1, name: 'world', zooms: [0, 2, 4], zoom_bias: 1};
    const logical = {x: 20, y: 12, z: 6};
    expect(TileID.normalizedCoord(logical, source)).toEqual({x: 5, y: 3, z: 4, key: '5/3/4'});
    expect(TileID.normalizedKey(logical, source, 6)).toBe('world/5/3/4/6');
    expect(TileID.normalizedKey(logical, source, 12)).toBe('world/5/3/4/12');
});

test('invalid planar footprint and globe elevation fail at the same contract boundary', () => {
    expect(() => adapter.getTileIndices({viewState: {eyes: [{view: createView(),
        projection: {type: 'web-mercator', visibleBounds: [0, Number.NaN, 1, 2]}}]}})).toThrow('invalid latitude');
    expect(() => adapter.getTileIndices({viewState: {eyes: [{view: createView(),
        projection: {type: 'globe', visibleBounds: [-10, -10, 10, 10], maxElevation: -1}}]}})).toThrow('non-negative');
});
