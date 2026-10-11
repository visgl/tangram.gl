// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {buildGlobeTerrainMesh, getGlobeTerrainExaggeration} from '../src/map-logic/globe-terrain';
import type {TerrainHeightGrid} from '../src/map-logic/terrain-data';
import {TerrainMeshSurface} from '../src/selection/terrain_surface';
import {lngLatToWorld} from '@math.gl/web-mercator';

/** Small deterministic DEM with north-positive meter bounds and physical source heights. */
function grid(height = 1000, bounds: [number, number, number, number] = [-100000, -100000, 100000, 100000]): TerrainHeightGrid {
    return {width: 2, height: 2, heights: new Float32Array(4).fill(height), valid: new Uint8Array(4).fill(1), bounds, verticalDatum: 'unknown', registration: 'grid-node'};
}

test('display exaggeration preserves source heights and follows exact packed geographic vertices', () => {
    const source = grid(), original = source.heights.slice();
    const mesh = buildGlobeTerrainMesh(source, {resolution: 4, exaggeration: 100});
    expect(mesh.positions.length).toBe(75); expect(mesh.indices.length).toBe(96);
    expect(source.heights).toEqual(original); expect(mesh.physicalHeights.every(height => height === 1000)).toBe(true);
    for (let vertex = 0; vertex < 25; vertex++) expect(Math.hypot(...mesh.positions.slice(vertex * 3, vertex * 3 + 3))).toBeCloseTo(256 * (1 + 100000 / 6370972), 10);
    expect(mesh.geographicPositions.filter((_, index) => index % 3 === 2).every(height => height === 100000)).toBe(true);
    expect(mesh.colors.every(value => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true);
    for (let triangle = 0; triangle < mesh.indices.length; triangle += 3) {
        const vertices = [...mesh.indices.slice(triangle, triangle + 3)].map(vertex => [...mesh.positions.slice(vertex * 3, vertex * 3 + 3)]);
        const ab = vertices[1].map((value, axis) => value - vertices[0][axis]), ac = vertices[2].map((value, axis) => value - vertices[0][axis]);
        const normal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
        expect(normal.reduce((value, component, axis) => value + component * vertices[0][axis], 0)).toBeGreaterThan(0);
    }
});

test('screen-relative fade is bounded, smooth, monotonic and physical after two diameter doublings', () => {
    expect(getGlobeTerrainExaggeration(0)).toBe(100); expect(getGlobeTerrainExaggeration(1)).toBe(100);
    expect(getGlobeTerrainExaggeration(2)).toBeCloseTo(10); expect(getGlobeTerrainExaggeration(4)).toBe(1); expect(getGlobeTerrainExaggeration(100)).toBe(1);
    let previous = Infinity;
    for (let ratio = 0; ratio <= 5; ratio += 0.1) {const value = getGlobeTerrainExaggeration(ratio, 50); expect(value).toBeLessThanOrEqual(previous); expect(value).toBeGreaterThanOrEqual(1); previous = value;}
    expect(getGlobeTerrainExaggeration(2, 1)).toBe(1);
});

test.each([-1, NaN, Infinity])('invalid screen ratio %s rejects', value => {
    expect(() => getGlobeTerrainExaggeration(value)).toThrow('Invalid');
});
test.each([0, NaN, Infinity, 1001])('invalid maximum %s rejects', value => {
    expect(() => getGlobeTerrainExaggeration(1, value)).toThrow('Invalid');
});
test.each([1, 257, 4.5, NaN])('invalid resolution %s rejects before allocating', resolution => {
    expect(() => buildGlobeTerrainMesh(grid(), {resolution})).toThrow('resolution');
});

test('no-data cells are holes, while snow/ocean and pixel-center boundaries remain finite', () => {
    const missing = grid(); missing.valid.fill(0);
    const mesh = buildGlobeTerrainMesh(missing, {resolution: 2});
    expect(mesh.indices.length).toBe(0); expect(mesh.physicalHeights.every(Number.isNaN)).toBe(true);
    expect(mesh.positions.every(Number.isFinite)).toBe(true);
    expect(buildGlobeTerrainMesh({...grid(3000), registration: 'pixel-center'}, {resolution: 2}).colors.every(Number.isFinite)).toBe(true);
    expect(buildGlobeTerrainMesh(grid(-100), {resolution: 2}).indices.length).toBe(24);
    expect(buildGlobeTerrainMesh(grid()).positions.length).toBe(65 * 65 * 3);
});

test('shared edges and antimeridian copies have identical physical and displayed heights', () => {
    const west = grid(1000, [-200000, -100000, 0, 100000]), east = grid(3000, [0, -100000, 200000, 100000]);
    const first = buildGlobeTerrainMesh(west, {resolution: 2, neighbors: [east]}), second = buildGlobeTerrainMesh(east, {resolution: 2, neighbors: [west]});
    for (let row = 0; row < 3; row++) {expect(first.physicalHeights[row * 3 + 2]).toBe(2000); expect([...first.positions.slice((row * 3 + 2) * 3, (row * 3 + 3) * 3)]).toEqual([...second.positions.slice(row * 9, row * 9 + 3)]);}
    const edge = Math.PI * 6378137;
    const left = grid(1000, [-edge, -100000, -edge + 200000, 100000]), right = grid(3000, [edge - 200000, -100000, edge, 100000]);
    const leftMesh = buildGlobeTerrainMesh(left, {resolution: 2, neighbors: [right]}), rightMesh = buildGlobeTerrainMesh(right, {resolution: 2, neighbors: [left]});
    expect(leftMesh.physicalHeights[3]).toBe(2000); expect(rightMesh.physicalHeights[5]).toBe(2000);
    for (let axis = 0; axis < 3; axis++) expect(leftMesh.positions[9 + axis]).toBeCloseTo(rightMesh.positions[15 + axis], 10);
    const world = lngLatToWorld([0, 0]); expect(world).toEqual([256, 256]);
});

test('malformed grids, incompatible datums and unrenderable elevations reject', () => {
    for (const source of [{...grid(), width: 1}, {...grid(), height: NaN}, {...grid(), heights: new Float32Array(1)}, {...grid(), valid: new Uint8Array(1)}, {...grid(), bounds: [0, 0, 0, 1] as const}, {...grid(), bounds: [0, 0, NaN, 1] as const}, {...grid(), bounds: [-1e9, 0, 1e9, 1] as const}]) expect(() => buildGlobeTerrainMesh(source)).toThrow('Invalid');
    expect(() => buildGlobeTerrainMesh(grid(), {neighbors: [{...grid(), verticalDatum: 'orthometric'}]})).toThrow('datum');
    expect(() => buildGlobeTerrainMesh(grid(-6370972))).toThrow('elevation');
    expect(() => buildGlobeTerrainMesh(grid(Infinity))).toThrow('elevation');
    expect(() => buildGlobeTerrainMesh(grid(3e38), {exaggeration: 100})).toThrow('packed display');
    const edge = Math.PI * 6378137;
    expect(() => buildGlobeTerrainMesh(grid(0, [-edge, -edge, edge, edge]), {resolution: 2})).toThrow('180 degrees');
});

test('picking uses displaced triangles but returns detached barycentric physical meters, not chord altitude', () => {
    const mesh = buildGlobeTerrainMesh(grid(), {resolution: 4, exaggeration: 100});
    const surface = new TerrainMeshSurface({projection: 'globe', positions: mesh.positions, indices: mesh.indices, physicalHeights: mesh.physicalHeights});
    mesh.physicalHeights.fill(9999);
    const hit = surface.intersectRay({origin: [0, -400, 0], direction: [0, 1, 0]});
    expect(hit?.coordinate[2]).toBeCloseTo(1000); expect(hit?.position[1]).toBeCloseTo(-256 * (1 + 100000 / 6370972));
    expect(surface.intersectRay({origin: [400, -400, 0], direction: [0, 1, 0]})).toBeNull();
    expect(() => new TerrainMeshSurface({projection: 'globe', positions: mesh.positions, indices: mesh.indices, physicalHeights: []})).toThrow('physical heights');
    expect(() => new TerrainMeshSurface({projection: 'globe', positions: mesh.positions, indices: mesh.indices, physicalHeights: new Float32Array(mesh.physicalHeights.length).fill(NaN)})).toThrow('physical heights');
    const physical = new Float32Array([10, 20, 30]);
    const variable = new TerrainMeshSurface({projection: 'globe', positions: [-1, -257, -1, 1, -257, -1, 0, -257, 1], indices: [0, 1, 2], physicalHeights: physical});
    physical.fill(0);
    expect(variable.intersectRay({origin: [0, -300, 0], direction: [0, 1, 0]})?.coordinate[2]).toBeCloseTo(22.5);
    const front = new TerrainMeshSurface({projection: 'globe', positions: [-1, -257, -1, 1, -257, -1, 0, -257, 1], indices: [0, 1, 2], cullBackfaces: true});
    expect(front.intersectRay({origin: [0, -300, 0], direction: [0, 1, 0]})).not.toBeNull();
    expect(front.intersectRay({origin: [0, 300, 0], direction: [0, -1, 0]})).toBeNull();
});
