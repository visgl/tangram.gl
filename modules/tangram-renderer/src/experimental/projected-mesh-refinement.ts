// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {interpolatePackedVertex, refineGlobeMesh} from '../gl/globe_mesh';
import type {MeshProjectionRequest, ProjectedMesh} from '../procedures/mesh-projector';

/** Batch projection samples per refinement round; local and caller-owned kernels use identical topology decisions.
 * Quarter/midpoint chord tests are sampled error estimates, not a certified bound for arbitrary kernels.
 * Indexed neighbors share decisions. Independent source tiles use identical packed midpoint rules and tolerance.
 */
export function* refineProjectedMesh(mesh: ProjectedMesh, request: MeshProjectionRequest,
    geographicPosition: (vertex: DataView, displacement?: readonly [number, number]) => readonly [number, number],
    readPosition: (vertex: DataView) => [number, number]): Generator<Float64Array, ProjectedMesh, Float64Array> {
    const tolerance = request.projection.maxProjectedError;
    if (tolerance === undefined || mesh.indices.length === 0) return mesh;
    const {layout} = request;
    const originalCount = request.vertices.byteLength / layout.stride;
    const budget = request.projection.maxAdditionalVertices ?? 65536;
    let result = mesh;
    const key = (vertex: DataView): string => Array.from(new Uint8Array(vertex.buffer, vertex.byteOffset, vertex.byteLength)).join(',');
    const edgeKey = (first: DataView, second: DataView): string => {
        const firstKey = key(first), secondKey = key(second);
        return firstKey < secondKey ? `${firstKey}:${secondKey}` : `${secondKey}:${firstKey}`;
    };
    for (let iteration = 0; iteration < 32; iteration++) {
        const edges = new Map<string, [Uint8Array, Uint8Array]>();
        for (let index = 0; index < result.indices.length; index += 3) for (let edge = 0; edge < 3; edge++) {
            const first = result.vertices.subarray(result.indices[index + edge] * layout.stride,
                (result.indices[index + edge] + 1) * layout.stride);
            const secondIndex = result.indices[index + (edge + 1) % 3];
            const second = result.vertices.subarray(secondIndex * layout.stride, (secondIndex + 1) * layout.stride);
            edges.set(edgeKey(new DataView(first.buffer, first.byteOffset, first.byteLength),
                new DataView(second.buffer, second.byteOffset, second.byteLength)), [first, second]);
        }
        const coordinates: number[] = [];
        for (const [first, second] of edges.values()) {
            const start = readPosition(new DataView(first.buffer, first.byteOffset, first.byteLength));
            const end = readPosition(new DataView(second.buffer, second.byteOffset, second.byteLength));
            for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
                const sample = fraction === 0 ? first : fraction === 1 ? second : interpolatePackedVertex(first, second, layout, fraction);
                const view = new DataView(sample.buffer, sample.byteOffset, sample.byteLength);
                const packed = readPosition(view);
                // Test the exact source chord, not off-chord integer rounding of
                // its probes. Generated vertices still retain the packed rules.
                coordinates.push(...geographicPosition(view, [start[0] * (1 - fraction) + end[0] * fraction - packed[0],
                    start[1] * (1 - fraction) + end[1] * fraction - packed[1]]));
            }
        }
        const projected = yield new Float64Array(coordinates);
        if (!(projected instanceof Float64Array) || projected.length !== coordinates.length || !projected.every(Number.isFinite)) {
            throw new Error('Projection refinement returned an invalid common-position batch');
        }
        const split = new Set<string>();
        let offset = 0;
        for (const edge of edges.keys()) {
            const differenceX = projected[offset + 8] - projected[offset];
            const differenceY = projected[offset + 9] - projected[offset + 1];
            const lengthSquared = differenceX ** 2 + differenceY ** 2;
            for (let sample = 1; sample < 4; sample++) {
                // Packed samples round to the source grid. Movement along a straight
                // chord is not curvature, even when it no longer equals sample / 4.
                const fraction = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1,
                    ((projected[offset + sample * 2] - projected[offset]) * differenceX +
                    (projected[offset + sample * 2 + 1] - projected[offset + 1]) * differenceY) / lengthSquared));
                const error = Math.hypot(projected[offset + sample * 2] -
                    (projected[offset] * (1 - fraction) + projected[offset + 8] * fraction),
                projected[offset + sample * 2 + 1] -
                    (projected[offset + 1] * (1 - fraction) + projected[offset + 9] * fraction));
                if (error > tolerance) split.add(edge);
            }
            offset += 10;
        }
        if (split.size === 0) return result;
        const refined = refineGlobeMesh(result.vertices, result.indices, layout, {tileZoom: request.tile.coords.z,
            maxAngularSpan: 180, maxAdditionalVertices: budget - (result.vertices.byteLength / layout.stride - originalCount),
            getPosition: readPosition, shouldSplitEdge: (first, second) => split.has(edgeKey(first, second))});
        if (refined.vertices.byteLength === result.vertices.byteLength) {
            throw new RangeError('Projected error tolerance exceeds packed coordinate precision');
        }
        result = refined;
    }
    throw new RangeError('Projected refinement iteration budget exceeded');
}
