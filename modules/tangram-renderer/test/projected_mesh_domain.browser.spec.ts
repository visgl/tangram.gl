// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {beforeEach, expect, test, vi} from 'vitest';
import VertexLayout from '../src/gl/vertex_layout';
import Geo from '../src/utils/geo';
import {projectBasemapMesh, projectBasemapMeshWithEngine, clearProjectedMeshPreparation,
    getProjectedMeshPreparationStatistics, getProjectedMeshWorkStatistics} from '../src/experimental/projected-mesh';
import {clipProjectedMesh} from '../src/experimental/projected-mesh-domain';
import type {MeshProjectionRequest} from '../src/procedures/mesh-projector';

const layout = new VertexLayout([
    {name: 'a_position', size: 4, type: 5122},
    {name: 'a_texcoord', size: 2, type: 5123},
    {name: 'a_selection_color', size: 4, type: 5121},
    {name: 'a_projected_position', size: 3, type: 5126}
]);

/** Small deterministic triangle fixtures with UVs and flat provenance bytes. */
function request(points: readonly (readonly [number, number])[], x = 0, y = 0, z = 0): MeshProjectionRequest {
    const vertices = new Uint8Array(layout.stride * points.length);
    const view = new DataView(vertices.buffer);
    points.forEach(([first, second], index) => {
        const offset = index * layout.stride;
        view.setInt16(offset, first, true); view.setInt16(offset + 2, second, true);
        view.setInt16(offset + 6, 5, true);
        view.setUint16(offset + layout.offset.a_texcoord, Math.round(first * 8), true);
        view.setUint16(offset + layout.offset.a_texcoord + 2, Math.round(-second * 8), true);
        vertices.set([1, 2, 3, 4], offset + layout.offset.a_selection_color);
    });
    const coords = {x, y, z};
    return {vertices, indices: new Uint16Array([0, 1, 2]), layout,
        tile: {coords, min: Geo.metersForTile(coords)}, geometry: 'raster',
        projection: {type: 'equirectangular', maxAngularSpan: 30}};
}

/** Read packed source coordinates independently of target projection. */
function readPosition(vertex: DataView): [number, number] {
    return [vertex.getInt16(0, true), vertex.getInt16(2, true)];
}

beforeEach(() => clearProjectedMeshPreparation());

test('opt-in completed meshes restore a projection without kernel work and survive transfer', () => {
    const input = request([[0, 0], [100, 0], [0, -100]], 1, 1, 6);
    input.projection.cacheProjectedMeshes = true;
    // Real worker tiles carry lifecycle/source records, sometimes circular; only geometric fields belong in keys.
    Object.assign(input.tile, {lifecycle: input.tile});
    const first = projectBasemapMesh(input);
    const expected = {vertices: first.vertices.slice(), indices: first.indices.slice()};
    projectBasemapMesh({...input, projection: {...input.projection, type: 'equal-earth'}});
    structuredClone(first.vertices, {transfer: [first.vertices.buffer]});
    expect(projectBasemapMesh(input)).toEqual(expected);
    expect(getProjectedMeshWorkStatistics().completedMeshes).toBe(2);
    expect(getProjectedMeshPreparationStatistics().projectedResults).toMatchObject({entries: 2, hits: 1, misses: 2});
    const changed = input.vertices.slice();
    changed[layout.offset.a_selection_color] = 42;
    projectBasemapMesh({...input, vertices: changed});
    projectBasemapMesh({...input, projection: {...input.projection, maxAngularSpan: 10}});
    expect(getProjectedMeshPreparationStatistics().projectedResults).toMatchObject({entries: 4, hits: 1, misses: 4});
});

test('host output reuse requires opt-in immutable engine identity and isolates independent engines', async () => {
    const input = request([[0, 0], [100, 0], [0, -100]], 1, 1, 6);
    input.projection.cacheProjectedMeshes = true;
    const projectPositions = vi.fn(async (coordinates: Float64Array) => coordinates.fill(1));
    const first = await projectBasemapMeshWithEngine({...input, projectPositions, projectionCacheKey: 'engine-1'});
    const second = await projectBasemapMeshWithEngine({...input, projectPositions, projectionCacheKey: 'engine-1'});
    expect(second).toEqual(first);
    expect(second.vertices.buffer).not.toBe(first.vertices.buffer);
    expect(projectPositions).toHaveBeenCalledOnce();
    await projectBasemapMeshWithEngine({...input, projectPositions, projectionCacheKey: 'engine-2'});
    await projectBasemapMeshWithEngine({...input, projectPositions});
    await projectBasemapMeshWithEngine({...input, projectPositions});
    expect(projectPositions).toHaveBeenCalledTimes(4);
    expect(getProjectedMeshPreparationStatistics().projectedResults).toMatchObject({entries: 2, hits: 1, misses: 2});
});

test('projection work snapshots count submitted samples, completed meshes and rejected batches separately', async () => {
    const input = request([[0, 0], [100, 0], [0, -100]], 1, 1, 6);
    const result = projectBasemapMesh(input);
    expect(getProjectedMeshWorkStatistics()).toEqual({completedMeshes: 1, failedMeshes: 0,
        sourceVertices: 3, outputVertices: result.vertices.byteLength / layout.stride,
        outputTriangles: result.indices.length / 3, projectionBatches: 1, projectedPositions: 3,
        edgeRounds: 0, interiorRounds: 0});
    const detached = getProjectedMeshWorkStatistics();
    detached.completedMeshes = 999;
    await expect(projectBasemapMeshWithEngine({...input, projectPositions: async () => {
        throw new Error('test engine failure');
    }})).rejects.toThrow('test engine failure');
    expect(getProjectedMeshWorkStatistics()).toMatchObject({completedMeshes: 1, failedMeshes: 1,
        sourceVertices: 3, projectionBatches: 2, projectedPositions: 6});
    clearProjectedMeshPreparation();
    expect(Object.values(getProjectedMeshWorkStatistics())).toEqual(new Array(9).fill(0));
});

test('a late rejected host batch cannot contaminate reset worker diagnostics', async () => {
    let rejectPending: (reason: Error) => void = () => {throw new Error('Promise not initialized');};
    const pending = new Promise<Float64Array>((_resolve, reject) => {rejectPending = reject;});
    const input = request([[0, 0], [100, 0], [0, -100]], 1, 1, 6);
    const result = projectBasemapMeshWithEngine({...input, projectPositions: () => pending});
    const rejected = expect(result).rejects.toThrow('late failure');
    expect(getProjectedMeshWorkStatistics().projectionBatches).toBe(1);
    clearProjectedMeshPreparation();
    rejectPending(new Error('late failure'));
    await rejected;
    expect(Object.values(getProjectedMeshWorkStatistics())).toEqual(new Array(9).fill(0));
});

test('projection switches reuse prepared source topology, without caching host results', async () => {
    const input = request([[0, 0], [4096, 0], [0, -4096]]);
    const original = input.vertices.slice();
    const first = projectBasemapMesh(input);
    projectBasemapMesh({...input, vertices: input.vertices.slice(), projection: {...input.projection, type: 'equal-earth'}});
    const restored = projectBasemapMesh(input);
    expect(restored).toEqual(first);
    expect(input.vertices).toEqual(original);
    expect(getProjectedMeshPreparationStatistics()).toMatchObject({hits: 2, misses: 1, entries: 1});
    const host = vi.fn(async (coordinates: Float64Array) => coordinates.fill(1));
    const remote = await projectBasemapMeshWithEngine({...input, projectPositions: host});
    host.mockImplementation(async coordinates => coordinates.fill(2));
    const updated = await projectBasemapMeshWithEngine({...input, projectPositions: host});
    expect(host).toHaveBeenCalledTimes(2);
    expect(updated.vertices).not.toEqual(remote.vertices);
    // Transferring one result must not detach the cache or another result.
    structuredClone(restored.vertices, {transfer: [restored.vertices.buffer]});
    expect(projectBasemapMesh(input)).toEqual(first);
});

test('no-refinement projection also preserves input and independent output buffers', () => {
    const input = request([[0, 0], [100, 0], [0, -100]], 1, 1, 6);
    const original = input.vertices.slice();
    const first = projectBasemapMesh(input);
    expect(first.vertices.buffer).not.toBe(input.vertices.buffer);
    expect(input.vertices).toEqual(original);
    first.vertices.fill(255);
    expect(projectBasemapMesh(input).vertices).not.toEqual(first.vertices);
});

test('refinement limits, tile metadata and styled attributes invalidate preparation', () => {
    const input = request([[0, 0], [100, 0], [0, -100]], 1, 1, 6);
    projectBasemapMesh(input);
    projectBasemapMesh({...input, projection: {...input.projection, maxAngularSpan: 15}});
    projectBasemapMesh({...input, tile: {...input.tile, min: {x: input.tile.min.x + 1, y: input.tile.min.y}}});
    const changed = input.vertices.slice(); changed[layout.offset.a_selection_color] = 9;
    projectBasemapMesh({...input, vertices: changed});
    expect(getProjectedMeshPreparationStatistics()).toMatchObject({misses: 4, hits: 0});
    clearProjectedMeshPreparation();
    expect(getProjectedMeshPreparationStatistics()).toEqual({entries: 0, bytes: 0, hits: 0, misses: 0});
});

const borderTriangles: [number, number][][] = [
    [[-100, -100], [100, -100], [100, -300]],
    [[3996, -100], [4196, -100], [3996, -300]],
    [[100, 100], [300, -100], [100, -100]],
    [[100, -3996], [300, -4196], [100, -4196]]
];
test.each(borderTriangles.map(points => ({points})))('clips world-border triangles instead of flattening padding vertices: $points', ({points}) => {
    const input = request(points);
    const original = input.vertices.slice();
    const clipped = clipProjectedMesh({vertices: input.vertices, indices: new Uint16Array([0, 1, 2])}, input, readPosition, 10);
    expect(clipped.indices.length).toBeGreaterThan(0);
    const output = new DataView(clipped.vertices.buffer);
    for (let offset = 0; offset < clipped.vertices.length; offset += layout.stride) {
        const x = output.getInt16(offset, true), y = output.getInt16(offset + 2, true);
        expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(4096);
        expect(y).toBeGreaterThanOrEqual(-4096); expect(y).toBeLessThanOrEqual(0);
        expect([...clipped.vertices.subarray(offset + layout.offset.a_selection_color, offset + layout.offset.a_selection_color + 4)])
            .toEqual([1, 2, 3, 4]);
        expect(output.getInt16(offset + 6, true)).toBe(5);
    }
    expect(input.vertices).toEqual(original);
});

test('cut raster UVs interpolate at the cut, not at the clamped outside endpoint', () => {
    const input = request([[3996, -100], [4196, -100], [3996, -300]]);
    const result = clipProjectedMesh({vertices: input.vertices, indices: new Uint16Array([0, 1, 2])}, input, readPosition, 10);
    const output = new DataView(result.vertices.buffer);
    for (let offset = 0; offset < result.vertices.length; offset += layout.stride) {
        const x = output.getInt16(offset, true);
        expect(output.getUint16(offset + layout.offset.a_texcoord, true)).toBe(x * 8);
    }
});

test('discarded triangles never reach the host engine and clipping obeys the shared budget', async () => {
    const input = request([[-300, -100], [-100, -100], [-100, -300]]);
    const host = vi.fn(async (coordinates: Float64Array) => coordinates);
    const result = await projectBasemapMeshWithEngine({...input, projectPositions: host});
    expect(result.vertices.length).toBe(0); expect(result.indices.length).toBe(0);
    expect(host).toHaveBeenCalledWith(new Float64Array(0));
    const crossing = request([[-100, -100], [100, -100], [100, -300]]);
    expect(() => clipProjectedMesh({vertices: crossing.vertices, indices: new Uint16Array([0, 1, 2])}, crossing, readPosition, 0))
        .toThrow('clipping vertex budget');
});

const outsideTriangles: [number, number][][] = [
    [[-100, 100], [100, 100], [100, 300]],
    [[-100, -4196], [100, -4196], [100, -4296]],
    [[4196, 100], [4196, -100], [4296, -100]],
    [[-100, 100], [-100, -100], [-300, -100]]
];
test.each(outsideTriangles.map(points => ({points})))('outside triangles crossing another plane consume no clipping budget: $points', async ({points}) => {
    const input = request(points);
    const host = vi.fn(async (coordinates: Float64Array) => coordinates);
    const result = await projectBasemapMeshWithEngine({...input,
        projection: {...input.projection, maxAdditionalVertices: 0}, projectPositions: host});
    expect(result.vertices).toHaveLength(0);
    expect(result.indices).toHaveLength(0);
    expect(host).toHaveBeenCalledWith(new Float64Array(0));
});

test('Albers clips coarse tiles to the documented region and retains finite positions', () => {
    const input = request([[0, 0], [4096, 0], [4096, -4096]], 0, 0, 0);
    const result = projectBasemapMesh({...input, projection: {type: 'albers', maxAngularSpan: 30}});
    expect(result.indices.length).toBeGreaterThan(0);
    const output = new DataView(result.vertices.buffer);
    for (let offset = 0; offset < result.vertices.length; offset += layout.stride) {
        const longitude = -180 + output.getInt16(offset, true) * 360 / 4096;
        expect(longitude).toBeGreaterThanOrEqual(-170.05); expect(longitude).toBeLessThanOrEqual(-39.95);
        expect(Number.isFinite(output.getFloat32(offset + layout.offset.a_projected_position, true))).toBe(true);
    }
});

test('both antimeridian edges remain distinct, with no triangle bridging the map', () => {
    const west = projectBasemapMesh(request([[0, -100], [100, -100], [0, -200]], 0, 0, 6));
    const east = projectBasemapMesh(request([[3996, -100], [4096, -100], [4096, -200]], 63, 0, 6));
    expect(new DataView(west.vertices.buffer).getFloat32(layout.offset.a_projected_position, true)).toBeLessThan(-790);
    expect(new DataView(east.vertices.buffer).getFloat32(layout.offset.a_projected_position, true)).toBeGreaterThan(790);
});

test('clipping an existing triangulated ring preserves its hole and winding', () => {
    const input = request([[-100, -100], [300, -100], [300, -500], [-100, -500],
        [50, -250], [150, -250], [150, -350], [50, -350]]);
    const indices = new Uint16Array([0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
        2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]);
    const result = clipProjectedMesh({vertices: input.vertices, indices}, input, readPosition, 100);
    const view = new DataView(result.vertices.buffer);
    let area = 0;
    for (let offset = 0; offset < result.indices.length; offset += 3) {
        const points = Array.from(result.indices.subarray(offset, offset + 3), index =>
            readPosition(new DataView(view.buffer, index * layout.stride, layout.stride)));
        const [first, second, third] = points;
        const signedArea = ((second[0] - first[0]) * (third[1] - first[1]) -
            (second[1] - first[1]) * (third[0] - first[0])) / 2;
        expect(signedArea).toBeLessThan(0);
        area -= signedArea;
        const centerX = points.reduce((sum, point) => sum + point[0], 0) / 3;
        const centerY = points.reduce((sum, point) => sum + point[1], 0) / 3;
        expect(centerX > 50 && centerX < 150 && centerY > -350 && centerY < -250).toBe(false);
    }
    // 300-by-400 retained outer region, minus the 100-by-100 hole; packed cut rounding is bounded.
    expect(area).toBeCloseTo(110000, -2);
});

test('expanded ribbon corners clip while packed centerline/extrusion and IDs remain intact', () => {
    const input = request([[0, -100], [100, -100], [100, -300]]);
    const expanded = (vertex: DataView): [number, number] => [vertex.getInt16(0, true) - 50, vertex.getInt16(2, true)];
    const result = clipProjectedMesh({vertices: input.vertices, indices: new Uint16Array([0, 1, 2])}, input, expanded, 10);
    const view = new DataView(result.vertices.buffer);
    for (let offset = 0; offset < result.vertices.length; offset += layout.stride) {
        expect(view.getInt16(offset, true)).toBeGreaterThanOrEqual(50);
        expect(view.getInt16(offset + 6, true)).toBe(5);
    }
});

test('clipping fails explicitly if an intersection would blend distinct flat feature IDs', () => {
    const input = request([[-100, -100], [100, -100], [100, -300]]);
    input.vertices[layout.stride + layout.offset.a_selection_color] = 9;
    expect(() => clipProjectedMesh({vertices: input.vertices, indices: new Uint16Array([0, 1, 2])}, input, readPosition, 10))
        .toThrow('varying flat attribute');
});

test('adjacent coarse tiles agree where an Albers regional cut meets their shared edge', () => {
    const prepare = (x: number) => {
        const input = request([[0, 0], [4096, 0], [4096, -4096], [0, -4096]], x, 0, 2);
        input.indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
        input.projection.type = 'albers';
        return projectBasemapMesh(input);
    };
    const edge = (mesh: ReturnType<typeof projectBasemapMesh>, localX: number) => {
        const points = new Map<number, number[]>();
        const view = new DataView(mesh.vertices.buffer);
        for (let offset = 0; offset < mesh.vertices.length; offset += layout.stride) {
            if (view.getInt16(offset, true) === localX) points.set(view.getInt16(offset + 2, true),
                [0, 1, 2].map(component => view.getFloat32(offset + layout.offset.a_projected_position + component * 4, true)));
        }
        return [...points.entries()].sort(([first], [second]) => first - second);
    };
    const west = edge(prepare(0), 4096), east = edge(prepare(1), 0);
    expect(west.length).toBeGreaterThan(1);
    expect(west).toEqual(east);
});

const boundaryTriangles: [number, number][][] = [
    [[0, -100], [-100, -100], [100, -300]],
    [[-100, -100], [0, -100], [100, -300]]
];
test.each(boundaryTriangles.map(points => ({points})))('on-boundary vertices are reused without duplicate fan triangles: $points', ({points}) => {
    const input = request(points);
    const result = clipProjectedMesh({vertices: input.vertices, indices: new Uint16Array([0, 1, 2])}, input, readPosition, 1);
    expect(result.indices).toHaveLength(3);
    expect(new Set(result.indices).size).toBe(3);
});
