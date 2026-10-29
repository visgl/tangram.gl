// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {FirstPersonViewport} from '@deck.gl/core';
import {getTerrainEyeCoordinate, constrainTerrainEye, constrainTerrainMotion} from '../examples/terrain/first-person';
import {selectTerrainTiles, getTerrainTileKey} from '../examples/terrain/tile-selection';
import {buildTerrainRenderMesh} from '../examples/terrain/terrain-mesh';
import {createTerrainStreamFixture} from './terrain-stream-fixture';
import {projectGeographicPosition, TerrainMeshSurface} from '@tangram.gl/tangram-renderer/core';
import type {LoadedTerrain} from '../examples/terrain/load-terrain';

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

test('finite movement stops at an intervening ridge even when both endpoint floors are low', () => {
    const surface = new TerrainMeshSurface({projection: 'web-mercator', positions: [-200, -100, 0, 0, -100, 200, 200, -100, 0, -200, 100, 0, 0, 100, 200, 200, 100, 0], indices: [0, 1, 3, 1, 4, 3, 1, 2, 4, 2, 5, 4]});
    const fixture = createTerrainStreamFixture([-200, -100, 200, 100]);
    const loaded: LoadedTerrain = {...fixture, surface, mesh: {...fixture.mesh, header: {vertexCount: 6, boundingBox: [[-0.002, -0.001, 0], [0.002, 0.001, 200]]}}};
    const previous = {longitude: 0, latitude: 0, position: [-150, 0, 130] as [number, number, number], bearing: 0};
    const proposed = {...previous, position: [150, 0, 130] as [number, number, number], bearing: 30};
    const result = constrainTerrainMotion(previous, proposed, [loaded], 20);
    expect(result.blocked).toBe(true); expect(result.available).toBe(true);
    expect(result.state.position).toEqual(previous.position); expect(result.state.bearing).toBe(30);
    const high = constrainTerrainMotion({...previous, position: [-150, 0, 300]}, {...proposed, position: [150, 0, 300]}, [loaded], 20);
    expect(high.blocked).toBe(false); expect(high.state.position).toEqual([150, 0, 300]);
    const escaped = constrainTerrainMotion({...previous, position: [-150, 0, 0]}, {...previous, position: [-150, 0, 300]}, [loaded], 20);
    expect(escaped.blocked).toBe(false); expect(escaped.state.position[2]).toBe(300);
    const outside = constrainTerrainMotion(previous, {...proposed, position: [1000, 0, 130]}, [loaded], 20);
    expect(outside.blocked).toBe(true); expect(outside.available).toBe(false); expect(outside.state.position).toEqual(previous.position);
    expect(() => constrainTerrainMotion(previous, proposed, [loaded], NaN)).toThrow();
});

test('avatar footprint refuses uncovered intermediate ground and retains look changes', () => {
    const loaded = buildTerrainRenderMesh(createTerrainStreamFixture([-10, -10, 10, 10], [0, 0, 0, 0]), [], 0).loaded;
    const previous = {longitude: 0, latitude: 0, position: [0, 0, 20] as [number, number, number]};
    const proposed = {...previous, bearing: 40, position: [9.9, 0, 20] as [number, number, number]};
    expect(constrainTerrainMotion(previous, proposed, [loaded], 1).blocked).toBe(false);
    const body = constrainTerrainMotion(previous, proposed, [loaded], 1, undefined, {radius: 0.3});
    expect(body).toMatchObject({available: false, blocked: true, state: {bearing: 40, position: [0, 0, 20]}});
    expect(constrainTerrainMotion(previous, {...proposed, position: [5, 0, 20]}, [loaded], 1, undefined, {radius: 0.3}).blocked).toBe(false);
});
