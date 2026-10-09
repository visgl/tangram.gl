// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import VertexLayout from '../src/gl/vertex_layout';
import Geo from '../src/utils/geo';
import {projectBasemapMesh, projectBasemapMeshWithEngine, projectBasemapPosition} from '../src/experimental/projected-mesh';
import {projectSurfaceNormal} from '../src/experimental/projected-normal';
import {PROJECTED_COMMON_SCALE} from '../src/procedures/projected-coordinate-transform';
import {clipProjectedMesh} from '../src/experimental/projected-mesh-domain';
import {selectTrianglePlane} from '../src/gl/globe_mesh';
import {PACKED_HEIGHT_SCALE} from '../src/gl/vertex-constants';
import type {MeshProjectionRequest, ProjectedBasemapOptions} from '../src/procedures/mesh-projector';

const layout = new VertexLayout([
    {name: 'a_position', size: 4, type: 5122},
    {name: 'a_normal', size: 3, type: 5120, normalized: true},
    {name: 'a_selection_color', size: 4, type: 5121},
    {name: 'a_projected_position', size: 3, type: 5126},
    {name: 'a_projected_normal', size: 3, type: 5126}
]);

test('worker height packing shares the renderer builder scale without importing the Geo namespace', () => {
    expect(PACKED_HEIGHT_SCALE).toBe(16);
    expect(Geo.height_scale).toBe(PACKED_HEIGHT_SCALE);
});

/** Vertical wall with physical height and immutable packed feature identity. */
function createWall(type: ProjectedBasemapOptions['type']): MeshProjectionRequest {
    const coords = {x: 14, y: 23, z: 6};
    const vertices = new Uint8Array(layout.stride * 4);
    const view = new DataView(vertices.buffer);
    [[0, 0, -16], [4096, 0, -16], [4096, 0, 1600], [0, 0, 1600]].forEach((position, index) => {
        position.forEach((value, component) => view.setInt16(index * layout.stride + component * 2, value, true));
        view.setInt16(index * layout.stride + 6, 4, true);
        view.setInt8(index * layout.stride + layout.offset.a_normal + 1, -127);
        vertices.set([1, 2, 3, 4], index * layout.stride + layout.offset.a_selection_color);
    });
    return {vertices, indices: new Uint16Array([0, 1, 2, 0, 2, 3]), layout, geometry: 'polygons',
        tile: {coords, min: Geo.metersForTile(coords)}, projection: {type, allowElevation: true, maxProjectedError: 0.001}};
}

test.each(['equal-earth', 'albers', 'equirectangular', 'mercator', 'web-mercator'] as const)(
    '%s preserves physical height, normal orthogonality and local/host conformance through refinement', async type => {
        const request = createWall(type), original = request.vertices.slice();
        const result = projectBasemapMesh(request);
        const remote = await projectBasemapMeshWithEngine({...request, projectPositions: async coordinates => {
            const positions = new Float64Array(coordinates.length);
            for (let offset = 0; offset < coordinates.length; offset += 2) {
                const point = projectBasemapPosition([coordinates[offset], coordinates[offset + 1]], type);
                positions[offset] = point[0]; positions[offset + 1] = point[1];
            }
            return positions;
        }});
        expect(remote).toEqual(result);
        expect(request.vertices).toEqual(original);
        expect(result.vertices.byteLength).toBeGreaterThan(request.vertices.byteLength);
        const output = new DataView(result.vertices.buffer);
        for (let offset = 0; offset < result.vertices.length; offset += layout.stride) {
            const height = output.getInt16(offset + 4, true) / Geo.height_scale;
            expect(output.getFloat32(offset + layout.offset.a_projected_position + 8, true)).toBeCloseTo(height * PROJECTED_COMMON_SCALE, 9);
            const normal = [0, 1, 2].map(component => output.getFloat32(offset + layout.offset.a_projected_normal + component * 4, true));
            expect(Math.hypot(...normal)).toBeCloseTo(1, 6);
            const geographic = Geo.metersToLatLng([request.tile.min.x + output.getInt16(offset, true) / Geo.unitsPerMeter(6), request.tile.min.y]);
            const left = projectBasemapPosition([geographic[0] - 0.0001, geographic[1]], type);
            const right = projectBasemapPosition([geographic[0] + 0.0001, geographic[1]], type);
            const tangent = [right[0] - left[0], right[1] - left[1]];
            expect(Math.abs((normal[0] * tangent[0] + normal[1] * tangent[1]) / Math.hypot(...tangent))).toBeLessThan(0.002);
            expect([...result.vertices.subarray(offset + layout.offset.a_selection_color, offset + layout.offset.a_selection_color + 4)]).toEqual([1, 2, 3, 4]);
        }
        expect(() => projectBasemapMesh({...request, projection: {type}})).toThrow('allowElevation');
    });

test('inverse-transpose handles shear, anisotropic scale, roof and sloped normals', () => {
    const shear = projectSurfaceNormal([1, 0, 0], [1, 0], [1, 1]);
    expect(shear[0]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(shear[1]).toBeCloseTo(-Math.SQRT1_2, 12);
    expect(shear[2]).toBe(0);
    expect(projectSurfaceNormal([0, 0, 1], [1, 0], [0, 2])).toEqual([0, 0, 1]);
    const slope = projectSurfaceNormal([1, 0, 1], [2 * PROJECTED_COMMON_SCALE, 0], [0, PROJECTED_COMMON_SCALE]);
    expect(slope[0] / slope[2]).toBeCloseTo(0.5, 10);
    for (const east of [[0, 0], [NaN, 1], [0, 1]] as const) {
        expect(() => projectSurfaceNormal([1, 0, 0], east, [0, 1])).toThrow('Jacobian');
    }
    expect(() => projectSurfaceNormal([0, 0, 0], [1, 0], [0, 1])).toThrow('nonzero');
});

test('topology checks choose XY roofs, XZ walls and YZ walls without changing orientation', () => {
    expect(selectTrianglePlane([[0, 0, 10], [20, 0, 10], [20, 30, 10]])).toEqual([0, 1]);
    expect(selectTrianglePlane([[0, 0, 0], [20, 0, 0], [20, 0, 30]])).toEqual([0, 2]);
    expect(selectTrianglePlane([[0, 0, 0], [0, 20, 0], [0, 20, 30]])).toEqual([1, 2]);
});

test.each(['polygons', 'raster'] as const)('%s rejects invalid normal layouts and preserves elevated output', geometry => {
    const request = {...createWall('equirectangular'), geometry};
    expect(projectBasemapMesh(request).vertices.length).toBeGreaterThan(0);
    const invalidLayout = new VertexLayout(layout.attribs.map(attribute =>
        ({...attribute, size: attribute.name === 'a_projected_normal' ? 2 : attribute.size})));
    expect(() => projectBasemapMesh({...request, layout: invalidLayout})).toThrow('projected normal layout');
    const invalidPacked = new VertexLayout(layout.attribs.map(attribute =>
        ({...attribute, type: attribute.name === 'a_normal' ? 5126 : attribute.type})));
    expect(() => projectBasemapMesh({...request, layout: invalidPacked})).toThrow('packed surface normal');
});

test('domain clipping retains vertical walls and interpolates height instead of dropping zero-XY-area triangles', () => {
    const request = createWall('equirectangular');
    request.tile.min.x = Geo.half_circumference_meters;
    const input = new DataView(request.vertices.buffer);
    [0, 1, 2, 3].forEach(index => input.setInt16(index * layout.stride, index === 0 || index === 3 ? -200 : 200, true));
    const clipped = clipProjectedMesh({vertices: request.vertices, indices: new Uint16Array([0, 1, 2, 0, 2, 3])}, request,
        vertex => [vertex.getInt16(0, true), vertex.getInt16(2, true)], 64);
    expect(clipped.indices.length).toBeGreaterThan(0);
    const output = new DataView(clipped.vertices.buffer);
    for (let offset = 0; offset < clipped.vertices.length; offset += layout.stride) {
        expect(output.getInt16(offset, true)).toBeLessThanOrEqual(0);
        expect(output.getInt16(offset + 4, true)).toBeGreaterThanOrEqual(-16);
        expect(output.getInt16(offset + 4, true)).toBeLessThanOrEqual(1600);
    }
});
