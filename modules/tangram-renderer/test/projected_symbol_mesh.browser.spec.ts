// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import VertexLayout from '../src/gl/vertex_layout';
import Geo from '../src/utils/geo';
import {projectBasemapMesh, projectBasemapMeshWithEngine} from '../src/experimental/projected-mesh';
import type {MeshProjectionRequest, ProjectedBasemapOptions} from '../src/procedures/mesh-projector';

const layout = new VertexLayout([
    {name: 'a_position', size: 4, type: 5122},
    {name: 'a_shape', size: 4, type: 5122},
    {name: 'a_texcoord', size: 2, type: 5123},
    {name: 'a_selection_color', size: 4, type: 5121},
    {name: 'a_projected_position', size: 3, type: 5126}
]);

/** One billboard quad with pixel shape, atlas coordinates and feature provenance. */
function request(type: ProjectedBasemapOptions['type'] = 'equal-earth'): MeshProjectionRequest {
    const vertices = new Uint8Array(layout.stride * 4);
    const view = new DataView(vertices.buffer);
    for (let index = 0; index < 4; index++) {
        const offset = index * layout.stride;
        view.setInt16(offset, 1024, true);
        view.setInt16(offset + 2, -1024, true);
        view.setInt16(offset + 6, 7, true);
        view.setInt16(offset + layout.offset.a_shape, index % 2 ? 100 : -100, true);
        view.setInt16(offset + layout.offset.a_shape + 6, 256, true);
        view.setUint16(offset + layout.offset.a_texcoord, index * 100, true);
        vertices.set([1, 2, 3, 4], offset + layout.offset.a_selection_color);
    }
    return {vertices, indices: new Uint16Array([0, 1, 2, 2, 1, 3]), layout, geometry: 'points',
        tile: {coords: {z: 6}, min: Geo.metersForTile({x: 14, y: 24, z: 6})},
        projection: {type, maxAngularSpan: 1, maxAdditionalVertices: 0}};
}

test.each(['equal-earth', 'albers', 'equirectangular', 'mercator', 'web-mercator'] as const)(
    '%s projects only deduplicated ground anchors, preserving atlas topology and pixel shapes', async type => {
        const input = request(type);
        const original = input.vertices.slice();
        const local = projectBasemapMesh(input);
        const projectPositions = vi.fn(async (coordinates: Float64Array) => {
            expect(coordinates).toHaveLength(2);
            return new Float64Array([10, 20]);
        });
        const host = await projectBasemapMeshWithEngine({...input, geometry: 'text', projectPositions});
        expect(projectPositions).toHaveBeenCalledOnce();
        expect(host.indices).toEqual(input.indices);
        expect(local.vertices.byteLength).toBe(original.byteLength);
        expect(input.vertices).toEqual(original);
        for (let index = 0; index < 4; index++) {
            const offset = index * layout.stride;
            expect(host.vertices.slice(offset, offset + layout.offset.a_projected_position)).toEqual(
                original.slice(offset, offset + layout.offset.a_projected_position));
            const view = new DataView(host.vertices.buffer);
            expect(view.getFloat32(offset + layout.offset.a_projected_position, true)).toBe(10);
            expect(view.getFloat32(offset + layout.offset.a_projected_position + 4, true)).toBe(20);
            expect(view.getFloat32(offset + layout.offset.a_projected_position + 8, true)).toBe(0);
        }
        expect([...new Float32Array(local.vertices.buffer)].every(Number.isFinite)).toBe(true);
    });

test('out-of-domain annotations hide their quads without changing indices or label byte ranges', async () => {
    const input = request('albers');
    input.tile.min.x = 0;
    const projectPositions = vi.fn(async () => new Float64Array());
    const result = await projectBasemapMeshWithEngine({...input, projectPositions});
    expect(projectPositions).not.toHaveBeenCalled();
    expect(result.indices).toEqual(input.indices);
    const view = new DataView(result.vertices.buffer);
    for (let index = 0; index < 4; index++) expect(view.getInt16(index * layout.stride + layout.offset.a_shape + 6, true)).toBe(0);
});

test('symbol validation rejects heights, invalid indices/layouts and bad host replies', async () => {
    const elevated = request();
    new DataView(elevated.vertices.buffer).setInt16(4, 1, true);
    expect(() => projectBasemapMesh(elevated)).toThrow('ground anchors');
    expect(() => projectBasemapMesh({...request(), indices: new Uint16Array([0, 1, 9])})).toThrow('triangle indices');
    expect(() => projectBasemapMesh({...request(), vertices: new Uint8Array(1)})).toThrow('billboard layout');
    for (const response of [new Float64Array([1]), new Float64Array([NaN, 2]), new Float64Array([Infinity, 2])]) {
        await expect(projectBasemapMeshWithEngine({...request(), projectPositions: async () => response})).rejects.toThrow('symbol-position batch');
    }
});
