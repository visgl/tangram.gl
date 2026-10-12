// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import {Matrix4} from '@math.gl/core';
import HostFrame from '../src/scene/host_frame';
import {layoutProjectedAnnotations} from '../src/labels/projected-pass';
import type {LabelMesh, LabelTile} from '../src/labels/main-pass-types';
import {normalizeTerrainDraping, drapeTerrainMesh, getTerrainVertexLayout, hasTerrainTileCoverage, type TerrainDrapingOptions} from '../src/procedures/terrain-draping';
import type {TerrainHeightGrid} from '../src/map-logic/terrain-data';
import VertexLayout from '../src/gl/vertex_layout';
import {PROJECTION_CONSTANTS} from '../src/scene/projection_math';
import {Style} from '../src/styles/style';
import Scene from '../src/scene/scene';
import TileManager from '../src/tile/tile_manager';

const layout = new VertexLayout([{name: 'a_position', size: 4, type: 5122}, {name: 'a_color', size: 4, type: 5121}, {name: 'a_selection_color', size: 4, type: 5121}]);
const meters = 2 * Math.PI * PROJECTION_CONSTANTS.mercatorRadius / (4096 * 2 ** 16);
/** Small physical planar field, with row zero at its north edge, using the worker's packed layout. */
function grid(height = 100, bounds: TerrainHeightGrid['bounds'] = [-100, -100, 100, 100]): TerrainHeightGrid {
    return {width: 3, height: 3, bounds, registration: 'grid-node', verticalDatum: 'orthometric', heights: new Float32Array(9).fill(height), valid: new Uint8Array(9).fill(1)};
}
/** Packed triangle with a nonzero input-buffer offset and unchanged feature bytes. */
function request(terrain: TerrainDrapingOptions = {grids: [grid()]}, points = [[-100, -100], [100, -100], [0, 100]]) {
    const vertices = new Uint8Array(new ArrayBuffer(points.length * layout.stride + 8), 4, points.length * layout.stride);
    const view = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength);
    points.forEach(([x, y], index) => {
        view.setInt16(index * layout.stride, x, true); view.setInt16(index * layout.stride + 2, y, true);
        view.setInt16(index * layout.stride + 4, 40, true); view.setInt16(index * layout.stride + 6, 7, true);
        vertices.set([20, 30, 40, 255], index * layout.stride + layout.offset.a_color);
        vertices.set([1, 2, 3, 4], index * layout.stride + layout.offset.a_selection_color);
    });
    return {vertices, indices: new Uint16Array([0, 1, 2]), layout, origin: [0, 0] as const, tileZoom: 16, terrain: normalizeTerrainDraping(terrain)};
}
/** Read the appended physical current/previous channels. */
function channels(vertices: Uint8Array, vertex = 0, previous = false) {
    const output = getTerrainVertexLayout(layout);
    const offset = vertex * output.stride + output.offset[previous ? 'a_terrain_previous' : 'a_terrain'];
    const view = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength);
    return [0, 1, 2, 3].map(index => view.getFloat32(offset + index * 4, true));
}

test('tile admission excludes unloaded and edge-only footprints without hiding partial coverage', () => {
    const field = grid(100, [1, 1, 100, 100]);
    expect(hasTerrainTileCoverage([], {x: 1, y: 0, z: 1})).toBe(false);
    expect(hasTerrainTileCoverage([field], {x: 1, y: 0, z: 1})).toBe(true);
    expect(hasTerrainTileCoverage([field], {x: 0, y: 0, z: 1})).toBe(false);
    expect(hasTerrainTileCoverage([field], {x: 1, y: 1, z: 1})).toBe(false);
    expect(hasTerrainTileCoverage([grid(1, [-100, 1, 0, 100])], {x: 1, y: 0, z: 1})).toBe(false);
});

test('worker style completion remaps annotation bytes and avoids raster acquisition for empty terrain', async () => {
    const input = request();
    const style = Object.create(Style);
    const createData = () => ({meshes: {point: {variant: {}, labels: {first: {ranges: [[layout.stride, 2]]}},
        vertex_data: {vertex_count: 3, end: vi.fn(), vertex_buffer: input.vertices, element_buffer: input.indices}}}});
    const data = createData();
    style.tile_data = {fixture: data}; style.terrain = input.terrain;
    style.vertexLayoutForMeshVariant = () => layout; style.baseStyle = () => 'points';
    style.buildRasterTextures = vi.fn(async (_tile: unknown, result: unknown) => result);
    const tile = {id: 'fixture', min: {x: 0, y: 0}, coords: {z: 16}, style_z: 16};
    expect(await style.endData(tile)).toBe(data);
    expect(data.meshes.point.labels.first.ranges).toEqual([[getTerrainVertexLayout(layout).stride, 2]]);
    expect(data.meshes.point.variant).toMatchObject({terrain: true, terrainStatistics: {vertices: 3, triangles: 1}});
    style.buildRasterTextures.mockClear();
    style.tile_data = {fixture: createData()}; style.terrain = normalizeTerrainDraping({grids: []});
    expect(await style.endData(tile)).toBeNull();
    expect(style.buildRasterTextures).not.toHaveBeenCalled();
});

test.each(['position', 'width', 'cpu-projection'])('style initialization rejects incompatible %s deformation', block => {
    const style = Object.create(Style);
    style.shaders = {blocks: block === 'cpu-projection' ? {} : {[block]: 'procedural block'}};
    expect(() => style.init({terrain: normalizeTerrainDraping({grids: []}), config: {scene: {cpu_projection: block === 'cpu-projection'}}})).toThrow(/does not support/);
});

test('draw and selection passes share the mesh clock across portable and classic uniform paths', () => {
    const scene = Object.create(Scene.prototype);
    const mesh = {variant: {terrain: true, blend_order: 0, mesh_order: 0}, geometry_count: 2};
    const setUniforms = vi.fn(); const uniform = vi.fn();
    scene.styles = {ground: {render: vi.fn(() => false)}};
    scene.setupStyle = () => ({uniform}); scene.requestRedraw = vi.fn();
    scene.tile_manager = {getRenderableTiles: () => [{meshes: {ground: [mesh]}, shouldProxyForStyle: () => true}]};
    scene.view = {setupTile: vi.fn(), projection: {type: 'web-mercator'}};
    scene.uniform_buffers = {TangramTile: {setUniforms}};
    scene.terrain = normalizeTerrainDraping({grids: [], transitionDuration: 100});
    scene.terrainExaggeration = 2; scene.terrainFrameTime = 100;
    expect(scene.renderStyle('ground', 'program', 0)).toBe(2);
    expect(setUniforms).toHaveBeenLastCalledWith({u_terrain_blend: 0, u_terrain_exaggeration: 2});
    scene.terrainFrameTime = 150;
    scene.renderStyle('ground', 'program', 0); scene.renderStyle('ground', 'selection_program', 0);
    expect(setUniforms).toHaveBeenLastCalledWith({u_terrain_blend: 0.5, u_terrain_exaggeration: 2});
    scene.uniform_buffers = {}; scene.requestRedraw.mockClear(); scene.terrainFrameTime = 250;
    scene.renderStyle('ground', 'program', 0);
    expect(uniform).toHaveBeenCalledWith('1f', 'u_terrain_blend', 1);
    expect(uniform).toHaveBeenCalledWith('1f', 'u_terrain_exaggeration', 2);
    expect(scene.requestRedraw).not.toHaveBeenCalled();
    scene.terrain = normalizeTerrainDraping({grids: [], transitionDuration: 0});
    scene.renderStyle('ground', 'program', 0);
    expect(uniform).toHaveBeenLastCalledWith('1f', 'u_terrain_exaggeration', 2);
});

test('resident preparation statistics count valid worker outputs without counting flat or disposed meshes', () => {
    const manager = Object.create(TileManager.prototype);
    const statistics = {vertices: 3, triangles: 1, suppressedTriangles: 2, meshBytes: 144, preparationMs: 5, detailLimited: true};
    manager.tileset = {tileRecords: {first: {meshes: {ground: [{valid: true, variant: {terrainStatistics: statistics}}, {valid: false, variant: {terrainStatistics: statistics}}, {valid: true, variant: {}}]}}, empty: {}}};
    expect(manager.getTerrainDrapingStatistics(normalizeTerrainDraping({grids: [grid()]}))).toEqual({enabled: true, gridBytes: 45, meshes: 1, vertices: 3, triangles: 1, suppressedTriangles: 2, meshBytes: 144, maximumPreparationMs: 5, detailLimitedMeshes: 1});
    manager.tileset = {tileRecords: {}};
    expect(manager.getTerrainDrapingStatistics()).toMatchObject({enabled: false, gridBytes: 0, meshes: 0});
});

test('snapshots detach input arrays and retain explicit datum, masks and byte budgets', () => {
    const input = grid(); const previous = grid(50);
    const result = normalizeTerrainDraping({grids: [input], previousGrids: [previous]});
    expect(result.byteLength).toBe(90); expect(result.transitionDuration).toBe(200);
    input.heights.fill(200); input.valid.fill(0);
    expect(result.grids[0].heights[0]).toBe(100); expect(result.grids[0].valid[0]).toBe(1);
    expect(result.grids[0].bounds).not.toBe(input.bounds);
    expect(() => normalizeTerrainDraping({grids: [grid()], maxGridBytes: 44})).toThrow(/budget/);
    expect(() => normalizeTerrainDraping({grids: [grid(), grid()]})).toThrow(/overlap/);
    expect(normalizeTerrainDraping({grids: [grid(100, [-100, -100, 0, 100]), grid(100, [0, -100, 100, 100])]}).grids).toHaveLength(2);
});

test.each([
    {maxGridBytes: -1}, {maxGridBytes: 1.5}, {maxSegmentLength: NaN}, {maxSegmentLength: 0},
    {maxAdditionalVertices: -1}, {maxAdditionalVertices: 262145}, {maxMeshBytes: -1},
    {transitionDuration: -1}, {transitionDuration: Infinity}, {transitionDuration: 5001}
])('rejects malformed policy %j before admission', policy => {
    expect(() => normalizeTerrainDraping({grids: [grid()], ...policy})).toThrow(/limits/);
});

test('rejects grid shape, coordinates, masks, datum and nonfinite valid heights', () => {
    const input = grid();
    for (const invalid of [{...input, width: 1}, {...input, valid: new Uint8Array(2)},
        {...input, bounds: [0, 0, 0, 1] as const}, {...input, bounds: [0, 0, 1, Infinity] as const},
        {...input, valid: new Uint8Array(9).fill(2)}, {...input, heights: new Float32Array(9).fill(NaN)}]) {
        expect(() => normalizeTerrainDraping({grids: [invalid]})).toThrow(/grid/);
    }
    expect(() => normalizeTerrainDraping({grids: [input], previousGrids: [{...grid(), verticalDatum: 'ellipsoidal'}]})).toThrow(/datum/);
    expect(() => normalizeTerrainDraping({grids: Array.from({length: 97}, () => grid())})).toThrow(/96/);
    expect(() => normalizeTerrainDraping({grids: [grid(0, [-1, -3e7, 1, 3e7])]})).toThrow(/grid/);
});

test('refines off-thread packed topology, preserves original IDs/Z/order and records both physical heights', () => {
    const input = request({grids: [grid(100)], previousGrids: [grid(20)], maxSegmentLength: 5});
    const result = drapeTerrainMesh(input); const output = getTerrainVertexLayout(layout);
    expect(result.vertices.length / output.stride).toBeGreaterThan(3);
    expect(result.byteLength).toBe(result.vertices.byteLength + result.indices.byteLength);
    for (let index = 0; index < 3; index++) {
        const source = new DataView(input.vertices.buffer, input.vertices.byteOffset, input.vertices.byteLength);
        const destination = new DataView(result.vertices.buffer);
        for (let component = 0; component < 4; component++) expect(destination.getFloat32(index * output.stride + component * 4, true)).toBe(source.getInt16(index * layout.stride + component * 2, true));
        for (const attribute of ['a_color', 'a_selection_color']) expect(result.vertices.subarray(index * output.stride + output.offset[attribute], index * output.stride + output.offset[attribute] + 4)).toEqual(input.vertices.subarray(index * layout.stride + layout.offset[attribute], index * layout.stride + layout.offset[attribute] + 4));
        for (const previous of [false, true]) {
            const values = channels(result.vertices, index, previous);
            expect(values[0]).toBeCloseTo(previous ? 20 : 100);
            expect(values[1]).toBeCloseTo(0); expect(values[2]).toBeCloseTo(0); expect(values[3]).toBe(1);
        }
    }
    expect(layout.stride).toBe(16); expect(getTerrainVertexLayout(layout)).toBe(output);
    expect(layout.offset.a_terrain).toBeUndefined();
});

test('skinny packed faces retain nonzero area through floating terrain refinement', () => {
    const prepared = drapeTerrainMesh(request({grids: [grid()], maxSegmentLength: 5}, [[-400, 0], [400, 1], [400, 2]]));
    const output = getTerrainVertexLayout(layout); const data = new DataView(prepared.vertices.buffer);
    expect(prepared.indices.length).toBeGreaterThan(3);
    let area = 0;
    for (let index = 0; index < prepared.indices.length; index += 3) {
        const points = Array.from(prepared.indices.subarray(index, index + 3), vertex => [data.getFloat32(vertex * output.stride, true), data.getFloat32(vertex * output.stride + 4, true)]);
        area += Math.abs((points[1][0] - points[0][0]) * (points[2][1] - points[0][1]) - (points[1][1] - points[0][1]) * (points[2][0] - points[0][0])) / 2;
    }
    expect(area).toBeCloseTo(400, 2);
});

test('coarse full-tile raster refinement respects default topology and output budgets', () => {
    const tileZoom = 11; const edge = 2 * Math.PI * PROJECTION_CONSTANTS.mercatorRadius / 2 ** tileZoom;
    const field = grid(100, [0, 0, edge, edge]);
    const input = request({grids: [field]}, [[0, 0], [4096, 0], [0, 4096], [4096, 4096]]);
    const result = drapeTerrainMesh({...input, tileZoom, indices: new Uint16Array([0, 1, 2, 2, 1, 3])});
    expect(result.statistics.detailLimited).toBe(true);
    expect(result.statistics.vertices).toBeLessThan(131072);
    expect(result.byteLength).toBeLessThan(16 * 1024 * 1024);
    expect(result.statistics.suppressedTriangles).toBe(0);
    expect(result.indices.length).toBeGreaterThan(6);
});

test('ENU slope coefficients include latitude scale, boundaries and previous-data fallback', () => {
    const input = grid(); input.heights.set([0, 100, 200, 0, 100, 200, 0, 100, 200]);
    const result = drapeTerrainMesh({...request({grids: [input], previousGrids: [grid(5, [200, 200, 300, 300])]}), annotations: true});
    expect(channels(result.vertices)[1]).toBeCloseTo(1, 5);
    expect(channels(result.vertices)[2]).toBe(0);
    expect(channels(result.vertices, 0, true)[0]).toBe(channels(result.vertices)[0]);
    expect(channels(result.vertices, 0, true)[1]).toBe(channels(result.vertices)[1]);
    const north = 1e7; const high = {...input, bounds: [-100, north - 100, 100, north + 100] as const};
    const elevated = drapeTerrainMesh({...request({grids: [high]}), origin: [0, north], annotations: true});
    expect(channels(elevated.vertices)[1]).toBeCloseTo(Math.cosh((north - 100 * meters) / PROJECTION_CONSTANTS.mercatorRadius), 5);
    const edge = drapeTerrainMesh({...request({grids: [input], maxSegmentLength: 50}, [[0, 0], [0, 1], [1, 0]]), origin: [-100, 0], annotations: true});
    expect(channels(edge.vertices)[1]).toBeCloseTo(1);
});

test('missing grids and interior no-data holes never become a zero-height bridge', () => {
    expect(drapeTerrainMesh(request({grids: []})).indices).toHaveLength(0);
    const outside = drapeTerrainMesh(request({grids: [grid(0, [1000, 1000, 1100, 1100])], maxAdditionalVertices: 0, maxMeshBytes: 0}));
    expect(outside.byteLength).toBe(0); expect(outside.statistics.suppressedTriangles).toBe(1);
    const input = grid(); input.valid[4] = 0; input.heights[4] = NaN;
    const result = drapeTerrainMesh(request({grids: [input], maxSegmentLength: 250}, [[-650, -650], [650, -650], [0, 650]]));
    // All three corners are valid, but the interior intersects the invalid center.
    expect(result.indices).toHaveLength(0);
    const missing = drapeTerrainMesh(request({grids: [grid(10, [-100, -100, -1, 100]), grid(10, [1, -100, 100, 100])], maxSegmentLength: 250}));
    expect(missing.indices).toHaveLength(0);
});

test('screen-space annotations retain their exact quads, while invalid anchors disappear', () => {
    const input = request();
    const result = drapeTerrainMesh({...input, annotations: true});
    expect(result.vertices.length / getTerrainVertexLayout(layout).stride).toBe(3);
    expect(result.indices).toEqual(input.indices);
    expect(drapeTerrainMesh({...input, annotations: true, terrain: normalizeTerrainDraping({grids: []})}).indices).toHaveLength(0);
});

test('dynamic road ribbons cannot extend across missing coverage merely because their centerline is valid', () => {
    const packed = new VertexLayout([{name: 'a_position', size: 4, type: 5122}, {name: 'a_extrude', size: 2, type: 5122}]);
    const vertices = new Uint8Array(packed.stride * 3); const view = new DataView(vertices.buffer);
    [[0, 0, -100], [0, 0, 100], [0, 100, 100]].forEach(([x, y, extrusion], index) => {
        view.setInt16(index * packed.stride, x, true); view.setInt16(index * packed.stride + 2, y, true); view.setInt16(index * packed.stride + packed.offset.a_extrude, extrusion, true);
    });
    const result = drapeTerrainMesh({vertices, indices: new Uint16Array([0, 1, 2]), layout: packed, origin: [0, 0], tileZoom: 16, terrain: normalizeTerrainDraping({grids: [grid(100, [-20, -100, 20, 100])]})});
    expect(result.indices.length).toBeGreaterThan(0);
    const output = new DataView(result.vertices.buffer); const preparedLayout = getTerrainVertexLayout(packed); const stride = preparedLayout.stride;
    for (const index of result.indices) {
        const center = output.getFloat32(index * stride, true) * meters;
        const extent = 2 * Math.abs(output.getFloat32(index * stride + preparedLayout.offset.a_extrude, true)) * meters;
        expect(center - extent).toBeGreaterThanOrEqual(-20); expect(center + extent).toBeLessThanOrEqual(20);
    }
});

test('triangle, packed input and completed-mesh limits fail explicitly without mutating data', () => {
    const input = request(); const original = input.vertices.slice();
    expect(() => drapeTerrainMesh({...input, indices: new Uint16Array([0, 1])})).toThrow(/indices/);
    expect(() => drapeTerrainMesh({...input, indices: new Uint16Array([0, 1, 5])})).toThrow(/indices/);
    expect(() => drapeTerrainMesh({...input, tileZoom: 31})).toThrow(/tile/);
    expect(() => drapeTerrainMesh({...input, origin: [NaN, 0]})).toThrow(/tile/);
    expect(() => drapeTerrainMesh({...input, vertices: input.vertices.subarray(1)})).toThrow(/aligned/);
    expect(() => drapeTerrainMesh({...input, terrain: normalizeTerrainDraping({grids: [grid()], maxMeshBytes: 1})})).toThrow(/budget/);
    expect(() => drapeTerrainMesh({...request({grids: [grid()], maxSegmentLength: 1, maxAdditionalVertices: 0})})).toThrow(/budget/);
    expect(() => drapeTerrainMesh({...request({grids: [grid()], maxSegmentLength: 5, maxMeshBytes: 200})})).toThrow(/budget/);
    expect(input.vertices).toEqual(original);
    expect(drapeTerrainMesh({...input, vertices: new Uint8Array(), indices: false}).byteLength).toBe(0);
    expect(drapeTerrainMesh({...input, indices: false, annotations: true}).indices).toEqual(new Uint16Array([0, 1, 2]));
});

test('annotation collision shares morph heights with both eyes and recovers visibility after relief changes', () => {
    const packed = new VertexLayout([{name: 'a_position', size: 4, type: 5122}, {name: 'a_shape', size: 4, type: 5122}]);
    const original = new Uint8Array(packed.stride * 4); const input = new DataView(original.buffer);
    for (let index = 0; index < 4; index++) {
        input.setInt16(index * packed.stride + packed.offset.a_shape, (index % 2 ? 10 : -10) * 256, true);
        input.setInt16(index * packed.stride + packed.offset.a_shape + 2, (index < 2 ? 10 : -10) * 256, true);
        input.setInt16(index * packed.stride + packed.offset.a_shape + 6, 1, true);
    }
    const prepared = drapeTerrainMesh({vertices: original, indices: new Uint16Array([0, 1, 2, 2, 1, 3]), layout: packed, origin: [0, 0], tileZoom: 16, annotations: true, terrain: normalizeTerrainDraping({grids: [grid(2)], previousGrids: [grid(0)]})});
    const mesh: LabelMesh = {valid: true, vertex_data: prepared.vertices, vertex_layout: getTerrainVertexLayout(packed), labels: {1: {container: {label: {id: 1, type: 'point', position: [0, 0], layout: {priority: 1, collide: false, projected_collide: true, buffer: [0, 0]}}}, ranges: [[0, 4]]}}, upload: vi.fn()};
    const tile: LabelTile = {coords: {z: 16}, style_z: 16, build_id: 1, min: {x: 0, y: 0}, span: {x: 1}, meshes: {points: [mesh]}, pending_label_meshes: null, isProxy: () => false, swapPendingLabels() {}};
    const camera = {view: new Matrix4(), projection: new Matrix4(), position: [0, 0, 10] as const};
    const frame = new HostFrame({viewport: {width: 200, height: 100}, geographicAnchor: {longitude: 0, latitude: 0, zoom: 16}, renderViews: [{id: 'left', viewport: {width: 100, height: 100}, camera}, {id: 'right', viewport: {x: 100, width: 100, height: 100}, camera}]});
    const data = new DataView(prepared.vertices.buffer); const shown = () => data.getInt16(mesh.vertex_layout.offset.a_shape + 6, true);
    layoutProjectedAnnotations([tile], frame, {terrainTransitionDuration: 100, terrainTime: 100}); expect(shown()).toBe(1);
    layoutProjectedAnnotations([tile], frame, {terrainTransitionDuration: 100, terrainTime: 200}); expect(shown()).toBe(0);
    layoutProjectedAnnotations([tile], frame, {terrainTransitionDuration: 100, terrainTime: 200, terrainExaggeration: 0}); expect(shown()).toBe(1);
    expect(mesh.terrainVisibleAt).toBe(100);
});
