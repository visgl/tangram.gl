// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {interpolatePackedVertex} from '../gl/globe_mesh';
import type {MeshProjectionRequest, ProjectedMesh} from '../procedures/mesh-projector';

/** Geographic latitude limit of the source Web Mercator tile world. */
export const PROJECTED_TILE_LATITUDE = 85.0511287798066;
/** Half the width of one EPSG:3857 world, in meters. */
const WORLD_HALF_WIDTH = Math.PI * 6378137;

/** World bounds for continuous projections, with the preview's explicit Albers region. */
export function getProjectedSourceDomain(type: MeshProjectionRequest['projection']['type']): readonly [number, number, number, number] {
    if (type === 'albers') {
        const latitudeToMeters = (latitude: number) => 6378137 * Math.asinh(Math.tan(latitude * Math.PI / 180));
        return [-170 / 180 * WORLD_HALF_WIDTH, latitudeToMeters(5),
            -40 / 180 * WORLD_HALF_WIDTH, latitudeToMeters(75)];
    }
    return [-WORLD_HALF_WIDTH, -WORLD_HALF_WIDTH, WORLD_HALF_WIDTH, WORLD_HALF_WIDTH];
}

/** Clip triangles before nonlinear projection, retaining winding, UVs and flat feature attributes. */
export function clipProjectedMesh(mesh: ProjectedMesh, request: MeshProjectionRequest,
    readPosition: (vertex: DataView) => readonly [number, number], remainingVertices: number): ProjectedMesh {
    const {layout, tile} = request;
    const unitsPerMeter = 4096 * 2 ** tile.coords.z / (2 * WORLD_HALF_WIDTH);
    const domain = getProjectedSourceDomain(request.projection.type);
    const bounds = [(domain[0] - tile.min.x) * unitsPerMeter, (domain[1] - tile.min.y) * unitsPerMeter,
        (domain[2] - tile.min.x) * unitsPerMeter, (domain[3] - tile.min.y) * unitsPerMeter];
    const records: Uint8Array[] = [];
    const positions: (readonly [number, number])[] = [];
    for (let offset = 0; offset < mesh.vertices.byteLength; offset += layout.stride) {
        const record = mesh.vertices.subarray(offset, offset + layout.stride);
        records.push(record);
        positions.push(readPosition(new DataView(record.buffer, record.byteOffset, record.byteLength)));
    }
    const originalCount = records.length;
    const inside = (index: number) => positions[index][0] >= bounds[0] && positions[index][0] <= bounds[2] &&
        positions[index][1] >= bounds[1] && positions[index][1] <= bounds[3];
    if (mesh.indices.every(inside)) return mesh;
    const intersections = new Map<string, number>();
    const triangles: number[] = [];
    for (let offset = 0; offset < mesh.indices.length; offset += 3) {
        let polygon = Array.from(mesh.indices.subarray(offset, offset + 3));
        for (let plane = 0; plane < 4 && polygon.length; plane++) {
            const axis = plane % 2;
            const boundary = bounds[plane];
            const distance = (index: number) => (positions[index][axis] - boundary) * (plane < 2 ? 1 : -1);
            const clipped: number[] = [];
            let previous = polygon[polygon.length - 1];
            for (const current of polygon) {
                const previousDistance = distance(previous), currentDistance = distance(current);
                if ((previousDistance >= 0) !== (currentDistance >= 0)) {
                    const first = Math.min(previous, current), second = Math.max(previous, current);
                    const key = `${plane}:${first}:${second}`;
                    let intersection = intersections.get(key);
                    if (intersection === undefined) {
                        const fraction = distance(first) / (distance(first) - distance(second));
                        if (fraction === 0 || fraction === 1) intersection = fraction === 0 ? first : second;
                        else {
                            if (records.length - originalCount >= remainingVertices) {
                                throw new RangeError('CPU projection clipping vertex budget exceeded');
                            }
                            intersection = records.length;
                            records.push(interpolatePackedVertex(records[first], records[second], layout, fraction));
                            positions.push(axis === 0 ? [boundary, positions[first][1] * (1 - fraction) + positions[second][1] * fraction] :
                                [positions[first][0] * (1 - fraction) + positions[second][0] * fraction, boundary]);
                        }
                        intersections.set(key, intersection);
                    }
                    if (clipped[clipped.length - 1] !== intersection) clipped.push(intersection);
                }
                if (currentDistance >= 0 && clipped[clipped.length - 1] !== current) clipped.push(current);
                previous = current;
            }
            if (clipped.length > 1 && clipped[0] === clipped[clipped.length - 1]) clipped.pop();
            polygon = clipped;
        }
        for (let index = 1; index < polygon.length - 1; index++) {
            const first = positions[polygon[0]], second = positions[polygon[index]], third = positions[polygon[index + 1]];
            if ((second[0] - first[0]) * (third[1] - first[1]) -
                (second[1] - first[1]) * (third[0] - first[0]) !== 0) triangles.push(polygon[0], polygon[index], polygon[index + 1]);
        }
    }
    // Drop unused/outside vertices so no invalid coordinate is submitted to the engine.
    const remap = new Map<number, number>();
    for (const index of triangles) if (!remap.has(index)) remap.set(index, remap.size);
    const vertices = new Uint8Array(remap.size * layout.stride);
    for (const [original, index] of remap) vertices.set(records[original], index * layout.stride);
    const indices = remap.size <= 65536 ? new Uint16Array(triangles.length) : new Uint32Array(triangles.length);
    triangles.forEach((index, offset) => {indices[offset] = remap.get(index)!;});
    return {vertices, indices};
}
