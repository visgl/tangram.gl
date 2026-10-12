// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {FirstPersonViewport} from '@deck.gl/core';
import {getTerrainEyeCoordinate, constrainTerrainEye} from '../examples/terrain/first-person';
import {selectTerrainTiles, getTerrainTileKey} from '../examples/terrain/tile-selection';
import {buildTerrainRenderMesh} from '../examples/terrain/terrain-mesh';
import {createTerrainStreamFixture} from './terrain-stream-fixture';
import {projectGeographicPosition} from '@vis.gl/tangram-renderer/core';

test.each([-70, 0, 70])('eye offsets at latitude %s resolve through the actual deck camera', latitude => {
    const state = {longitude: 179.999, latitude, position: [5000, 2000, 450] as [number, number, number], bearing: 35, pitch: 20};
    const viewport = new FirstPersonViewport({...state, width: 512, height: 320});
    const expected = viewport.unprojectPosition(viewport.cameraPosition);
    const coordinate = getTerrainEyeCoordinate(state);
    expect(coordinate[0]).toBeCloseTo(((expected[0] + 180) % 360 + 360) % 360 - 180, 10);
    expect(coordinate[1]).toBeCloseTo(expected[1], 10);
    expect(coordinate[2]).toBeCloseTo(450, 8);
    expect(coordinate[0]).not.toBe(state.longitude);
    const tiles = selectTerrainTiles({longitude: coordinate[0], latitude: coordinate[1], zoom: 12}, 9, 12);
    expect(tiles).toHaveLength(9); expect(new Set(tiles.map(getTerrainTileKey)).size).toBe(9);
    expect(tiles.every(tile => tile.column >= 0 && tile.column < 4096 && tile.row >= 0 && tile.row < 4096)).toBe(true);
    expect(selectTerrainTiles({longitude: coordinate[0] + 360, latitude: coordinate[1], zoom: 12}, 9, 12)).toEqual(tiles);
});

test('point-eye clearance samples the moved eye, preserves XY and holds missing-data heights', () => {
    const state = {longitude: 0, latitude: 0, position: [1000, 2000, 50] as [number, number, number]};
    const coordinate = getTerrainEyeCoordinate(state);
    const projected = projectGeographicPosition(coordinate, 'web-mercator');
    const loaded = buildTerrainRenderMesh(createTerrainStreamFixture([projected[0] - 500, projected[1] - 500, projected[0] + 500, projected[1] + 500], [100, 100, 100, 100]), [], 250).loaded;
    const raised = constrainTerrainEye(state, [loaded], 20, 50);
    expect(raised.available).toBe(true); expect(raised.state.position).toEqual([1000, 2000, 120]);
    expect(state.position).toEqual([1000, 2000, 50]);
    expect(constrainTerrainEye({...state, position: [1000, 2000, 200]}, [loaded], 20, 50).state.position).toEqual([1000, 2000, 200]);
    const missing = constrainTerrainEye({...state, position: [10000, 2000, 25]}, [loaded], 20, 120);
    expect(missing.available).toBe(false); expect(missing.state.position).toEqual([10000, 2000, 120]);
    expect(constrainTerrainEye(state, [], 20, 80).state.position[2]).toBe(80);
    expect(() => constrainTerrainEye(state, [], 20, NaN)).toThrow();
    expect(() => constrainTerrainEye(state, [], -1, 50)).toThrow();
    for (const invalid of [{...state, longitude: Infinity}, {...state, latitude: 86}, {...state, position: [0, 0, NaN] as [number, number, number]}, {...state, modelMatrix: Array(16).fill(0)}]) expect(() => getTerrainEyeCoordinate(invalid)).toThrow();
});

test('local selection is bounded at the poles and changes with eye movement without a horizon rectangle', () => {
    for (const latitude of [-85.0511287798066, 85.0511287798066]) {
        const tiles = selectTerrainTiles({longitude: 0, latitude, zoom: 12}, 25, 12);
        expect(tiles).toHaveLength(25); expect(tiles.every(tile => tile.row >= 0 && tile.row < 4096)).toBe(true);
    }
    const start = selectTerrainTiles({longitude: 0, latitude: 0, zoom: 11}, 1, 11);
    expect(selectTerrainTiles({longitude: 1, latitude: 0, zoom: 11}, 1, 11)).not.toEqual(start);
    expect(selectTerrainTiles({longitude: 0, latitude: 0, zoom: 0}, 25, 0)).toEqual([{zoom: 0, column: 0, row: 0}]);
});
