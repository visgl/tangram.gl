// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {buildGlobeTerrainMesh, prepareGlobeTerrainMesh, scaleGlobeTerrainMesh, getGlobeTerrainExaggeration} from '../src/map-logic/globe-terrain';
import {createHash} from 'node:crypto';
import type {TerrainHeightGrid} from '../src/map-logic/terrain-data';
import {TerrainMeshSurface} from '../src/selection/terrain_surface';
import {lngLatToWorld} from '@math.gl/geospatial';

/** Small deterministic DEM with north-positive meter bounds and physical source heights. */
function grid(height = 1000, bounds: [number, number, number, number] = [-100000, -100000, 100000, 100000]): TerrainHeightGrid {
    return {width: 2, height: 2, heights: new Float32Array(4).fill(height), valid: new Uint8Array(4).fill(1), bounds, verticalDatum: 'unknown', registration: 'grid-node'};
}

test('prepared scaling reproduces pre-refactor packed geometry, topology and lighting byte-for-byte', () => {
    const edge = Math.PI * 6378137, width = 128;
    const grids: TerrainHeightGrid[] = Array.from({length: 16}, (_, index) => {
        const column = index % 4, row = Math.floor(index / 4);
        return {width, height: width, heights: Float32Array.from({length: width * width}, (_, pixel) => Math.sin(pixel % width / 11) * 1600 + Math.cos(Math.floor(pixel / width) / 13) * 700),
            valid: new Uint8Array(width * width).fill(1), bounds: [-edge + column * edge / 2, edge - (row + 1) * edge / 2, -edge + (column + 1) * edge / 2, edge - row * edge / 2], registration: 'pixel-center', verticalDatum: 'unknown'};
    });
    const template = prepareGlobeTerrainMesh(grids[0], {resolution: 4, neighbors: grids.slice(1)});
    const expected = [
        '934b80ce54a613b5a9388ffa48dc4a5e800c34aeb57ab55455f5c70188ca279a',
        '7bb9848a90ec22968eda853a87e30d6d7f71edbf304f05b3fc98eaae86726804',
        '0a57c153389922466cc1df147c1d252c5442cc1251b040d0027bd1471da50881',
        '194618227aacdf22f6d9fb499111bbf811d530955e04023e0f3a6c7694be34c5',
        '6b12102465f4b684bd71fdc5229bd19588c89151e18f1bd69d4117376a12aee5'
    ];
    for (const [index, exaggeration] of [0, 0.5, 1, 7.3, 100].entries()) {
        const mesh = scaleGlobeTerrainMesh(template, exaggeration), hash = createHash('sha256');
        // Float32 query-position hashing avoids platform-libm differences below GPU precision.
        for (const values of [mesh.geographicPositions, Float32Array.from(mesh.positions), mesh.physicalHeights, mesh.indices, mesh.colors]) hash.update(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
        expect(hash.digest('hex')).toBe(expected[index]);
        expect(template.vertexCount).toBe(mesh.physicalHeights.length); expect(template.triangleCount).toBe(mesh.indices.length / 3);
    }
});

test('templates detach sampling from mutable source data, retain topology and reject forged handles', () => {
    const source = grid(), template = prepareGlobeTerrainMesh(source, {resolution: 4});
    const first = scaleGlobeTerrainMesh(template, 100);
    source.heights.fill(7000); source.valid.fill(0);
    const second = scaleGlobeTerrainMesh(template, 1);
    expect(second.physicalHeights.every(height => height === 1000)).toBe(true);
    expect(second.indices).toEqual(first.indices); expect(second.physicalHeights).toEqual(first.physicalHeights);
    expect(second.indices).not.toBe(first.indices); expect(second.physicalHeights).not.toBe(first.physicalHeights);
    expect(second.positions).not.toBe(first.positions); expect(second.colors).not.toBe(first.colors);
    expect(second.geographicPositions.filter((_, index) => index % 3 === 2).every(height => height === 1000)).toBe(true);
    expect(Object.isFrozen(template)).toBe(true);
    first.indices.fill(0); first.physicalHeights.fill(123);
    expect(scaleGlobeTerrainMesh(template, 1).indices).toEqual(second.indices);
    expect(scaleGlobeTerrainMesh(template, 1).physicalHeights).toEqual(second.physicalHeights);
    expect(() => scaleGlobeTerrainMesh({vertexCount: 0, triangleCount: 0, byteLength: 0})).toThrow('prepareGlobeTerrainMesh');
    expect(() => scaleGlobeTerrainMesh(template, Infinity)).toThrow('Invalid');
    const negative = prepareGlobeTerrainMesh(grid(-7000000), {resolution: 2});
    expect(scaleGlobeTerrainMesh(negative, 0).indices.length).toBe(24);
    expect(() => scaleGlobeTerrainMesh(negative, 1)).toThrow('Invalid globe terrain elevation');
    const overflowing = prepareGlobeTerrainMesh(grid(3e38), {resolution: 2});
    expect(() => scaleGlobeTerrainMesh(overflowing, 100)).toThrow('packed display range');
});

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

test('screen-relative fade is bounded, smooth, monotonic and flat after one diameter doubling', () => {
    expect(getGlobeTerrainExaggeration(0)).toBe(100); expect(getGlobeTerrainExaggeration(1)).toBe(100);
    expect(getGlobeTerrainExaggeration(Math.sqrt(2))).toBeCloseTo(Math.sqrt(101) - 1);
    expect(getGlobeTerrainExaggeration(2)).toBe(0); expect(getGlobeTerrainExaggeration(4)).toBe(0); expect(getGlobeTerrainExaggeration(100)).toBe(0);
    let previous = Infinity;
    for (let ratio = 0; ratio <= 5; ratio += 0.1) {const value = getGlobeTerrainExaggeration(ratio, 50); expect(value).toBeLessThanOrEqual(previous); expect(value).toBeGreaterThanOrEqual(0); previous = value;}
    expect(getGlobeTerrainExaggeration(2, 1)).toBe(1);
});

test.each([-1, NaN, Infinity])('invalid screen ratio %s rejects', value => {
    expect(() => getGlobeTerrainExaggeration(value)).toThrow('Invalid');
});
test.each([-1, NaN, Infinity, 1001])('invalid maximum %s rejects', value => {
    expect(() => getGlobeTerrainExaggeration(1, value)).toThrow('Invalid');
});

test.each([0, 0.5, 1])('flat and subphysical multiplier %s stays fixed at every camera scale', maximum => {
    for (const ratio of [0, 1, 2, 4, 100]) expect(getGlobeTerrainExaggeration(ratio, maximum)).toBe(maximum);
    const source = grid();
    const mesh = buildGlobeTerrainMesh(source, {resolution: 4, exaggeration: maximum});
    expect(mesh.geographicPositions.filter((_, index) => index % 3 === 2).every(height => height === 1000 * maximum)).toBe(true);
    expect(mesh.physicalHeights.every(height => height === 1000)).toBe(true);
    expect(mesh.positions.every(Number.isFinite)).toBe(true);
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

test.each(['grid-node', 'pixel-center'] as const)('downsampling %s preserves an isolated missing pixel between display vertices', registration => {
    const size = registration === 'grid-node' ? 513 : 512;
    const source: TerrainHeightGrid = {...grid(), width: size, height: size, heights: new Float32Array(size * size).fill(1000), valid: new Uint8Array(size * size).fill(1), registration};
    source.valid[5 * size + 5] = 0; source.heights[5 * size + 5] = NaN;
    const mesh = buildGlobeTerrainMesh(source, {exaggeration: 100});
    expect(mesh.physicalHeights.every(Number.isFinite)).toBe(true); // None of the display vertices touches the missing pixel.
    expect(mesh.indices.length).toBe((64 * 64 - 1) * 6);
    const point = [0, 1, 65, 66].map(vertex => [...mesh.positions.slice(vertex * 3, vertex * 3 + 3)]);
    const average = (axis: number): number => point.reduce((sum, vertex) => sum + vertex[axis] / 4, 0);
    const center: [number, number, number] = [average(0), average(1), average(2)];
    const surface = new TerrainMeshSurface({projection: 'globe', positions: mesh.positions, indices: mesh.indices, physicalHeights: mesh.physicalHeights, cullBackfaces: true});
    expect(surface.intersectRay({origin: [center[0] * 2, center[1] * 2, center[2] * 2], direction: [-center[0], -center[1], -center[2]]})).toBeNull();
});

test('missing neighbor pixels between edge vertices also leave a hole in the touching cell', () => {
    const neighbor: TerrainHeightGrid = {...grid(1000, [100000, -100000, 300000, 100000]), width: 512, height: 512, heights: new Float32Array(512 * 512).fill(1000), valid: new Uint8Array(512 * 512).fill(1), registration: 'pixel-center'};
    neighbor.valid[5 * 512] = 0; neighbor.heights[5 * 512] = NaN;
    expect(buildGlobeTerrainMesh(grid(), {neighbors: [neighbor]}).indices.length).toBe((64 * 64 - 1) * 6);
});

test('packed coordinates that collapse narrow high-longitude tiles reject zero-area triangles', () => {
    const west = Math.PI * 6378137 * 0.99999;
    expect(() => buildGlobeTerrainMesh(grid(1000, [west, 20000000, west + 0.01, 20000000.01]), {resolution: 2})).toThrow('packed coordinate precision');
});

test('coarse and fine globe edges share every packed vertex, physical height and relief color', () => {
    const coarse = grid(1000, [-200000, -100000, 0, 100000]);
    const north = grid(3000, [0, 0, 100000, 100000]), south = grid(2000, [0, -100000, 100000, 0]);
    const grids = [coarse, north, south];
    const meshes = grids.map(source => buildGlobeTerrainMesh(source, {resolution: 4, exaggeration: 100, neighbors: grids.filter(candidate => candidate !== source)}));
    /** Canonical shared-edge attributes, independent of each mesh's regular/fan ordering. */
    const edges = (mesh: ReturnType<typeof buildGlobeTerrainMesh>) => {
        const values = new Map<number, {position: number[]; height: number; color: number[]}>();
        for (let index = 0; index < mesh.physicalHeights.length; index++) if (mesh.geographicPositions[index * 3] === 0) {
            values.set(mesh.geographicPositions[index * 3 + 1], {position: [...mesh.positions.slice(index * 3, index * 3 + 3)], height: mesh.physicalHeights[index], color: [...mesh.colors.slice(index * 3, index * 3 + 3)]});
        }
        return values;
    };
    const boundary = edges(meshes[0]), fine = new Map([...edges(meshes[1]), ...edges(meshes[2])]);
    expect(boundary.size).toBe(9); expect(fine.size).toBe(9);
    for (const [latitude, value] of boundary) expect(fine.get(latitude)).toEqual(value);
    expect(meshes[0].indices.length).toBeGreaterThan(4 * 4 * 6);
    for (const mesh of meshes) expect(mesh.indices.every(index => index < mesh.physicalHeights.length)).toBe(true);
    const surface = new TerrainMeshSurface({projection: 'globe', positions: meshes[0].positions, indices: meshes[0].indices, physicalHeights: meshes[0].physicalHeights});
    const hit = surface.intersectRay({origin: [0, -400, 0], direction: [0, 1, 0]});
    expect(hit?.coordinate[2]).toBeCloseTo((1000 + 3000 + 2000) / 3);
});

test('unsupported mixed-LOD boundaries and overlapping footprints reject rather than crack', () => {
    const source = grid(1000, [-200000, -100000, 0, 100000]);
    expect(() => buildGlobeTerrainMesh(source, {neighbors: [grid(2000, [0, 0, 50000, 50000])]})).toThrow('2:1');
    expect(() => buildGlobeTerrainMesh(source, {neighbors: [grid(2000, [-100000, -100000, 100000, 100000])]})).toThrow('overlap');
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
