// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import VertexLayout from '../src/gl/vertex_layout';
import {refineProjectedMesh} from '../src/experimental/projected-mesh-refinement';
import type {ProjectedRefinementWork} from '../src/experimental/projected-mesh-refinement';
import type {MeshProjectionRequest, ProjectedMesh} from '../src/procedures/mesh-projector';

const layout = new VertexLayout([
    {name: 'a_position', size: 4, type: 5122}, {name: 'a_texcoord', size: 2, type: 5123},
    {name: 'a_selection_color', size: 4, type: 5121}, {name: 'a_projected_position', size: 3, type: 5126}
]);

/** Isolate interior deformation with a tiny triangle and flat provenance/linear UVs. */
function createRequest(points = [[0, 0], [120, 0], [0, 120]], budget = 1000): MeshProjectionRequest {
    const vertices = new Uint8Array(points.length * layout.stride);
    const view = new DataView(vertices.buffer);
    points.forEach(([x, y], index) => {
        const offset = index * layout.stride;
        view.setInt16(offset, x, true); view.setInt16(offset + 2, y, true);
        view.setInt16(offset + 6, 7, true);
        view.setUint16(offset + layout.offset.a_texcoord, x * 8, true);
        view.setUint16(offset + layout.offset.a_texcoord + 2, y * 8, true);
        vertices.set([1, 2, 3, 255], offset + layout.offset.a_selection_color);
    });
    return {vertices, indices: new Uint16Array([0, 1, 2]), layout, geometry: 'raster',
        tile: {coords: {z: 10}, min: {x: 0, y: 0}},
        projection: {type: 'equal-earth', maxAngularSpan: 30, maxProjectedError: 0.1, maxAdditionalVertices: budget}};
}

/** Test kernel whose three boundary edges are exactly straight but whose interior bulges. */
function projectPosition(x: number, y: number): [number, number] {
    return [x, y + 27 * (x / 120) * (y / 120) * (1 - (x + y) / 120)];
}

/** Read source coordinates independently of projected output and attribute interpolation. */
function readPosition(vertex: DataView): [number, number] {
    return [vertex.getInt16(0, true), vertex.getInt16(2, true)];
}

/** Drive the same batched generator used by local and injected engines. */
function refine(request: MeshProjectionRequest, work: ProjectedRefinementWork = {edgeRounds: 0, interiorRounds: 0}): ProjectedMesh {
    const generator = refineProjectedMesh({vertices: request.vertices, indices: new Uint16Array([0, 1, 2])}, request,
        (vertex, displacement = [0, 0]) => {
            const point = readPosition(vertex);
            return [point[0] + displacement[0], point[1] + displacement[1]];
        }, readPosition, work);
    let step = generator.next();
    while (!step.done) {
        const batch = step.value.slice();
        for (let index = 0; index < batch.length; index += 2) {
            [batch[index], batch[index + 1]] = projectPosition(batch[index], batch[index + 1]);
        }
        step = generator.next(batch);
    }
    return step.value;
}

test.each([
    {winding: 'counterclockwise', points: [[0, 0], [120, 0], [0, 120]]},
    {winding: 'clockwise', points: [[0, 0], [0, 120], [120, 0]]}
])('surface interior refinement detects deformation that every original edge probe misses ($winding)', ({points, winding}) => {
    const request = createRequest(points);
    const original = request.vertices.slice();
    const work = {edgeRounds: 0, interiorRounds: 0};
    const result = refine(request, work);
    expect(work.interiorRounds).toBeGreaterThan(0);
    expect(result.vertices.byteLength).toBeGreaterThan(request.vertices.byteLength);
    expect(result.indices.length).toBeGreaterThan(3);
    expect(request.vertices).toEqual(original);
    // No original boundary is subdivided by interior decisions, and flat IDs,
    // layer order and raster UVs survive each inserted center.
    const vertices = new DataView(result.vertices.buffer, result.vertices.byteOffset, result.vertices.byteLength);
    for (let offset = 0; offset < result.vertices.byteLength; offset += layout.stride) {
        const x = vertices.getInt16(offset, true), y = vertices.getInt16(offset + 2, true);
        if (offset >= request.vertices.byteLength) {
            expect(x).toBeGreaterThan(0); expect(y).toBeGreaterThan(0); expect(x + y).toBeLessThan(120);
        }
        expect(vertices.getInt16(offset + 6, true)).toBe(7);
        expect([...result.vertices.subarray(offset + layout.offset.a_selection_color, offset + layout.offset.a_selection_color + 4)])
            .toEqual([1, 2, 3, 255]);
        expect(Math.abs(vertices.getUint16(offset + layout.offset.a_texcoord, true) - x * 8)).toBeLessThanOrEqual(8);
        expect(Math.abs(vertices.getUint16(offset + layout.offset.a_texcoord + 2, true) - y * 8)).toBeLessThanOrEqual(8);
    }
    // Verify final interior residuals independently, not just a larger mesh count.
    for (let index = 0; index < result.indices.length; index += 3) {
        const corners = [0, 1, 2].map(component => {
            const offset = result.indices[index + component] * layout.stride;
            return [vertices.getInt16(offset, true), vertices.getInt16(offset + 2, true)];
        });
        const orientation = (corners[1][0] - corners[0][0]) * (corners[2][1] - corners[0][1]) -
            (corners[1][1] - corners[0][1]) * (corners[2][0] - corners[0][0]);
        expect(orientation * (winding === 'clockwise' ? -1 : 1)).toBeGreaterThan(0);
        for (const weights of [[1 / 3, 1 / 3, 1 / 3], [0.5, 0.25, 0.25], [0.25, 0.5, 0.25], [0.25, 0.25, 0.5]]) {
            const point = [0, 1].map(component => corners.reduce((sum, corner, index) => sum + corner[component] * weights[index], 0));
            const actual = projectPosition(point[0], point[1]);
            const projectedCorners = corners.map(corner => projectPosition(corner[0], corner[1]));
            const expected = [0, 1].map(component => projectedCorners.reduce((sum, corner, index) => sum + corner[component] * weights[index], 0));
            expect(Math.hypot(actual[0] - expected[0], actual[1] - expected[1])).toBeLessThanOrEqual(0.100001);
        }
    }
});

test('interior refinement fails explicitly when its shared additional-vertex budget is exhausted', () => {
    expect(() => refine(createRequest(undefined, 0))).toThrow('interior refinement vertex budget');
});

test('interior refinement cannot insert a rounded center on a triangle edge', () => {
    const request = createRequest([[0, 0], [2, 0], [0, 1]]);
    request.projection.maxProjectedError = 1e-8;
    expect(() => refine(request)).toThrow(/packed (coordinate|position) precision/);
});

test('ribbons keep edge-only refinement and opt-out surfaces retain their original topology', () => {
    const ribbon = createRequest();
    ribbon.geometry = 'lines';
    expect(refine(ribbon).vertices).toEqual(ribbon.vertices);
    const surface = createRequest();
    delete surface.projection.maxProjectedError;
    expect(refine(surface).vertices).toBe(surface.vertices);
});
