// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type VertexLayout from '../gl/vertex_layout';
import {interpolatePackedVertex, selectTrianglePlane} from '../gl/globe_mesh';

/** A clipped authored vertex, retaining its unrounded geometric clipping position. */
interface ClipVertex {
    /** Authored packed channels, never shared across feature triangles. */
    record: Uint8Array;
    /** Expanded nominal tile-space XY used for clipping. */
    position: [number, number];
}

/** Closed tile-space triangle envelope and original canonical face offset. */
interface FaceBounds {
    /** Canonical index-buffer offset, not a reordered face identity. */
    offset: number;
    /** Closed XY envelope. */
    bounds: [number, number, number, number];
}

/** Temporary balanced bounds tree; released after one worker mesh is prepared. */
interface FaceNode {
    /** Union of descendant envelopes. */
    bounds: [number, number, number, number];
    /** Original canonical triangles at a small leaf. */
    faces?: FaceBounds[];
    /** Median-partitioned children. */
    children?: [FaceNode, FaceNode];
}

/** Styled geometry and its barycentric references to the shared physical surface. */
export interface TerrainStyledTopology {
    /** Packed source channels interpolated only within each original feature face. */
    vertices: Uint8Array;
    /** Source winding/order retained; disconnected features never weld their attributes. */
    indices: Uint32Array;
    /** Three canonical vertex identities per output vertex. */
    surfaceIndices: Uint32Array;
    /** Three surface weights at the actual packed nominal XY per output vertex. */
    surfaceWeights: Float64Array;
}

/** Signed twice-area in tile-space XY; canonical faces are counterclockwise. */
function cross(first: readonly number[], second: readonly number[], third: readonly number[]): number {
    return (second[0] - first[0]) * (third[1] - first[1]) - (second[1] - first[1]) * (third[0] - first[0]);
}

/** Build a mesh-local broad phase instead of scanning every terrain cell for every source face. */
function buildNode(faces: FaceBounds[]): FaceNode {
    const bounds: FaceNode['bounds'] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const face of faces) for (let axis = 0; axis < 2; axis++) {
        bounds[axis] = Math.min(bounds[axis], face.bounds[axis]);
        bounds[axis + 2] = Math.max(bounds[axis + 2], face.bounds[axis + 2]);
    }
    if (faces.length <= 8) return {bounds, faces};
    const axis = bounds[2] - bounds[0] >= bounds[3] - bounds[1] ? 0 : 1;
    faces.sort((first, second) => first.bounds[axis] + first.bounds[axis + 2] - second.bounds[axis] - second.bounds[axis + 2] || first.offset - second.offset);
    const middle = Math.floor(faces.length / 2);
    return {bounds, children: [buildNode(faces.slice(0, middle)), buildNode(faces.slice(middle))]};
}

/** Intersect source faces with complete DEM triangles, preserving holes, walls and feature identity.
 * Heights are interpolated from the terrain face, not resampled from a different bilinear surface.
 * The caller owns DEM validation, physical sampling and final draw-byte admission.
 */
export function conformTerrainStyledMesh(options: {
    /** Floating-position authored records before terrain channels are appended. */
    vertices: Uint8Array;
    /** Valid source triangles in authored draw order. */
    indices: Uint16Array | Uint32Array;
    /** Original packed attribute interpolation semantics. */
    layout: VertexLayout;
    /** Canonical terrain nodes in the same tile-local coordinate system. */
    surfacePositions: Float64Array;
    /** Counterclockwise canonical terrain triangles. */
    surfaceIndices: Uint32Array;
    /** Nominal expanded corner, including road width and offset. */
    getPosition: (record: DataView) => [number, number];
    /** Authored elevation, used to retain vertical walls rather than discarding XY degenerates. */
    getElevation: (record: DataView) => number;
    /** Maximum completed output vertices; a failed admission never returns partial geometry. */
    maxVertices: number;
}): TerrainStyledTopology {
    const {layout, surfacePositions, surfaceIndices} = options;
    const point = (index: number): [number, number] => [surfacePositions[index * 2], surfacePositions[index * 2 + 1]];
    const edgeCounts = new Map<string, number>();
    const edgeKey = (first: number, second: number) => `${Math.min(first, second)}:${Math.max(first, second)}`;
    const faces: FaceBounds[] = [];
    for (let offset = 0; offset < surfaceIndices.length; offset += 3) {
        const corners = [0, 1, 2].map(corner => point(surfaceIndices[offset + corner]));
        faces.push({offset, bounds: [Math.min(...corners.map(vertex => vertex[0])), Math.min(...corners.map(vertex => vertex[1])),
            Math.max(...corners.map(vertex => vertex[0])), Math.max(...corners.map(vertex => vertex[1]))]});
        for (let edge = 0; edge < 3; edge++) {
            const key = edgeKey(surfaceIndices[offset + edge], surfaceIndices[offset + (edge + 1) % 3]);
            edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
        }
    }
    const root = faces.length ? buildNode(faces) : null;
    const records: Uint8Array[] = [], indices: number[] = [], references: number[] = [], weights: number[] = [];
    const view = (record: Uint8Array) => new DataView(record.buffer, record.byteOffset, layout.stride);
    const intersects = (first: readonly number[], second: readonly number[]) => first[0] <= second[2] && first[2] >= second[0] && first[1] <= second[3] && first[3] >= second[1];
    for (let offset = 0; offset < options.indices.length; offset += 3) {
        const source = [0, 1, 2].map(corner => {
            const index = options.indices[offset + corner];
            const record = options.vertices.subarray(index * layout.stride, (index + 1) * layout.stride);
            return {record, position: options.getPosition(view(record))};
        });
        // Validate flat/custom channels even when a face happens not to need clipping.
        interpolatePackedVertex(source[0].record, source[1].record, layout, 0);
        interpolatePackedVertex(source[0].record, source[2].record, layout, 0);
        if (layout.offset.a_extrude !== undefined) {
            // Width/offset scale products must remain affine within an authored face.
            for (const corner of source.slice(1)) {
                if (view(corner.record).getFloat32(layout.offset.a_position + 8, true) !== view(source[0].record).getFloat32(layout.offset.a_position + 8, true) ||
                    layout.offset.a_z_and_offset_scale !== undefined && view(corner.record).getInt16(layout.offset.a_z_and_offset_scale + 2, true) !== view(source[0].record).getInt16(layout.offset.a_z_and_offset_scale + 2, true)) {
                    throw new Error('Canonical terrain roads require uniform per-face width and offset scales');
                }
            }
        }
        const bounds = [Math.min(...source.map(vertex => vertex.position[0])), Math.min(...source.map(vertex => vertex.position[1])),
            Math.max(...source.map(vertex => vertex.position[0])), Math.max(...source.map(vertex => vertex.position[1]))];
        const plane = selectTrianglePlane(source.map(vertex => [...vertex.position, options.getElevation(view(vertex.record))] as const));
        const candidates: FaceBounds[] = [], pending = root ? [root] : [];
        while (pending.length) {
            const node = pending.pop()!;
            if (!intersects(bounds, node.bounds)) continue;
            if (node.faces) for (const face of node.faces) {if (intersects(bounds, face.bounds)) candidates.push(face);}
            else pending.push(...node.children!);
        }
        candidates.sort((first, second) => first.offset - second.offset);
        for (const face of candidates) {
            const corners = [0, 1, 2].map(corner => point(surfaceIndices[face.offset + corner]));
            let polygon: ClipVertex[] = source;
            for (let edge = 0; edge < 3 && polygon.length; edge++) {
                const first = corners[edge], second = corners[(edge + 1) % 3];
                // A wall on a shared terrain edge belongs to just one incident face.
                if (polygon.every(vertex => cross(first, second, vertex.position) === 0) &&
                    edgeCounts.get(edgeKey(surfaceIndices[face.offset + edge], surfaceIndices[face.offset + (edge + 1) % 3])) === 2 &&
                    !(second[1] > first[1] || second[1] === first[1] && second[0] < first[0])) {polygon = []; break;}
                const clipped: ClipVertex[] = [];
                for (let index = 0; index < polygon.length; index++) {
                    let start = polygon[index], end = polygon[(index + 1) % polygon.length];
                    let startDistance = cross(first, second, start.position), endDistance = cross(first, second, end.position);
                    if (startDistance >= 0) clipped.push(start);
                    if (startDistance < 0 && endDistance > 0 || startDistance > 0 && endDistance < 0) {
                        // Stable geometric orientation gives reversed/shared edges identical intersections.
                        if (start.position[0] > end.position[0] || start.position[0] === end.position[0] && start.position[1] > end.position[1]) {
                            [start, end] = [end, start]; [startDistance, endDistance] = [endDistance, startDistance];
                        }
                        const fraction = startDistance / (startDistance - endDistance);
                        clipped.push({record: interpolatePackedVertex(start.record, end.record, layout, fraction), position: [
                            start.position[0] + (end.position[0] - start.position[0]) * fraction,
                            start.position[1] + (end.position[1] - start.position[1]) * fraction]});
                    }
                }
                polygon = clipped;
            }
            if (polygon.length < 3) continue;
            const positions = polygon.map(vertex => [...vertex.position, options.getElevation(view(vertex.record))] as const);
            const area = (first: number, second: number, third: number) => cross(
                [positions[first][plane[0]], positions[first][plane[1]]], [positions[second][plane[0]], positions[second][plane[1]]], [positions[third][plane[0]], positions[third][plane[1]]]);
            if (!polygon.slice(2).some((_vertex, index) => area(0, index + 1, index + 2) !== 0)) continue;
            if (records.length + polygon.length > options.maxVertices) throw new Error('Canonical styled terrain vertex/mesh budget exceeded');
            const base = records.length, denominator = cross(corners[0], corners[1], corners[2]);
            for (const vertex of polygon) {
                const record = vertex.record.slice(), packed = view(record), actual = options.getPosition(packed);
                // Preserve the road's dynamic extrusion; only correct roundoff in its centerline.
                packed.setFloat32(layout.offset.a_position, packed.getFloat32(layout.offset.a_position, true) + vertex.position[0] - actual[0], true);
                packed.setFloat32(layout.offset.a_position + 4, packed.getFloat32(layout.offset.a_position + 4, true) + vertex.position[1] - actual[1], true);
                const position = options.getPosition(packed);
                const first = cross(corners[1], corners[2], position) / denominator;
                const second = cross(corners[2], corners[0], position) / denominator;
                records.push(record); references.push(...surfaceIndices.subarray(face.offset, face.offset + 3)); weights.push(first, second, 1 - first - second);
            }
            for (let index = 1; index + 1 < polygon.length; index++) if (area(0, index, index + 1) !== 0) indices.push(base, base + index, base + index + 1);
        }
    }
    const vertices = new Uint8Array(records.length * layout.stride);
    records.forEach((record, index) => vertices.set(record, index * layout.stride));
    return {vertices, indices: Uint32Array.from(indices), surfaceIndices: Uint32Array.from(references), surfaceWeights: Float64Array.from(weights)};
}
