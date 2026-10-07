// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {buildPolylines} from '../src/builders/polylines';
import VertexLayout from '../src/gl/vertex_layout';
import {projectBasemapMesh, projectBasemapPosition} from '../src/experimental/projected-mesh';
import Geo from '../src/utils/geo';

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
        for (let index = 0; index < result.indices.length; index += 3) {
            const corners = [0, 1, 2].map(offset => positions[result.indices[index + offset]]);
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
