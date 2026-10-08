// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type VertexLayout from './vertex_layout';

type VertexAttribute = VertexLayout['dynamic_attribs'][number];

/** Packed triangle data after projection-aware refinement. */
export type GlobeMeshData = {
    /** Interleaved vertices, with the original vertices retained at their original indices. */
    vertices: Uint8Array;
    /** Triangle indices, promoted to 32 bits when necessary. */
    indices: Uint16Array | Uint32Array;
};

/** Limits for globe refinement in Tangram tile-local coordinates. */
export type GlobeMeshOptions = {
    /** Actual source tile zoom, not the style zoom. */
    tileZoom: number;
    /** Tile-local units per tile edge. */
    tileScale?: number;
    /** Maximum Mercator angular edge span; conservatively bounds spherical span. */
    maxAngularSpan?: number;
    /** Maximum additional vertices; additional triangles are limited to twice this budget. */
    maxAdditionalVertices?: number;
    /** Optional expanded tile-space position for packed ribbons; never changes the preserved attributes. */
    getPosition?: (vertex: DataView) => [number, number];
    /** Optional additional edge decision; callers must use the same criterion across adjacent meshes. */
    shouldSplitEdge?: (first: DataView, second: DataView) => boolean;
};

const INTERPOLATED_ATTRIBUTES = new Set([
    'a_position', 'a_normal', 'a_color', 'a_texcoord', 'a_extrude', 'a_offset',
    'a_z_and_offset_scale', 'a_projected_position', 'a_projected_stroke'
]);

/**
 * Split long triangle edges before spherical projection. Shared indexed edges share
 * midpoints; independent tile edges use the same quantized midpoint rule. Selection
 * IDs and layer order remain flat. Unknown varying attributes are rejected rather
 * than guessing their interpolation semantics. Camera state is deliberately absent.
 */
export function refineGlobeMesh(
    vertices: Uint8Array,
    indices: Uint16Array | Uint32Array | false,
    layout: {stride: number; dynamic_attribs: VertexAttribute[]},
    options: GlobeMeshOptions
): GlobeMeshData {
    const tileScale = options.tileScale ?? 4096;
    const angularSpan = options.maxAngularSpan ?? 4;
    const budget = options.maxAdditionalVertices ?? 262144;
    if (!Number.isInteger(options.tileZoom) || options.tileZoom < 0 || options.tileZoom > 30 ||
        !Number.isFinite(tileScale) || tileScale <= 0 ||
        !Number.isFinite(angularSpan) || angularSpan <= 0 || angularSpan > 180 ||
        !Number.isInteger(budget) || budget < 0) {
        throw new RangeError('Globe mesh: invalid refinement limits');
    }
    const maximumEdge = tileScale * 2 ** options.tileZoom * angularSpan / 360;
    if (maximumEdge < 2) {
        throw new RangeError('Globe mesh: refinement exceeds packed position precision');
    }
    const position = layout.dynamic_attribs.find(attribute => attribute.name === 'a_position');
    if (!position || position.size < 2 || position.offset === undefined ||
        layout.stride <= 0 || vertices.byteLength % layout.stride !== 0) {
        throw new Error('Globe mesh: an aligned position layout is required');
    }
    const originalCount = vertices.byteLength / layout.stride;
    const triangleIndices = indices || Uint32Array.from({length: originalCount}, (_, index) => index);
    if (triangleIndices.length % 3 !== 0 || triangleIndices.some(index => index >= originalCount)) {
        throw new Error('Globe mesh: invalid triangle indices');
    }
    const records: Uint8Array[] = [];
    const positions: [number, number][] = [];
    for (let index = 0; index < originalCount; index++) {
        const record = vertices.subarray(index * layout.stride, (index + 1) * layout.stride);
        records.push(record);
        const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
        const point: [number, number] = options.getPosition ? options.getPosition(view) :
            [readComponent(view, position, 0), readComponent(view, position, 1)];
        if (!point.every(Number.isFinite)) {
            throw new Error('Globe mesh: nonfinite position');
        }
        positions.push(point);
    }
    const midpoints = new Map<string, number>();
    const output: number[] = [];
    const pending: number[][] = [];
    const maximumTriangles = triangleIndices.length / 3 + budget * 2;
    // A LIFO worklist must start in reverse to preserve source triangle/feature draw order.
    for (let index = triangleIndices.length - 3; index >= 0; index -= 3) {
        pending.push([triangleIndices[index], triangleIndices[index + 1], triangleIndices[index + 2]]);
    }
    const isLong = (first: number, second: number): boolean => {
        const distance = Math.hypot(positions[first][0] - positions[second][0], positions[first][1] - positions[second][1]);
        return distance > maximumEdge || (distance >= 2 && Boolean(options.shouldSplitEdge?.(
            new DataView(records[first].buffer, records[first].byteOffset, layout.stride),
            new DataView(records[second].buffer, records[second].byteOffset, layout.stride))));
    };
    const getMidpoint = (first: number, second: number): number => {
        const key = `${Math.min(first, second)}:${Math.max(first, second)}`;
        const cached = midpoints.get(key);
        if (cached !== undefined) {
            return cached;
        }
        if (records.length >= originalCount + budget) {
            throw new RangeError('Globe mesh: refinement vertex budget exceeded');
        }
        const record = interpolatePackedVertex(records[first], records[second], layout, 0.5);
        const outputView = new DataView(record.buffer);
        const midpoint = records.length;
        records.push(record);
        positions.push(options.getPosition ? options.getPosition(outputView) :
            [readComponent(outputView, position, 0), readComponent(outputView, position, 1)]);
        midpoints.set(key, midpoint);
        return midpoint;
    };
    while (pending.length) {
        const triangle = pending.pop()!;
        const [first, second, third] = triangle;
        const split = [isLong(first, second), isLong(second, third), isLong(third, first)];
        const count = split.filter(Boolean).length;
        if (count === 0) {
            output.push(first, second, third);
        }
        else if (count === 3) {
            const firstMidpoint = getMidpoint(first, second);
            const secondMidpoint = getMidpoint(second, third);
            const thirdMidpoint = getMidpoint(third, first);
            pending.push([first, firstMidpoint, thirdMidpoint], [firstMidpoint, second, secondMidpoint],
                [thirdMidpoint, secondMidpoint, third], [firstMidpoint, secondMidpoint, thirdMidpoint]);
        }
        else {
            // Rotate the triangle to place the single split (or unsplit) edge first.
            const edge = split.findIndex(value => value === (count === 1));
            const start = triangle[edge];
            const end = triangle[(edge + 1) % 3];
            const opposite = triangle[(edge + 2) % 3];
            if (count === 1) {
                const midpoint = getMidpoint(start, end);
                pending.push([start, midpoint, opposite], [midpoint, end, opposite]);
            }
            else {
                const endMidpoint = getMidpoint(end, opposite);
                const startMidpoint = getMidpoint(opposite, start);
                pending.push([opposite, startMidpoint, endMidpoint],
                    [start, end, startMidpoint], [end, endMidpoint, startMidpoint]);
            }
        }
        if (pending.length + output.length / 3 > maximumTriangles) {
            throw new RangeError('Globe mesh: refinement triangle budget exceeded');
        }
    }
    if (records.length === originalCount) {
        return {vertices, indices: triangleIndices};
    }
    const refinedVertices = new Uint8Array(records.length * layout.stride);
    records.forEach((record, index) => refinedVertices.set(record, index * layout.stride));
    return {
        vertices: refinedVertices,
        indices: records.length <= 65536 ? new Uint16Array(output) : new Uint32Array(output)
    };
}

/** Preserve Tangram's packed interpolation and flat IDs at refinement or clipping intersections. */
export function interpolatePackedVertex(first: Uint8Array, second: Uint8Array,
    layout: {stride: number; dynamic_attribs: VertexAttribute[]}, fraction: number): Uint8Array {
    const record = first.slice();
    const firstView = new DataView(first.buffer, first.byteOffset, layout.stride);
    const secondView = new DataView(second.buffer, second.byteOffset, layout.stride);
    const outputView = new DataView(record.buffer);
    for (const attribute of layout.dynamic_attribs) {
        for (let component = 0; component < attribute.size; component++) {
            const firstValue = readComponent(firstView, attribute, component);
            const secondValue = readComponent(secondView, attribute, component);
            const flat = attribute.name === 'a_selection_color' || (attribute.name === 'a_position' && component === 3);
            if (flat || !INTERPOLATED_ATTRIBUTES.has(attribute.name)) {
                if (firstValue !== secondValue) throw new Error(`Globe mesh: varying flat attribute ${attribute.name} is unsupported`);
            }
            else {
                // Keep the exact existing midpoint arithmetic, including integer rounding.
                writeComponent(outputView, attribute, component, fraction === 0.5 ?
                    (firstValue + secondValue) / 2 : firstValue * (1 - fraction) + secondValue * fraction);
            }
        }
    }
    return record;
}

/** Read a component without assuming the interleaved buffer starts at byte zero. */
function readComponent(view: DataView, attribute: VertexAttribute, component: number): number {
    const offset = attribute.offset ?? 0;
    switch (attribute.type) {
    case 0x1400: return view.getInt8(offset + component);
    case 0x1401: return view.getUint8(offset + component);
    case 0x1402: return view.getInt16(offset + component * 2, true);
    case 0x1403: return view.getUint16(offset + component * 2, true);
    case 0x1404: return view.getInt32(offset + component * 4, true);
    case 0x1405: return view.getUint32(offset + component * 4, true);
    case 0x1406: return view.getFloat32(offset + component * 4, true);
    default: throw new Error(`Globe mesh: unsupported attribute type ${attribute.type}`);
    }
}

/** Interpolate in the attribute's packed domain, rounding integer coordinates consistently. */
function writeComponent(view: DataView, attribute: VertexAttribute, component: number, value: number): void {
    const offset = attribute.offset ?? 0;
    const integer = Math.round(value);
    switch (attribute.type) {
    case 0x1400: view.setInt8(offset + component, integer); break;
    case 0x1401: view.setUint8(offset + component, integer); break;
    case 0x1402: view.setInt16(offset + component * 2, integer, true); break;
    case 0x1403: view.setUint16(offset + component * 2, integer, true); break;
    case 0x1404: view.setInt32(offset + component * 4, integer, true); break;
    case 0x1405: view.setUint32(offset + component * 4, integer, true); break;
    case 0x1406: view.setFloat32(offset + component * 4, value, true); break;
    default: throw new Error(`Globe mesh: unsupported attribute type ${attribute.type}`);
    }
}
