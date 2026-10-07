// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test, vi} from 'vitest';
import {refineGlobeMesh, type GlobeMeshData} from '../src/gl/globe_mesh';
import VertexLayout from '../src/gl/vertex_layout';
import VBOMesh from '../src/gl/vbo_mesh';
import {Style} from '../src/styles/style';
import debugSettings from '../src/utils/debug_settings';
import type {Buffer} from '@luma.gl/core';

const layout = new VertexLayout([
    {name: 'a_position', size: 4, type: 0x1402},
    {name: 'a_texcoord', size: 2, type: 0x1406},
    {name: 'a_selection_color', size: 4, type: 0x1401}
]);
const quadIndices = new Uint16Array([0, 1, 2, 0, 2, 3]);

/** Make packed data with nonzero byte offset and deterministic UVs and feature IDs. */
function createVertices(points: number[][]): Uint8Array {
    const vertices = new Uint8Array(new ArrayBuffer(points.length * layout.stride + 16), 8,
        points.length * layout.stride);
    const view = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength);
    points.forEach(([x, y, height = 80], index) => {
        const offset = index * layout.stride;
        [x, y, height, 5].forEach((value, component) => view.setInt16(offset + component * 2, value, true));
        view.setFloat32(offset + 8, x / 4096, true);
        view.setFloat32(offset + 12, -y / 4096, true);
        vertices.set([20, 40, 60, 255], offset + 16);
    });
    return vertices;
}

/** Decode tile-local XY from the packed output. */
function readPoints(data: GlobeMeshData): number[][] {
    const view = new DataView(data.vertices.buffer, data.vertices.byteOffset, data.vertices.byteLength);
    return Array.from({length: data.vertices.length / layout.stride}, (_, index) =>
        [view.getInt16(index * layout.stride, true), view.getInt16(index * layout.stride + 2, true)]);
}

describe('projection-aware triangle refinement', () => {
    test('curves a raster quad with bounded edges, matching UVs, height and exact feature IDs', () => {
        const vertices = createVertices([[0, 0], [4096, 0], [4096, -4096], [0, -4096]]);
        const original = vertices.slice();
        const refined = refineGlobeMesh(vertices, quadIndices, layout, {tileZoom: 2});
        const points = readPoints(refined);
        expect(points.length).toBeGreaterThan(4);
        expect(refined.vertices.subarray(0, vertices.length)).toEqual(vertices);
        expect(vertices).toEqual(original);
        expect(quadIndices).toEqual(new Uint16Array([0, 1, 2, 0, 2, 3]));
        const view = new DataView(refined.vertices.buffer);
        for (const [index, [x, y]] of points.entries()) {
            const offset = index * layout.stride;
            expect(view.getFloat32(offset + 8, true)).toBeCloseTo(x / 4096, 5);
            expect(view.getFloat32(offset + 12, true)).toBeCloseTo(-y / 4096, 5);
            expect(view.getInt16(offset + 4, true)).toBe(80);
            expect(view.getInt16(offset + 6, true)).toBe(5);
            expect([...refined.vertices.subarray(offset + 16, offset + 20)]).toEqual([20, 40, 60, 255]);
        }
        let totalArea = 0;
        for (let index = 0; index < refined.indices.length; index += 3) {
            const triangle = [...refined.indices.subarray(index, index + 3)].map(vertex => points[vertex]);
            const [first, second, third] = triangle;
            const area = (second[0] - first[0]) * (third[1] - first[1]) -
                (second[1] - first[1]) * (third[0] - first[0]);
            expect(area).toBeLessThan(0); // Original winding is clockwise.
            totalArea += area / 2;
            for (let edge = 0; edge < 3; edge++) {
                const start = triangle[edge];
                const end = triangle[(edge + 1) % 3];
                expect(Math.hypot(start[0] - end[0], start[1] - end[1])).toBeLessThanOrEqual(4096 * 4 * 4 / 360);
            }
        }
        expect(totalArea).toBe(-(4096 ** 2));
        expect(new Set(points.map(point => point.join(','))).size).toBe(points.length);
    });

    test('neighboring tile borders use identical quantized splits in opposite winding', () => {
        const first = refineGlobeMesh(createVertices([[0, 0], [4096, 0], [4096, -4096], [0, -4096]]),
            quadIndices, layout, {tileZoom: 3});
        const second = refineGlobeMesh(createVertices([[0, -4096], [4096, -4096], [4096, 0], [0, 0]]),
            quadIndices, layout, {tileZoom: 3});
        const firstEdge = readPoints(first).filter(([x]) => x === 4096).map(([, y]) => y).sort((a, b) => a - b);
        const secondEdge = readPoints(second).filter(([x]) => x === 0).map(([, y]) => y).sort((a, b) => a - b);
        expect(firstEdge.length).toBeGreaterThan(2);
        expect(firstEdge).toEqual(secondEdge);
    });

    test.each([
        {points: [[0, 0], [1000, 0], [500, 10]]}, // One long edge.
        {points: [[0, 0], [1000, 0], [0, 10]]}, // Two long edges.
        {points: [[0, 0], [1000, 0], [0, -1000]]} // Three long edges.
    ])('handles selective edge splitting without losing area: %j', ({points}) => {
        const result = refineGlobeMesh(createVertices(points), false, layout, {tileZoom: 4});
        expect(result.indices.length).toBeGreaterThan(3);
        expect([...result.indices].every(index => index < result.vertices.length / layout.stride)).toBe(true);
    });

    test('does not refine tiny buildings because another feature in the mesh is long', () => {
        const vertices = createVertices([[0, 0], [4096, 0], [0, -4096], [10, -10], [11, -10], [10, -11]]);
        const result = refineGlobeMesh(vertices, new Uint16Array([0, 1, 2, 3, 4, 5]), layout, {tileZoom: 4});
        const triangles = Array.from({length: result.indices.length / 3}, (_, index) =>
            [...result.indices.subarray(index * 3, index * 3 + 3)]);
        expect(triangles).toContainEqual([3, 4, 5]);
        expect(triangles.at(-1)).toEqual([3, 4, 5]); // Preserve feature draw order.
    });

    test('returns original data when already fine enough, including nonindexed triangles', () => {
        const vertices = createVertices([[0, 0], [10, 0], [0, -10]]);
        const result = refineGlobeMesh(vertices, false, layout, {tileZoom: 7});
        expect(result.vertices).toBe(vertices);
        expect([...result.indices]).toEqual([0, 1, 2]);
    });

    test('promotes indices when new vertices cross the uint16 boundary', () => {
        const vertices = new Uint8Array(65536 * layout.stride);
        vertices.set(createVertices([[0, 0], [4096, 0], [0, -4096]]));
        const result = refineGlobeMesh(vertices, new Uint32Array([0, 1, 2]), layout, {tileZoom: 6});
        expect(result.indices).toBeInstanceOf(Uint32Array);
        expect(Math.max(...result.indices)).toBeGreaterThan(65535);
    });

    test.each([
        {type: 0x1400, ArrayType: Int8Array}, {type: 0x1401, ArrayType: Uint8Array},
        {type: 0x1402, ArrayType: Int16Array}, {type: 0x1403, ArrayType: Uint16Array},
        {type: 0x1404, ArrayType: Int32Array}, {type: 0x1405, ArrayType: Uint32Array},
        {type: 0x1406, ArrayType: Float32Array}
    ])('interpolates packed attribute type $type', ({type, ArrayType}) => {
            const typedLayout = new VertexLayout([
                {name: 'a_position', size: 2, type: 0x1402},
                {name: 'a_color', size: 1, type}
            ]);
            const vertices = new Uint8Array(typedLayout.stride * 3);
            const view = new DataView(vertices.buffer);
            view.setInt16(typedLayout.stride, 1000, true);
            view.setInt16(typedLayout.stride * 2 + 2, -1000, true);
            new ArrayType(vertices.buffer, typedLayout.stride + 4, 1)[0] = 100;
            const result = refineGlobeMesh(vertices, new Uint16Array([0, 1, 2]), typedLayout, {tileZoom: 4});
            expect(result.vertices.length).toBeGreaterThan(vertices.length);
            // The first midpoint is halfway along edge 0 -> 1, in every packed domain.
            expect(new ArrayType(result.vertices.slice().buffer, typedLayout.stride * 3 + 4, 1)[0]).toBe(50);
        });

    test('rejects varying IDs and unsupported custom interpolation instead of corrupting picking', () => {
        const vertices = createVertices([[0, 0], [4096, 0], [0, -4096]]);
        vertices[layout.stride + 16] = 30;
        expect(() => refineGlobeMesh(vertices, false, layout, {tileZoom: 4})).toThrow('a_selection_color');
        const customLayout = new VertexLayout([
            {name: 'a_position', size: 2, type: 0x1402},
            {name: 'feature_id', size: 1, type: 0x1405}
        ]);
        const custom = new Uint8Array(customLayout.stride * 3);
        const view = new DataView(custom.buffer);
        view.setInt16(customLayout.stride, 4096, true);
        view.setUint32(customLayout.stride + 4, 42, true);
        expect(() => refineGlobeMesh(custom, false, customLayout, {tileZoom: 4})).toThrow('feature_id');
    });

    test('fails atomically on invalid inputs or exhausted budgets', () => {
        const vertices = createVertices([[0, 0], [4096, 0], [0, -4096]]);
        for (const tileZoom of [-1, NaN, 2.5, 31]) {
            expect(() => refineGlobeMesh(vertices, false, layout, {tileZoom})).toThrow('invalid refinement limits');
        }
        expect(() => refineGlobeMesh(vertices, false, layout, {tileZoom: 0, maxAngularSpan: 0.001})).toThrow('precision');
        expect(() => refineGlobeMesh(vertices, false, layout, {tileZoom: 0, maxAdditionalVertices: 1})).toThrow('budget');
        expect(() => refineGlobeMesh(vertices, new Uint16Array([0, 1]), layout, {tileZoom: 1})).toThrow('indices');
        expect(() => refineGlobeMesh(vertices, new Uint16Array([0, 1, 3]), layout, {tileZoom: 1})).toThrow('indices');
        expect(() => refineGlobeMesh(vertices.subarray(1), false, layout, {tileZoom: 1})).toThrow('layout');
    });
});

describe('globe mesh lifetime and style routing', () => {
    test('fine meshes cache a no-op, and source zoom 7 does not retain CPU buffers', () => {
        for (const tileZoom of [4, 7]) {
            const mesh = new VBOMesh(null, createVertices([[0, 0], [10, 0], [0, -10]]), false, layout, {
                globeRefinement: {tileZoom}, bufferFactory: () => ({destroy() {}} as Buffer)
            });
            const drawMesh = vi.fn((_options: {mesh: VBOMesh}) => false);
            const options = {projection: 'globe', meshRenderer: {drawMesh}};
            if (tileZoom === 7) expect(mesh.globe_source).toBeUndefined();
            mesh.render(options);
            mesh.render(options);
            expect(drawMesh.mock.calls.every(([call]) => call.mesh === mesh)).toBe(true);
            expect(mesh.globe_source).toBeUndefined();
            expect(mesh.globe_mesh).toBeFalsy();
            mesh.destroy();
        }
    });

    test('wireframe debug meshes remain line lists and are not fed to the triangle refiner', () => {
        const previousWireframe = debugSettings.wireframe;
        debugSettings.wireframe = true;
        try {
            const style = Object.assign(Object.create(Style), {
                name: 'polygons', shaders: {}, vertexLayoutForMeshVariant: () => layout,
                mesh_buffer_factory: () => ({destroy() {}})
            });
            const mesh = style.makeMesh(createVertices([[0, 0], [4096, 0], [0, -4096]]),
                new Uint16Array([0, 1, 2]), {tileZoom: 3});
            expect(mesh.getDrawDescriptor().topology).toBe('line-list');
            expect(mesh.globe_source).toBeUndefined();
            mesh.destroy();
        } finally {
            debugSettings.wireframe = previousWireframe;
        }
    });

    test('retains planar buffers, refines only once for both eyes and destroys both variants', () => {
        const resources: {destroy: ReturnType<typeof vi.fn>}[] = [];
        const mesh = new VBOMesh(null,
            createVertices([[0, 0], [4096, 0], [4096, -4096], [0, -4096]]), quadIndices, layout, {
                globeRefinement: {tileZoom: 4},
                bufferFactory() {
                    const resource = {destroy: vi.fn()};
                    resources.push(resource);
                    return resource as unknown as Buffer; // This lifetime-only fixture intentionally implements only destroy.
                }
            });
        const drawMesh = vi.fn((_options: {mesh: VBOMesh}) => false);
        const options = {meshRenderer: {drawMesh}};
        mesh.render({...options, projection: 'web-mercator'});
        expect(drawMesh.mock.calls[0][0].mesh).toBe(mesh);
        expect(resources).toHaveLength(2);
        mesh.render({...options, projection: 'globe'});
        const globe = drawMesh.mock.calls[1][0].mesh;
        expect(globe).not.toBe(mesh);
        expect(globe.geometry_count).toBeGreaterThan(mesh.geometry_count);
        expect(globe.created_at).toBe(mesh.created_at);
        mesh.render({...options, projection: 'globe'});
        expect(drawMesh.mock.calls[2][0].mesh).toBe(globe);
        expect(resources).toHaveLength(4);
        expect(mesh.globe_source).toBeUndefined();
        mesh.render({...options, projection: 'web-mercator'});
        expect(drawMesh.mock.calls[3][0].mesh).toBe(mesh);
        mesh.destroy();
        mesh.destroy();
        for (const resource of resources) expect(resource.destroy).toHaveBeenCalledTimes(1);
    });

    test('style routing uses source zoom and rejects post-projection position overrides only on globe', () => {
        const style = Object.assign(Object.create(Style), {
            name: 'custom-roads', base: 'lines', shaders: {blocks: {position: 'position.x += 1.;'}},
            vertexLayoutForMeshVariant: () => layout,
            mesh_buffer_factory: () => ({destroy() {}})
        });
        const mesh = style.makeMesh(createVertices([[0, 0], [4096, 0], [0, -4096]]), false, {tileZoom: 3});
        expect(mesh.globe_source.options.globeRefinement).toEqual({tileZoom: 3, tileScale: 4096});
        expect(() => mesh.render({projection: 'globe'})).toThrow('position shader block');
        const drawMesh = vi.fn(() => false);
        expect(() => mesh.render({projection: 'web-mercator', meshRenderer: {drawMesh}})).not.toThrow();
        mesh.destroy();
    });
});
