// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test, vi} from 'vitest';
import {Style} from '../src/styles/style';
import {projectBasemapMesh, projectBasemapMeshWithEngine, projectBasemapPosition} from '../src/experimental/projected-mesh';
import {HostProjectionEngineAdapter} from '../src/procedures/projected-coordinate-transform';
import {createProjectionEngine} from '@math.gl/projection/core';
import {equalEarth} from '@math.gl/projection/projections/eqearth';
import {albersEqualArea} from '@math.gl/projection/projections/aea';
import {equidistantCylindrical} from '@math.gl/projection/projections/eqc';
import {mercator} from '@math.gl/projection/projections/merc';
import {normalizeProjectedBasemapOptions, projectTileMesh, registerMeshProjector} from '../src/procedures/mesh-projector';
import type {MeshProjectionRequest, ProjectedBasemapOptions} from '../src/procedures/mesh-projector';
import VertexLayout from '../src/gl/vertex_layout';
import Geo from '../src/utils/geo';
import {buildPolygonsWGSL} from '../src/styles/polygons/polygons_wgsl';
import {StyleManager} from '../src/styles/style_manager';
import {buildLinesWGSL} from '../src/styles/lines/lines_wgsl';

const layout = new VertexLayout([
    {name: 'a_position', size: 4, type: 5122},
    {name: 'a_color', size: 4, type: 5121},
    {name: 'a_selection_color', size: 4, type: 5121},
    {name: 'a_texcoord', size: 2, type: 5123},
    {name: 'a_projected_position', size: 3, type: 5126}
]);
const projections: ProjectedBasemapOptions['type'][] = ['equal-earth', 'albers', 'equirectangular', 'mercator', 'web-mercator'];

/** A buffered tile quad with nonzero byte offset, exact selection bytes, original UVs and layer order. */
function createRequest(type: ProjectedBasemapOptions['type'], x = 2): MeshProjectionRequest {
    const coords = type === 'albers' ? {x: x + 20, y: 20, z: 6} : {x, y: 1, z: 2};
    const vertices = new Uint8Array(new ArrayBuffer(layout.stride * 4 + 16), 8, layout.stride * 4);
    const view = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength);
    [[0, 0], [4096, 0], [4096, -4096], [0, -4096]].forEach(([localX, localY], index) => {
        const offset = index * layout.stride;
        [localX, localY, 0, 5].forEach((value, component) => view.setInt16(offset + component * 2, value, true));
        vertices.set([10, 20, 30, 255], offset + layout.offset.a_color);
        vertices.set([1, 2, 3, 4], offset + layout.offset.a_selection_color);
        view.setUint16(offset + layout.offset.a_texcoord, localX ? 65535 : 0, true);
        view.setUint16(offset + layout.offset.a_texcoord + 2, localY ? 65535 : 0, true);
    });
    return {vertices, indices: new Uint16Array([0, 1, 2, 0, 2, 3]), layout,
        tile: {min: Geo.metersForTile(coords), coords}, projection: {type}};
}

describe('opt-in worker CPU projection', () => {
    test.each(projections)('%s adaptive chord refinement is identical with a caller engine and respects budgets', async type => {
        const request = createRequest(type);
        request.projection = {type, maxAngularSpan: 30, maxProjectedError: 0.05};
        const engine = new HostProjectionEngineAdapter(createProjectionEngine({
            projections: [equalEarth, albersEqualArea, equidistantCylindrical, mercator]}));
        const coarse = projectBasemapMesh({...request, projection: {type, maxAngularSpan: 30}});
        const refined = projectBasemapMesh(request);
        const remote = await projectBasemapMeshWithEngine({...request,
            projectPositions: coordinates => engine.projectPositions(coordinates, type)});
        expect(remote).toEqual(refined);
        expect(refined.vertices.byteLength).toBeGreaterThanOrEqual(coarse.vertices.byteLength);
        expect(request.vertices.byteLength).toBe(layout.stride * 4);
        if (type === 'equal-earth' || type === 'albers' || type === 'equirectangular') expect(refined.vertices.byteLength).toBeGreaterThan(coarse.vertices.byteLength);
        expect(() => projectBasemapMesh({...request, projection: {...request.projection,
            maxProjectedError: 1e-12, maxAdditionalVertices: 0}})).toThrow(/budget|precision/);
    });
    test.each([0, -1, Infinity, NaN])('rejects invalid adaptive tolerance %s', maxProjectedError => {
        expect(() => normalizeProjectedBasemapOptions({type: 'equal-earth', maxProjectedError})).toThrow('projected error');
    });
    test('independent equal-detail tile seams have identical adaptive projected boundary vertices', () => {
        const first = createRequest('equal-earth', 1), second = createRequest('equal-earth', 2);
        first.projection.maxProjectedError = second.projection.maxProjectedError = 0.02;
        const boundary = (request: MeshProjectionRequest, x: number) => {
            const result = projectBasemapMesh(request);
            const view = new DataView(result.vertices.buffer, result.vertices.byteOffset, result.vertices.byteLength);
            const points = new Set<string>();
            for (let offset = 0; offset < result.vertices.length; offset += layout.stride) {
                if (view.getInt16(offset, true) === x) points.add([
                    view.getFloat32(offset + layout.offset.a_projected_position, true),
                    view.getFloat32(offset + layout.offset.a_projected_position + 4, true)].join(','));
            }
            return [...points].sort();
        };
        expect(boundary(first, 4096)).toEqual(boundary(second, 0));
    });
    test.each(projections)('%s host-engine batches produce byte-identical refined meshes', async type => {
        const request = createRequest(type);
        const original = request.vertices.slice();
        const engine = new HostProjectionEngineAdapter(createProjectionEngine({
            projections: [equalEarth, albersEqualArea, equidistantCylindrical, mercator]}));
        let batches = 0;
        const remote = await projectBasemapMeshWithEngine({...request, projectPositions: coordinates => {
            batches++;
            return engine.projectPositions(coordinates, type);
        }});
        const local = projectBasemapMesh(request);
        expect(remote).toEqual(local);
        expect(batches).toBe(1);
        expect(request.vertices).toEqual(original);
    });

    test.each([new Float64Array(0), new Float64Array([NaN, 0]), new Float64Array([1e50, 0])])(
        'rejects malformed host-engine response batches', async result => {
            await expect(projectBasemapMeshWithEngine({...createRequest('equal-earth'),
                projectPositions: async coordinates => result.length ? new Float64Array(coordinates.length).fill(result[0]) : result}))
                .rejects.toThrow('invalid common-position batch');
        }
    );

    test('propagates host-engine errors and rejects a missing callback', async () => {
        await expect(projectBasemapMeshWithEngine({...createRequest('equal-earth'),
            projectPositions: async () => {throw new Error('engine unavailable');}})).rejects.toThrow('engine unavailable');
        await expect(projectBasemapMeshWithEngine(createRequest('equal-earth'))).rejects.toThrow('host batch callback');
    });
    test.each(projections)('%s projects refined ribbon corners, preserving centerlines, widths and ordering', type => {
        const ribbonLayout = new VertexLayout([
            {name: 'a_position', size: 4, type: 5122},
            {name: 'a_extrude', size: 2, type: 5122},
            {name: 'a_offset', size: 2, type: 5122},
            {name: 'a_z_and_offset_scale', size: 2, type: 5122},
            {name: 'a_color', size: 4, type: 5121},
            {name: 'a_projected_position', size: 3, type: 5126}
        ]);
        const coords = type === 'albers' ? {x: 20, y: 20, z: 6} : {x: 1, y: 1, z: 2};
        const vertices = new Uint8Array(ribbonLayout.stride * 4);
        const input = new DataView(vertices.buffer);
        [[0, 0, 128], [4096, -4096, 128], [4096, -4096, -128], [0, 0, -128]].forEach(([x, y, extrusion], index) => {
            const offset = index * ribbonLayout.stride;
            [x, y, 0, 7, extrusion, extrusion].forEach((value, component) => input.setInt16(offset + component * 2, value, true));
            vertices.set([200, 150, 100, 255], offset + ribbonLayout.offset.a_color);
        });
        const before = vertices.slice();
        const request: MeshProjectionRequest = {vertices, indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
            layout: ribbonLayout, tile: {coords, min: Geo.metersForTile(coords), overzoom2: 4}, geometry: 'lines', projection: {type}};
        const result = projectBasemapMesh(request);
        expect(vertices).toEqual(before);
        expect(result.vertices.byteLength).toBeGreaterThan(before.byteLength);
        const neighbor = vertices.slice();
        const neighborView = new DataView(neighbor.buffer);
        for (let offset = 0; offset < neighbor.byteLength; offset += ribbonLayout.stride) {
            neighborView.setInt16(offset, neighborView.getInt16(offset, true) - 4096, true);
        }
        // The same buffered ribbon expressed in the neighboring tile must land
        // on identical ground corners and refine identically across the seam.
        const adjacent = projectBasemapMesh({...request, vertices: neighbor, tile: {...request.tile,
            min: Geo.metersForTile({...coords, x: coords.x + 1})}});
        expect(adjacent.indices).toEqual(result.indices);
        const adjacentView = new DataView(adjacent.vertices.buffer);
        const output = new DataView(result.vertices.buffer);
        for (let offset = 0; offset < output.byteLength; offset += ribbonLayout.stride) {
            const x = output.getInt16(offset, true) + output.getInt16(offset + ribbonLayout.offset.a_extrude, true) / 4;
            const y = output.getInt16(offset + 2, true) + output.getInt16(offset + ribbonLayout.offset.a_extrude + 2, true) / 4;
            const geographic = Geo.metersToLatLng([request.tile.min.x + x / Geo.unitsPerMeter(coords.z),
                request.tile.min.y + y / Geo.unitsPerMeter(coords.z)]);
            const expected = projectBasemapPosition([geographic[0], geographic[1]], type);
            expected.forEach((value, component) => expect(output.getFloat32(offset + ribbonLayout.offset.a_projected_position + component * 4, true)).toBeCloseTo(value, 4));
            expected.forEach((value, component) => expect(adjacentView.getFloat32(offset + ribbonLayout.offset.a_projected_position + component * 4, true)).toBeCloseTo(value, 4));
            expect(output.getInt16(offset + 6, true)).toBe(7);
        }
        // Original packed centerline/extrusion attributes stay at their original indices.
        for (let index = 0; index < 4; index++) expect(result.vertices.subarray(index * ribbonLayout.stride,
            index * ribbonLayout.stride + ribbonLayout.offset.a_projected_position))
            .toEqual(before.subarray(index * ribbonLayout.stride, index * ribbonLayout.stride + ribbonLayout.offset.a_projected_position));
        expect(() => projectBasemapMesh({...request, tile: {...request.tile, overzoom2: NaN}})).toThrow('overzoom');
        expect(() => projectBasemapMesh({...request, projection: {type, maxAdditionalVertices: 0}})).toThrow('budget');
        input.setInt16(ribbonLayout.offset.a_z_and_offset_scale, 1, true);
        expect(() => projectBasemapMesh(request)).toThrow('elevation');
    });

    test('only opt-in line shaders consume CPU-projected positions and WebGPU clip depth', () => {
        const shader = buildLinesWGSL({cpuProjection: true});
        expect(shader).toContain('@location(6) a_projected_position');
        expect(shader).toContain('vec4<f32>(attributes.a_projected_position, 1.0)');
        expect(shader).toContain('clip_position.z = (clip_position.z + clip_position.w) * 0.5;');
        expect(buildLinesWGSL()).not.toContain('a_projected_position');
        const manager = new StyleManager();
        manager.build({});
        manager.initStyles({config: {scene: {cpu_projection: {type: 'equal-earth'}}}});
        expect(manager.styles.lines).toMatchObject({defines: {TANGRAM_CPU_PROJECTED: true}});
        manager.initStyles({config: {scene: {}}});
        expect(manager.styles.lines).toMatchObject({defines: {TANGRAM_CPU_PROJECTED: false}});
    });

    test.each(projections)('%s refines a mesh, preserves originals and computes every projected vertex', type => {
        const request = createRequest(type);
        const original = request.vertices.slice();
        const result = projectBasemapMesh(request);
        expect(request.vertices).toEqual(original);
        expect(result.vertices.length).toBeGreaterThan(original.length);
        expect(result.indices.length).toBeGreaterThan(6);
        const view = new DataView(result.vertices.buffer, result.vertices.byteOffset, result.vertices.byteLength);
        const scale = Geo.unitsPerMeter(request.tile.coords.z);
        for (let offset = 0; offset < result.vertices.length; offset += layout.stride) {
            const x = view.getInt16(offset, true), y = view.getInt16(offset + 2, true);
            const geographic = Geo.metersToLatLng([request.tile.min.x + x / scale, request.tile.min.y + y / scale]);
            const expected = projectBasemapPosition([geographic[0], geographic[1]], type);
            expected.forEach((value, component) => expect(view.getFloat32(offset + layout.offset.a_projected_position + 4 * component, true)).toBeCloseTo(value, 4));
            expect(view.getInt16(offset + 6, true)).toBe(5);
            expect([...result.vertices.subarray(offset + layout.offset.a_selection_color, offset + layout.offset.a_selection_color + 4)]).toEqual([1, 2, 3, 4]);
            expect(view.getUint16(offset + layout.offset.a_texcoord, true) / 65535).toBeCloseTo(x / 4096, 3);
            expect(view.getUint16(offset + layout.offset.a_texcoord + 2, true) / 65535).toBeCloseTo(-y / 4096, 3);
        }
    });

    test.each(projections)('%s adjacent tiles agree on every refined boundary point', type => {
        const first = projectBasemapMesh(createRequest(type, 1));
        const second = projectBasemapMesh(createRequest(type, 2));
        const readEdge = (vertices: Uint8Array, localX: number) => {
            const view = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength);
            const points = new Map<number, number[]>();
            for (let offset = 0; offset < vertices.length; offset += layout.stride) {
                if (view.getInt16(offset, true) === localX) points.set(view.getInt16(offset + 2, true),
                    [0, 1, 2].map(component => view.getFloat32(offset + layout.offset.a_projected_position + component * 4, true)));
            }
            return [...points.entries()].sort(([a], [b]) => a - b);
        };
        expect(readEdge(first.vertices, 4096)).toEqual(readEdge(second.vertices, 0));
    });

    test('uses analytic equirectangular axes and the fixed Albers origin', () => {
        const point = projectBasemapPosition([90, 45], 'equirectangular');
        expect(point[0]).toBeCloseTo(128 * Math.PI, 10);
        expect(point[1]).toBeCloseTo(64 * Math.PI, 10);
        expect(point[2]).toBe(0);
        expect(projectBasemapPosition([-96, 37.5], 'albers')[0]).toBeCloseTo(0, 10);
        expect(projectBasemapPosition([-96, 37.5], 'albers')[1]).toBeCloseTo(0, 10);
        expect(projectBasemapPosition([0, 0], 'equal-earth')).toEqual([0, 0, 0]);
    });

    test('validates domains and bounded refinement, rejecting unsupported height', () => {
        expect(() => projectBasemapPosition([181, 0], 'equal-earth')).toThrow('domain');
        expect(() => projectBasemapPosition([0, 90], 'equal-earth')).toThrow('domain');
        expect(() => projectBasemapPosition([NaN, 0], 'albers')).toThrow('domain');
        const request = createRequest('equal-earth');
        expect(() => projectBasemapMesh({...request, projection: {type: 'equal-earth', maxAdditionalVertices: 0}})).toThrow('budget');
        new DataView(request.vertices.buffer, request.vertices.byteOffset).setInt16(4, 16, true);
        expect(() => projectBasemapMesh(request)).toThrow('elevation');
        expect(() => projectBasemapMesh({...request, tile: {...request.tile, min: {x: Infinity, y: 0}}})).toThrow('metadata');
    });

    test.each([null, {type: 'unknown'}, {type: 'equal-earth', maxAngularSpan: 0},
        {type: 'albers', maxAdditionalVertices: -1}, {type: 'albers', maxAdditionalVertices: 262145}])('rejects invalid serialized options %j', options => {
        expect(() => normalizeProjectedBasemapOptions(options)).toThrow('CPU projection');
    });

    test('requires explicit worker registration instead of silently using the classic projector', () => {
        const request = createRequest('equirectangular');
        expect(() => projectTileMesh(request)).toThrow('worker script');
        registerMeshProjector(projectBasemapMesh);
        expect(projectTileMesh(request)).toEqual(projectBasemapMesh(request));
        expect(() => registerMeshProjector(projectBasemapMesh)).toThrow('already registered');
    });

    test('fully clipped style meshes skip raster texture acquisition and GPU transfer', async () => {
        const request = createRequest('equirectangular', 5);
        const buildRasterTextures = vi.fn();
        const style = {tile_data: {1: {meshes: {ground: {
            variant: {}, vertex_elements: request.indices,
            vertex_data: {vertex_count: 4, end: () => {}, vertex_buffer: request.vertices, element_buffer: request.indices}
        }}}}, cpu_projection: request.projection, baseStyle: () => 'raster',
        vertexLayoutForMeshVariant: () => layout, buildRasterTextures};
        expect(await Style.endData.call(style, {...request.tile, id: 1})).toBeNull();
        expect(buildRasterTextures).not.toHaveBeenCalled();
    });

    test.each([-80, -45, 0, 45, 80, 85.0511287798066])('Mercator variants follow their analytic equations at latitude %s', latitude => {
        const radians = latitude * Math.PI / 180;
        const eccentricity = Math.sqrt(0.0066943799901413165);
        const sphericalY = 256 * Math.asinh(Math.tan(radians));
        const ellipsoidalY = sphericalY - 256 * eccentricity * Math.atanh(eccentricity * Math.sin(radians));
        const web = projectBasemapPosition([90, latitude], 'web-mercator');
        const ellipsoidal = projectBasemapPosition([90, latitude], 'mercator');
        expect(web[0]).toBeCloseTo(128 * Math.PI, 10);
        expect(ellipsoidal[0]).toBeCloseTo(web[0], 10);
        expect(web[1]).toBeCloseTo(sphericalY, 10);
        expect(ellipsoidal[1]).toBeCloseTo(ellipsoidalY, 10);
        expect(web[2]).toBe(0);
        expect(ellipsoidal[2]).toBe(0);
        expect(web[1]).toBeCloseTo(Geo.latLngToMeters([90, latitude])[1] * 256 / 6378137, 10);
    });

    test.each(['mercator', 'web-mercator'] as const)('%s keeps both world-edge meridians distinct and rejects polar coordinates', type => {
        expect(projectBasemapPosition([-180, 0], type)[0]).toBeCloseTo(-256 * Math.PI, 10);
        expect(projectBasemapPosition([180, 0], type)[0]).toBeCloseTo(256 * Math.PI, 10);
        expect(() => projectBasemapPosition([0, 90], type)).toThrow('domain');
        expect(() => projectBasemapPosition([0, -90], type)).toThrow('domain');
    });

    test('portable shaders consume projected positions but retain original raster UV input', () => {
        const projected = buildPolygonsWGSL({raster: true, cpuProjection: true});
        expect(projected).toContain('@location(3) a_projected_position');
        expect(projected).toContain('vec4<f32>(attributes.a_projected_position, 1.0)');
        expect(projected).toContain('clip_position.z = (clip_position.z + clip_position.w) * 0.5;');
        expect(projected).toContain('f32(attributes.a_position.x)');
        expect(buildPolygonsWGSL()).not.toContain('a_projected_position');
    });

    test('empty normalized shader blocks are supported and classic lighting survives scene reload', () => {
        const manager = new StyleManager();
        manager.build({});
        manager.initStyles({config: {scene: {cpu_projection: {type: 'equal-earth'}}}});
        expect(manager.styles.polygons).toMatchObject({defines: {TANGRAM_CPU_PROJECTED: true,
            TANGRAM_LIGHTING_VERTEX: false, TANGRAM_LIGHTING_FRAGMENT: false}});
        manager.initStyles({config: {scene: {}}});
        expect(manager.styles.polygons).toMatchObject({defines: {TANGRAM_CPU_PROJECTED: false}, cpu_projection: undefined});
    });
});
