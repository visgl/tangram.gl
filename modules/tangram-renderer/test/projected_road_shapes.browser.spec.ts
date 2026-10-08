// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {buildPolylines} from '../src/builders/polylines';
import VertexLayout from '../src/gl/vertex_layout';
import {projectBasemapMesh, projectBasemapPosition} from '../src/experimental/projected-mesh';
import Geo from '../src/utils/geo';

/** Check a common-coordinate probe against the actual projected triangle footprint. */
function coversProjectedPosition(positions: number[][], indices: Uint16Array | Uint32Array, point: readonly number[]): boolean {
    for (let index = 0; index < indices.length; index += 3) {
        const corners = [0, 1, 2].map(offset => positions[indices[index + offset]]);
        const area = (corners[1][0] - corners[0][0]) * (corners[2][1] - corners[0][1]) -
            (corners[1][1] - corners[0][1]) * (corners[2][0] - corners[0][0]);
        if (Math.abs(area) < 0.00000001) continue;
        const signs = corners.map((start, edge) => {
            const end = corners[(edge + 1) % 3];
            return (end[0] - start[0]) * (point[1] - start[1]) - (end[1] - start[1]) * (point[0] - start[0]);
        });
        if (signs.every(value => value >= -0.00001) || signs.every(value => value <= 0.00001)) return true;
    }
    return false;
}

test('high-latitude diagonal pixel roads use projected perpendiculars for widths and offsets', () => {
    const layout = new VertexLayout([
        {name: 'a_position', size: 4, type: 5122}, {name: 'a_extrude', size: 2, type: 5122},
        {name: 'a_offset', size: 2, type: 5122}, {name: 'a_z_and_offset_scale', size: 2, type: 5122},
        {name: 'a_projected_position', size: 3, type: 5126}, {name: 'a_projected_stroke', size: 4, type: 5126},
        {name: 'a_projected_normals', size: 4, type: 5126}, {name: 'a_projected_widths', size: 2, type: 5126}
    ]);
    const data = layout.createVertexData();
    const template = new Array(layout.index.a_projected_widths + 2).fill(0);
    template[layout.index.a_projected_stroke + 3] = 0.25;
    buildPolylines([[[1024, -1024], [3072, -3072]]],
        {width: 40, texcoord_width: 40, offset: 12, cap: 'butt', join: 'miter'}, data, template,
        {a_extrude: layout.index.a_extrude, a_offset: layout.index.a_offset, a_texcoord: null,
            a_projected_normals: layout.index.a_projected_normals, a_projected_widths: layout.index.a_projected_widths},
        false, false, 0);
    data.end();
    if (!data.element_buffer) throw new Error('Missing road geometry');
    const coords = {x: 4, y: 1, z: 4};
    const minimum = Geo.metersForTile(coords);
    const project = (x: number, y: number) => {
        const geographic = Geo.metersToLatLng([minimum.x + x / Geo.unitsPerMeter(coords.z), minimum.y + y / Geo.unitsPerMeter(coords.z)]);
        return projectBasemapPosition([geographic[0], geographic[1]], 'equirectangular');
    };
    const center = project(1024, -1024);
    // A local tangent, rather than the long curved segment's endpoint chord.
    const next = project(1025, -1025), previous = project(1023, -1023);
    const tangent = [next[0] - previous[0], next[1] - previous[1]];
    const length = Math.hypot(...tangent);
    const result = projectBasemapMesh({vertices: data.vertex_buffer, indices: data.element_buffer, layout,
        geometry: 'lines', tile: {coords, min: minimum}, projection: {type: 'equirectangular', maxAngularSpan: 30}});
    const output = new DataView(result.vertices.buffer, result.vertices.byteOffset, result.vertices.byteLength);
    const distances = [0, 1].map(index => {
        const offset = index * layout.stride + layout.offset.a_projected_position;
        const displacement = [output.getFloat32(offset, true) - center[0], output.getFloat32(offset + 4, true) - center[1]];
        expect(Math.abs((displacement[0] * tangent[0] + displacement[1] * tangent[1]) / length)).toBeLessThan(0.001);
        return (displacement[0] * -tangent[1] + displacement[1] * tangent[0]) / length;
    });
    expect(Math.abs(distances[0] - distances[1])).toBeCloseTo(10, 3);
    expect(Math.abs((distances[0] + distances[1]) / 2)).toBeCloseTo(3, 3);
});

test.each([
    ['butt', 'miter'], ['square', 'bevel'], ['round', 'round']
] as const)('projected builder output preserves %s caps, %s joins and the requested ribbon width', (cap, join) => {
    const layout = new VertexLayout([
        {name: 'a_position', size: 4, type: 5122},
        {name: 'a_extrude', size: 2, type: 5122},
        {name: 'a_offset', size: 2, type: 5122},
        {name: 'a_z_and_offset_scale', size: 2, type: 5122},
        {name: 'a_projected_position', size: 3, type: 5126}
    ]);
    const data = layout.createVertexData();
    // A right-angle road entirely inside one tile isolates real caps and joins
    // from seam clipping. The width is 256 tile units, with a 128-unit radius.
    buildPolylines([[[1024, -2048], [2048, -2048], [2048, -3072]]],
        {width: 256, texcoord_width: 256, offset: 0, cap, join}, data,
        new Array(layout.index.a_projected_position + 3).fill(0),
        {a_extrude: layout.index.a_extrude, a_offset: layout.index.a_offset, a_texcoord: null},
        false, false, 0);
    data.end();
    if (!data.element_buffer) throw new Error('Expected a built road');
    const coords = {x: 1, y: 1, z: 2};
    const minimum = Geo.metersForTile(coords);
    const result = projectBasemapMesh({vertices: data.vertex_buffer, indices: data.element_buffer, layout,
        geometry: 'lines', tile: {coords, min: minimum}, projection: {type: 'equirectangular'}});
    const output = new DataView(result.vertices.buffer, result.vertices.byteOffset, result.vertices.byteLength);
    const positions = Array.from({length: result.vertices.byteLength / layout.stride}, (_, index) =>
        [0, 1].map(component => output.getFloat32(index * layout.stride + layout.offset.a_projected_position + component * 4, true)));

    /** Test independently projected probes against the actual refined triangle footprint. */
    const coversPosition = (x: number, y: number) => {
        const geographic = Geo.metersToLatLng([minimum.x + x / Geo.unitsPerMeter(coords.z),
            minimum.y + y / Geo.unitsPerMeter(coords.z)]);
        const point = projectBasemapPosition([geographic[0], geographic[1]], 'equirectangular');
        return coversProjectedPosition(positions, result.indices, point);
    };
    // Both sides of a straight segment must have the requested half-width,
    // not a collapsed centerline or double-width extrusion.
    expect(coversPosition(1500, -2048 + 120)).toBe(true);
    expect(coversPosition(1500, -2048 - 120)).toBe(true);
    expect(coversPosition(1500, -2048 + 140)).toBe(false);
    expect(coversPosition(1500, -2048 - 140)).toBe(false);
    // Butt has no extension; round admits the radial probe but not the
    // square corner. Square admits both. Check both endpoints separately.
    for (const [x, y] of [[1024 - 80, -2048 + 80], [2048 + 80, -3072 - 80]]) {
        expect(coversPosition(x, y)).toBe(cap !== 'butt');
    }
    for (const [x, y] of [[1024 - 110, -2048 + 110], [2048 + 110, -3072 - 110]]) {
        expect(coversPosition(x, y)).toBe(cap === 'square');
    }
    // Distinguish the outer miter corner, rounded arc and bevel chord.
    expect(coversPosition(2048 + 110, -2048 + 110)).toBe(join === 'miter');
    expect(coversPosition(2048 + 80, -2048 + 80)).toBe(join !== 'bevel');
    expect(coversPosition(2048 + 50, -2048 + 50)).toBe(true);
});

test.each([
    ['butt', 'miter'], ['square', 'bevel'], ['round', 'round']
] as const)('high-latitude pixel roads preserve %s caps and %s joins after tangent reorientation', (cap, join) => {
    const layout = new VertexLayout([
        {name: 'a_position', size: 4, type: 5122}, {name: 'a_extrude', size: 2, type: 5122},
        {name: 'a_offset', size: 2, type: 5122}, {name: 'a_z_and_offset_scale', size: 2, type: 5122},
        {name: 'a_projected_position', size: 3, type: 5126}, {name: 'a_projected_stroke', size: 4, type: 5126},
        {name: 'a_projected_normals', size: 4, type: 5126}, {name: 'a_projected_widths', size: 2, type: 5126}
    ]);
    const data = layout.createVertexData();
    const template = new Array(layout.index.a_projected_widths + 2).fill(0);
    const pixelScale = 0.04;
    const radius = 128 * pixelScale;
    template[layout.index.a_projected_stroke + 3] = pixelScale;
    buildPolylines([[[1024, -2048], [2048, -2048], [2048, -3072]]],
        {width: 256, texcoord_width: 256, offset: 0, cap, join}, data, template,
        {a_extrude: layout.index.a_extrude, a_offset: layout.index.a_offset, a_texcoord: null,
            a_projected_normals: layout.index.a_projected_normals, a_projected_widths: layout.index.a_projected_widths},
        false, false, 0);
    data.end();
    if (!data.element_buffer) throw new Error('Expected a built pixel road');
    const coords = {x: 1, y: 0, z: 2};
    const minimum = Geo.metersForTile(coords);
    const project = (x: number, y: number) => {
        const geographic = Geo.metersToLatLng([minimum.x + x / Geo.unitsPerMeter(coords.z),
            minimum.y + y / Geo.unitsPerMeter(coords.z)]);
        return projectBasemapPosition([geographic[0], geographic[1]], 'equirectangular');
    };
    const result = projectBasemapMesh({vertices: data.vertex_buffer, indices: data.element_buffer, layout,
        geometry: 'lines', tile: {coords, min: minimum}, projection: {type: 'equirectangular'}});
    const output = new DataView(result.vertices.buffer, result.vertices.byteOffset, result.vertices.byteLength);
    const positions = Array.from({length: result.vertices.byteLength / layout.stride}, (_, index) =>
        [0, 1].map(component => output.getFloat32(index * layout.stride + layout.offset.a_projected_position + component * 4, true)));
    // Equirectangular keeps these axis-aligned tangents, but dramatically changes
    // their relative scale here. Probes use authored pixel radius in the projected
    // plane, not projected source normals or source-space stroke corners.
    const covers = (center: readonly number[], x: number, y: number) => coversProjectedPosition(
        positions, result.indices, [center[0] + x * radius, center[1] + y * radius]);
    const horizontal = project(1536, -2048), vertical = project(2048, -2560);
    for (const side of [-1, 1]) {
        expect(covers(horizontal, 0, side * 0.9)).toBe(true);
        expect(covers(horizontal, 0, side * 1.1)).toBe(false);
        expect(covers(vertical, side * 0.9, 0)).toBe(true);
        expect(covers(vertical, side * 1.1, 0)).toBe(false);
    }
    expect(covers(project(1024, -2048), -0.6, 0.6)).toBe(cap !== 'butt');
    expect(covers(project(1024, -2048), -0.85, 0.85)).toBe(cap === 'square');
    expect(covers(project(2048, -3072), 0.6, -0.6)).toBe(cap !== 'butt');
    expect(covers(project(2048, -3072), 0.85, -0.85)).toBe(cap === 'square');
    const corner = project(2048, -2048);
    expect(covers(corner, 0.85, 0.85)).toBe(join === 'miter');
    expect(covers(corner, 0.6, 0.6)).toBe(join !== 'bevel');
    expect(covers(corner, 0.3, 0.3)).toBe(true);
});
