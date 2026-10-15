// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {intersectRayTriangle} from '@math.gl/culling/queries';
import VertexLayout from '../src/gl/vertex_layout';
import {conformTerrainStyledMesh} from '../src/procedures/terrain-styled-topology';
import {drapeTerrainMesh, normalizeTerrainDraping, getTerrainVertexLayout, extractDrapedTerrainQueryMesh} from '../src/procedures/terrain-draping';
import type {TerrainHeightGrid} from '../src/map-logic/terrain-data';

const circumference = 2 * Math.PI * 6378137;
const polygonLayout = new VertexLayout([{name: 'a_position', size: 4, type: 5122}, {name: 'a_texcoord', size: 2, type: 5123},
    {name: 'a_color', size: 4, type: 5121}, {name: 'a_selection_color', size: 4, type: 5121}]);
const roadLayout = new VertexLayout([{name: 'a_position', size: 4, type: 5122}, {name: 'a_extrude', size: 2, type: 5122},
    {name: 'a_offset', size: 2, type: 5122}, {name: 'a_z_and_offset_scale', size: 2, type: 5122},
    {name: 'a_texcoord', size: 2, type: 5123}, {name: 'a_color', size: 4, type: 5121}, {name: 'a_selection_color', size: 4, type: 5121}]);

/** Nonplanar quadtree field makes resampling at source/feature cut vertices observably wrong. */
function grid(column = 1, row = 1, zoom = 2, previous = false): TerrainHeightGrid {
    const span = circumference / 2 ** zoom;
    return {bounds: [column * span - circumference / 2, circumference / 2 - (row + 1) * span, (column + 1) * span - circumference / 2, circumference / 2 - row * span],
        width: 3, height: 3, heights: Float32Array.from(previous ? [3, 25, 8, 40, 11, 65, 9, 30, 1] : [10, 60, 20, 5, 130, 30, 40, 15, 80]),
        valid: new Uint8Array(9).fill(1), registration: 'grid-node', verticalDatum: 'orthometric'};
}

/** Authored full tile or wide ribbon; attributes intentionally vary but feature IDs stay flat. */
function input(road = false, zoom = 2, column = 1, row = 1, current = [grid()], previous = [grid(1, 1, 2, true)]) {
    const layout = road ? roadLayout : polygonLayout;
    const vertices = new Uint8Array(layout.stride * 4), view = new DataView(vertices.buffer);
    const points = road ? [[0, -2048], [4096, -2048], [4096, -2048], [0, -2048]] : [[0, 0], [4096, 0], [4096, -4096], [0, -4096]];
    points.forEach(([x, y], index) => {
        const offset = index * layout.stride;
        view.setInt16(offset, x, true); view.setInt16(offset + 2, y, true); view.setInt16(offset + 6, 7, true);
        if (road) {
            view.setInt16(offset + layout.offset.a_extrude + 2, index < 2 ? 768 : -768, true);
            view.setInt16(offset + layout.offset.a_offset, 128, true);
            view.setInt16(offset + layout.offset.a_z_and_offset_scale, 40, true);
        }
        view.setUint16(offset + layout.offset.a_texcoord, index === 1 || index === 2 ? 60000 : 0, true);
        view.setUint16(offset + layout.offset.a_texcoord + 2, index < 2 ? 0 : 60000, true);
        vertices.set([120, 160, 200, 255], offset + layout.offset.a_color);
        vertices.set([1, 2, 3, 255], offset + layout.offset.a_selection_color);
    });
    const span = circumference / 2 ** zoom;
    return {vertices, indices: new Uint16Array([0, 1, 2, 0, 2, 3]), layout, styled: true,
        origin: [column * span - circumference / 2, circumference / 2 - row * span] as const, tileZoom: zoom,
        terrain: normalizeTerrainDraping({grids: current, previousGrids: previous, groundMeshResolution: 4})};
}

/** Interpolate the actual packed physical height on the prepared triangles at a tile-local point. */
function heightAt(result: ReturnType<typeof drapeTerrainMesh>, layout: VertexLayout, point: readonly [number, number], blend = 1, road = false): number | null {
    const output = getTerrainVertexLayout(layout), view = new DataView(result.vertices.buffer);
    const position = (index: number): [number, number, number] => {
        const offset = index * output.stride;
        const current = view.getFloat32(offset + output.offset.a_terrain, true), previous = view.getFloat32(offset + output.offset.a_terrain_previous, true);
        return [view.getFloat32(offset, true) + (road ? view.getFloat32(offset + output.offset.a_terrain + 12, true) : 0),
            view.getFloat32(offset + 4, true) + (road ? view.getFloat32(offset + output.offset.a_terrain_previous + 12, true) : 0), previous + (current - previous) * blend];
    };
    for (let offset = 0; offset < result.indices.length; offset += 3) {
        const hit = intersectRayTriangle([point[0], point[1], 1000], [0, 0, -1], position(result.indices[offset]), position(result.indices[offset + 1]), position(result.indices[offset + 2]));
        if (hit) return 1000 - hit.t;
    }
    return null;
}

test.each([false, true])('canonical %s mesh follows terrain planes instead of independently resampling the DEM', road => {
    const request = input(road), mesh = drapeTerrainMesh(request);
    const groundInput = input(false);
    // Canonical raster channels must be uniform (UVs are model-position derived).
    for (let vertex = 1; vertex < 4; vertex++) groundInput.vertices.set(groundInput.vertices.subarray(8, polygonLayout.stride), vertex * polygonLayout.stride + 8);
    const ground = drapeTerrainMesh({...groundInput, styled: false, ground: true});
    expect(mesh.statistics.canonicalStyledResolution).toBe(4);
    expect(mesh.indices.length).toBeGreaterThan(6);
    for (const blend of [0, 0.25, 0.75, 1]) for (const point of [[1234, -1876], [2048, -2048], [3000, -2400]] as const) {
        expect(heightAt(mesh, request.layout, point, blend, road)).not.toBeNull();
        expect(heightAt(mesh, request.layout, point, blend, road)).toBeCloseTo(heightAt(ground, polygonLayout, point, blend)!, 4);
    }
    const layout = getTerrainVertexLayout(request.layout), view = new DataView(mesh.vertices.buffer);
    for (let vertex = 0; vertex < mesh.vertices.length / layout.stride; vertex++) {
        expect(Array.from(mesh.vertices.subarray(vertex * layout.stride + layout.offset.a_selection_color, vertex * layout.stride + layout.offset.a_selection_color + 4))).toEqual([1, 2, 3, 255]);
        expect(view.getFloat32(vertex * layout.stride + 12, true)).toBe(7);
        expect(view.getUint16(vertex * layout.stride + layout.offset.a_texcoord, true)).toBeLessThanOrEqual(60000);
    }
});

test('mixed source zoom and different source diagonals agree on a nonplanar shared terrain seam', () => {
    const parentInput = input(), childInput = input(false, 4, 5, 5);
    childInput.indices = new Uint16Array([0, 1, 3, 1, 2, 3]);
    const parent = drapeTerrainMesh(parentInput), child = drapeTerrainMesh(childInput);
    for (const blend of [0, 0.4, 1]) for (const local of [[0, -1200], [4096, -2300], [2000, -1700]] as const) {
        const parentPoint: [number, number] = [1024 + local[0] / 4, -1024 + local[1] / 4];
        expect(heightAt(child, polygonLayout, local, blend)).toBeCloseTo(heightAt(parent, polygonLayout, parentPoint, blend)!, 4);
    }
});

test('balanced coarse/fine fields and periodic source worlds preserve polygon and wide-road endpoints', () => {
    const current = [grid(), grid(4, 2, 3), grid(4, 3, 3)];
    for (const road of [false, true]) {
        const ordinary = input(road, 2, 1, 1, current, current), first = drapeTerrainMesh(ordinary);
        for (const world of [-2, -1, 1, 2]) {
            const repeated = drapeTerrainMesh(input(road, 2, 1 + world * 4, 1, current, current));
            expect(repeated.vertices).toEqual(first.vertices); expect(repeated.indices).toEqual(first.indices);
        }
    }
});

test('independent polygon owners meet at the coarse/fine DEM edge throughout the field morph', () => {
    const grids = [grid(), grid(4, 2, 3), grid(4, 3, 3)], previous = grids.map(source => ({...source, heights: Float32Array.from(source.heights, value => value / 3)}));
    const west = drapeTerrainMesh(input(false, 2, 1, 1, grids, previous)), east = drapeTerrainMesh(input(false, 3, 4, 2, grids, previous));
    for (const blend of [0, 0.3, 1]) for (const northing of [-100, -500, -1000, -1600, -2000]) {
        expect(heightAt(west, polygonLayout, [4096, northing], blend)).not.toBeNull();
        expect(heightAt(east, polygonLayout, [0, northing * 2], blend)).toBeCloseTo(heightAt(west, polygonLayout, [4096, northing], blend)!, 4);
    }
});

test('no-data canonical cells suppress both styled ground and road corners without filling holes', () => {
    const missing = grid(); missing.valid[4] = 0;
    for (const road of [false, true]) {
        const request = input(road, 2, 1, 1, [missing]);
        const result = drapeTerrainMesh(request);
        expect(heightAt(result, request.layout, [2048, -2048], 1, road)).toBeNull();
        expect(result.statistics.suppressedTriangles).toBeGreaterThan(0);
        expect(drapeTerrainMesh({...request, terrain: normalizeTerrainDraping({grids: [], groundMeshResolution: 4})}).indices.length).toBe(0);
    }
});

test('wide-road width, offset, material coordinates and selection identity remain dynamic channels', () => {
    const request = input(true);
    const result = drapeTerrainMesh(request), layout = getTerrainVertexLayout(roadLayout), view = new DataView(result.vertices.buffer);
    expect(Array.from({length: result.vertices.length / layout.stride}, (_, index) => view.getFloat32(index * layout.stride + layout.offset.a_extrude + 4, true)).some(value => Math.abs(value) > 0 && Math.abs(value) < 768)).toBe(true);
    for (let vertex = 0; vertex < result.vertices.length / layout.stride; vertex++) {
        expect(view.getFloat32(vertex * layout.stride + layout.offset.a_offset, true)).toBe(128);
        expect(view.getInt16(vertex * layout.stride + layout.offset.a_z_and_offset_scale, true)).toBe(40);
    }
    const invalid = input(true);
    new DataView(invalid.vertices.buffer).setInt16(roadLayout.stride + 4, 256, true);
    expect(() => drapeTerrainMesh(invalid)).toThrow(/uniform per-face/);
});

test.each([false, true])('canonical %s clipping preserves authored coverage area without skirts or overlapping faces', road => {
    const grids = [0, 1, 2].flatMap(column => [0, 1, 2].map(row => grid(column, row)));
    const request = input(road, 2, 1, 1, grids, grids), result = drapeTerrainMesh(request), layout = getTerrainVertexLayout(request.layout);
    const view = new DataView(result.vertices.buffer);
    const point = (index: number) => [view.getFloat32(index * layout.stride, true) + (road ? view.getFloat32(index * layout.stride + layout.offset.a_terrain + 12, true) : 0),
        view.getFloat32(index * layout.stride + 4, true) + (road ? view.getFloat32(index * layout.stride + layout.offset.a_terrain_previous + 12, true) : 0)];
    let area = 0;
    for (let offset = 0; offset < result.indices.length; offset += 3) {
        const [first, second, third] = Array.from(result.indices.subarray(offset, offset + 3), point);
        const signed = ((second[0] - first[0]) * (third[1] - first[1]) - (second[1] - first[1]) * (third[0] - first[0])) / 2;
        expect(signed).toBeLessThan(0); area -= signed;
    }
    expect(area).toBeCloseTo(road ? 4096 * 1536 : 4096 ** 2, 0);
});

test('UV interpolation retains the authored gradient through terrain and source-diagonal cuts', () => {
    const request = input(), result = drapeTerrainMesh(request), layout = getTerrainVertexLayout(polygonLayout), view = new DataView(result.vertices.buffer);
    for (let vertex = 0; vertex < result.statistics.vertices; vertex++) {
        const offset = vertex * layout.stride;
        expect(Math.abs(view.getUint16(offset + layout.offset.a_texcoord, true) - view.getFloat32(offset, true) / 4096 * 60000)).toBeLessThanOrEqual(2);
        expect(Math.abs(view.getUint16(offset + layout.offset.a_texcoord + 2, true) + view.getFloat32(offset + 4, true) / 4096 * 60000)).toBeLessThanOrEqual(2);
    }
});

test('styled source/DEM precision admission also rejects excessive repeated-world disparities', () => {
    const request = input(false, 20, 2 ** 18 + 2 ** 21, 2 ** 18);
    expect(() => drapeTerrainMesh(request)).toThrow(/LOD gap/);
});

test('feature boundaries never weld flat IDs, and invalid varying-flat channels fail explicitly', () => {
    const request = input();
    const combined = new Uint8Array(request.vertices.length * 2); combined.set(request.vertices); combined.set(request.vertices, request.vertices.length);
    for (let vertex = 4; vertex < 8; vertex++) combined[vertex * polygonLayout.stride + polygonLayout.offset.a_selection_color] = 9;
    const result = drapeTerrainMesh({...request, vertices: combined, indices: new Uint16Array([0, 1, 2, 4, 6, 7])});
    const layout = getTerrainVertexLayout(polygonLayout);
    expect(new Set(Array.from(result.indices, index => result.vertices[index * layout.stride + layout.offset.a_selection_color]))).toEqual(new Set([1, 9]));
    request.vertices[polygonLayout.stride + polygonLayout.offset.a_selection_color] = 4;
    expect(() => drapeTerrainMesh(request)).toThrow(/varying flat/);
});

test.each([0, 1, 10])('completed styled topology refuses vertex budget %s rather than returning partial geometry', budget => {
    const request = input();
    expect(() => drapeTerrainMesh({...request, terrain: {...request.terrain, maxAdditionalVertices: budget}})).toThrow(/budget/);
});

test('canonical masks and geometry remain opt-in, with annotations retaining original vertex ranges', () => {
    const request = input();
    const legacy = drapeTerrainMesh({...request, terrain: {...request.terrain, groundMeshResolution: 0}});
    expect(legacy.statistics.canonicalStyledResolution).toBeUndefined();
    const annotations = drapeTerrainMesh({...request, annotations: true});
    expect(annotations.statistics.canonicalStyledResolution).toBeUndefined();
    expect(annotations.statistics.vertices).toBe(4);
    expect(() => drapeTerrainMesh({...request, ground: true})).toThrow(/both ground and styled/);
});

const floatingLayout = new VertexLayout([{name: 'a_position', size: 4, type: 5126}, {name: 'a_selection_color', size: 4, type: 5121}]);
/** Direct tiny topology for vertical walls, reversed winding and disjoint terrain-cell tests. */
function clip(points: readonly (readonly number[])[], indices = new Uint16Array([0, 1, 2]), surfaceIndices = new Uint32Array([0, 1, 2, 1, 3, 2]), maxVertices = 100) {
    const vertices = new Uint8Array(points.length * floatingLayout.stride), view = new DataView(vertices.buffer);
    points.forEach((point, index) => point.forEach((value, axis) => view.setFloat32(index * floatingLayout.stride + axis * 4, value, true)));
    return conformTerrainStyledMesh({vertices, indices, layout: floatingLayout, surfacePositions: new Float64Array([0, 0, 4, 0, 0, 4, 4, 4]), surfaceIndices,
        getPosition: record => [record.getFloat32(0, true), record.getFloat32(4, true)], getElevation: record => record.getFloat32(8, true), maxVertices});
}

test('vertical walls crossing terrain cells survive; a wall exactly on their diagonal is emitted only once', () => {
    const wall = clip([[0, 0, 0, 1], [4, 4, 0, 1], [4, 4, 10, 1]]);
    expect(wall.indices.length).toBeGreaterThan(3);
    const diagonal = clip([[0, 4, 0, 1], [4, 0, 0, 1], [4, 0, 10, 1]]);
    expect(diagonal.indices).toHaveLength(3);
    const boundary = clip([[0, 0, 0, 1], [4, 0, 0, 1], [4, 0, 10, 1]]);
    expect(boundary.indices).toHaveLength(3);
});

test('clipping keeps winding, rejects empty/point-only contacts and uses a bounded output admission', () => {
    for (const reverse of [false, true]) {
        const mesh = clip([[-1, 1, 0, 1], [5, 1, 0, 1], [2, 5, 0, 1]], new Uint16Array(reverse ? [0, 2, 1] : [0, 1, 2]));
        const view = new DataView(mesh.vertices.buffer);
        for (let offset = 0; offset < mesh.indices.length; offset += 3) {
            const points = Array.from(mesh.indices.subarray(offset, offset + 3), index => [view.getFloat32(index * floatingLayout.stride, true), view.getFloat32(index * floatingLayout.stride + 4, true)]);
            const area = (points[1][0] - points[0][0]) * (points[2][1] - points[0][1]) - (points[1][1] - points[0][1]) * (points[2][0] - points[0][0]);
            expect(Math.sign(area)).toBe(reverse ? -1 : 1);
        }
    }
    expect(clip([[5, 5, 0, 1], [6, 5, 0, 1], [5, 6, 0, 1]]).indices.length).toBe(0);
    expect(clip([[4, 4, 0, 1], [5, 4, 0, 1], [4, 5, 0, 1]]).indices.length).toBe(0);
    expect(clip([[0, 0, 0, 1], [4, 0, 0, 1], [0, 4, 0, 1]], undefined, new Uint32Array()).indices.length).toBe(0);
    expect(() => clip([[0, 0, 0, 1], [4, 0, 0, 1], [0, 4, 0, 1]], undefined, undefined, 1)).toThrow(/budget/);
});

test('an authored triangulated polygon hole stays empty after canonical clipping', () => {
    const points = [[0, 0, 0, 1], [4, 0, 0, 1], [4, 4, 0, 1], [0, 4, 0, 1], [1, 1, 0, 1], [3, 1, 0, 1], [3, 3, 0, 1], [1, 3, 0, 1]];
    const mesh = clip(points, new Uint16Array([0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]));
    const view = new DataView(mesh.vertices.buffer);
    const position = (index: number): [number, number, number] => [view.getFloat32(index * floatingLayout.stride, true), view.getFloat32(index * floatingLayout.stride + 4, true), 0];
    const covered = (point: readonly [number, number]) => Array.from({length: mesh.indices.length / 3}, (_value, index) =>
        intersectRayTriangle([point[0], point[1], 1], [0, 0, -1], position(mesh.indices[index * 3]), position(mesh.indices[index * 3 + 1]), position(mesh.indices[index * 3 + 2]))).some(Boolean);
    expect(covered([2, 2])).toBe(false); expect(covered([0.5, 2])).toBe(true); expect(covered([3.5, 2])).toBe(true);
});

test('prepared polygons remain compatible with the existing packed query-mesh extraction', () => {
    const request = input(), result = drapeTerrainMesh(request);
    const query = extractDrapedTerrainQueryMesh(result.vertices, result.indices, getTerrainVertexLayout(polygonLayout), request.origin, request.tileZoom, 1024 * 1024);
    expect(query.positions.length).toBe(result.statistics.vertices * 3);
    expect(query.heights.every(Number.isFinite)).toBe(true);
});
