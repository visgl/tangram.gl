// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, expect, expectTypeOf, test, vi} from 'vitest';
import Tile from '../src/tile/tile';
import Collision from '../src/labels/collision';
import type {TileBuildStyle, WorkerBuildTile} from '../src/tile/tile-build-types';

afterEach(() => {vi.restoreAllMocks(); for (const key of Object.keys(Collision.tiles)) Collision.abortTile(key);});

test('decoded null geometry is skipped without changing valid feature identity or authored draw order', () => {
    const feature = {geometry: {type: 'Point'}, properties: {name: 'fixture'}};
    const tile: WorkerBuildTile = {id: 42, key: 'fixture', source: 'fixture', debug: {},
        style_z: 4, meters_per_pixel: 1, meters_per_pixel_sq: 1, units_per_meter_overzoom: 1,
        source_data: {layers: {_default: {features: [{geometry: null, properties: {}}, feature]}}}};
    const groups = [{layers: ['first'], style: 'markers'}, {layers: ['second'], style: 'markers'}];
    const style: TileBuildStyle = {name: 'markers', hasDataForTile: () => true, preprocess: group => group,
        addFeature: vi.fn(), endData: vi.fn(), makeMesh: vi.fn()};
    const buildGroups = vi.spyOn(Tile, 'buildStyleGroups').mockImplementation(() => {});
    Tile.buildGeometry(tile, {scene_id: 7, global: {}, styles: {markers: style}, layers: {
        fixture: {config_data: {source: 'fixture'}, buildDrawGroups: () => ({first: groups[0], second: groups[1]})}
    }});
    expect(style.addFeature).toHaveBeenCalledTimes(2);
    expect(vi.mocked(style.addFeature).mock.calls.map(call => call[0])).toEqual([feature, feature]);
    expect(vi.mocked(style.addFeature).mock.calls[0][0]).toBe(feature);
    expect(vi.mocked(style.addFeature).mock.calls.map(call => call[1])).toEqual(groups);
    expect(tile.debug.feature_count).toBe(1);
    expect(buildGroups).toHaveBeenCalledWith(tile, [style], 7, expect.any(Function));
});

test('source policy, pinned worker, normalized coordinate and wire envelope have checked types', () => {
    const worker = {postMessage: vi.fn(), addEventListener: vi.fn()};
    const tile = new Tile({source: {id: 2, name: 'fixture', zooms: [0, 1, 2], tiled: true},
        coords: {x: 1, y: 1, z: 2}, workers: [worker], style_z: 4, view: {}});
    const envelope = tile.buildAsMessage();
    expectTypeOf(envelope.id).toEqualTypeOf<number>();
    expectTypeOf(envelope.source).toEqualTypeOf<string>();
    expect(tile.worker).toBe(worker);
    expect(tile.overzoom2).toBe(4);
    expect(envelope).toMatchObject({source: 'fixture', coords: {x: 1, y: 1, z: 2}, style_z: 4});
    const extension = {id: 42, key: 'fixture', debug: {}, extension: {value: 1}};
    expect(Tile.slice(extension, ['extension']).extension).toBe(extension.extension);
});
