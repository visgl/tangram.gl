// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {interpolatePackedVertex, refineGlobeMesh, selectTrianglePlane} from '../gl/globe_mesh';
import type {MeshProjectionRequest, ProjectedMesh} from '../procedures/mesh-projector';

/** Per-request refinement work, separate from cached source preparation. */
export interface ProjectedRefinementWork {
    /** Rounds that subdivide curved edges. */
    edgeRounds: number;
    /** Rounds that add strictly interior triangle vertices. */
    interiorRounds: number;
}

const INTERIOR_WEIGHTS = [[1 / 3, 1 / 3, 1 / 3], [0.5, 0.25, 0.25],
    [0.25, 0.5, 0.25], [0.25, 0.25, 0.5]] as const;

/** Batch projection samples per refinement round; local and caller-owned kernels use identical topology decisions.
 * Edge and barycentric interior probes are sampled estimates, not certified bounds for arbitrary kernels.
 * Indexed neighbors share decisions. Independent source tiles use identical packed midpoint rules and tolerance.
 */
export function* refineProjectedMesh(mesh: ProjectedMesh, request: MeshProjectionRequest,
    geographicPosition: (vertex: DataView, displacement?: readonly [number, number]) => readonly [number, number],
    readPosition: (vertex: DataView) => [number, number],
    work: ProjectedRefinementWork = {edgeRounds: 0, interiorRounds: 0}): Generator<Float64Array, ProjectedMesh, Float64Array> {
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
        const edgeCoordinateCount = coordinates.length;
        // Ribbons are parameterized around centerlines; their pixel-width/fan
        // reconstruction is not a geographic surface interpolant.
        const inspectInteriors = request.geometry !== 'lines';
        if (inspectInteriors) for (let index = 0; index < result.indices.length; index += 3) {
            const corners = [0, 1, 2].map(component => result.vertices.subarray(
                result.indices[index + component] * layout.stride, (result.indices[index + component] + 1) * layout.stride));
            const points = corners.map(record => readPosition(new DataView(record.buffer, record.byteOffset, layout.stride)));
            for (const corner of corners) coordinates.push(...geographicPosition(new DataView(corner.buffer, corner.byteOffset, layout.stride)));
            for (const weights of INTERIOR_WEIGHTS) {
                const sample = interpolateTriangle(corners, request, weights);
                const view = new DataView(sample.buffer, sample.byteOffset, layout.stride);
                const packed = readPosition(view);
                coordinates.push(...geographicPosition(view, [
                    points.reduce((sum, point, component) => sum + point[0] * weights[component], 0) - packed[0],
                    points.reduce((sum, point, component) => sum + point[1] * weights[component], 0) - packed[1]]));
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
                const fraction = request.geometry !== 'lines' ? sample / 4 : lengthSquared === 0 ? 0 : Math.max(0, Math.min(1,
                    ((projected[offset + sample * 2] - projected[offset]) * differenceX +
                    (projected[offset + sample * 2 + 1] - projected[offset + 1]) * differenceY) / lengthSquared));
                // Surfaces need parameterized interpolation accuracy for raster
                // UVs, not just perpendicular silhouette error. Exact source
                // probes above keep packed rounding out of this measurement.
                const error = Math.hypot(projected[offset + sample * 2] -
                    (projected[offset] * (1 - fraction) + projected[offset + 8] * fraction),
                projected[offset + sample * 2 + 1] -
                    (projected[offset + 1] * (1 - fraction) + projected[offset + 9] * fraction));
                if (error > tolerance) split.add(edge);
            }
            offset += 10;
        }
        if (split.size === 0) {
            const interiors = new Set<number>();
            offset = edgeCoordinateCount;
            if (inspectInteriors) for (let index = 0; index < result.indices.length; index += 3) {
                for (const [sample, weights] of INTERIOR_WEIGHTS.entries()) {
                    const expected = [0, 1].map(component => weights.reduce((sum, weight, corner) =>
                        sum + weight * projected[offset + corner * 2 + component], 0));
                    const actual = offset + 6 + sample * 2;
                    if (Math.hypot(projected[actual] - expected[0], projected[actual + 1] - expected[1]) > tolerance) {
                        interiors.add(index);
                    }
                }
                offset += 14;
            }
            if (interiors.size === 0) return result;
            result = splitTriangleInteriors(result, request, interiors, readPosition,
                budget - (result.vertices.byteLength / layout.stride - originalCount));
            work.interiorRounds++;
            continue;
        }
        const refined = refineGlobeMesh(result.vertices, result.indices, layout, {tileZoom: request.tile.coords.z,
            maxAngularSpan: 180, maxAdditionalVertices: budget - (result.vertices.byteLength / layout.stride - originalCount),
            splitRemainderInterior: inspectInteriors,
            getElevation: getPackedElevationReader(request),
            getPosition: readPosition, shouldSplitEdge: (first, second) => split.has(edgeKey(first, second))});
        if (refined.vertices.byteLength === result.vertices.byteLength) {
            throw new RangeError('Projected error tolerance exceeds packed coordinate precision');
        }
        result = refined;
        work.edgeRounds++;
    }
    throw new RangeError('Projected refinement iteration budget exceeded');
}

/** Interpolate all supported varying attributes while retaining flat feature provenance. */
function interpolateTriangle(corners: Uint8Array[], request: MeshProjectionRequest, weights: readonly number[]): Uint8Array {
    return interpolatePackedVertex(interpolatePackedVertex(corners[0], corners[1], request.layout,
        weights[1] / (weights[0] + weights[1])), corners[2], request.layout, weights[2]);
}

/** Insert strictly interior packed centers without changing any shared edge or its neighbors. */
function splitTriangleInteriors(mesh: ProjectedMesh, request: MeshProjectionRequest, selected: Set<number>,
    readPosition: (vertex: DataView) => [number, number], remainingBudget: number): ProjectedMesh {
    if (selected.size > remainingBudget) throw new RangeError('Projected interior refinement vertex budget exceeded');
    const {stride} = request.layout;
    const vertexCount = mesh.vertices.byteLength / stride;
    const vertices = new Uint8Array(mesh.vertices.byteLength + selected.size * stride);
    vertices.set(mesh.vertices);
    const indices: number[] = [];
    let inserted = 0;
    for (let index = 0; index < mesh.indices.length; index += 3) {
        const triangle = [mesh.indices[index], mesh.indices[index + 1], mesh.indices[index + 2]];
        if (!selected.has(index)) {indices.push(...triangle); continue;}
        const corners = triangle.map(vertex => mesh.vertices.subarray(vertex * stride, (vertex + 1) * stride));
        const center = interpolateTriangle(corners, request, INTERIOR_WEIGHTS[0]);
        const readElevation = getPackedElevationReader(request);
        const topologyPosition = (vertex: Uint8Array): [number, number, number] => {
            const view = new DataView(vertex.buffer, vertex.byteOffset, stride);
            return [...readPosition(view), readElevation?.(view) ?? 0];
        };
        const corners3D = corners.map(topologyPosition);
        const axes = selectTrianglePlane(corners3D);
        const flatten = (position: readonly [number, number, number]): [number, number] => [position[axes[0]], position[axes[1]]];
        const point = flatten(topologyPosition(center));
        const points = corners3D.map(flatten);
        const cross = (first: number[], second: number[], third: number[]) =>
            (second[0] - first[0]) * (third[1] - first[1]) - (second[1] - first[1]) * (third[0] - first[0]);
        const orientation = cross(points[0], points[1], points[2]);
        if (points.some((start, edge) => cross(start, points[(edge + 1) % 3], point) * orientation <= 0)) {
            throw new RangeError('Projected interior tolerance exceeds packed coordinate precision');
        }
        const centerIndex = vertexCount + inserted++;
        vertices.set(center, centerIndex * stride);
        indices.push(triangle[0], triangle[1], centerIndex, triangle[1], triangle[2], centerIndex,
            triangle[2], triangle[0], centerIndex);
    }
    return {vertices, indices: vertexCount + selected.size <= 65536 ? new Uint16Array(indices) : new Uint32Array(indices)};
}

/** Read the original packed height only for opted-in surface topology checks. */
function getPackedElevationReader(request: MeshProjectionRequest): ((vertex: DataView) => number) | undefined {
    if (!request.projection.allowElevation || request.geometry === 'lines') return undefined;
    const position = request.layout.dynamic_attribs.find(attribute => attribute.name === 'a_position');
    if (!position || position.offset === undefined || position.size < 3) throw new Error('Projected elevation requires a position layout');
    const offset = position.offset;
    return vertex => vertex.getInt16(offset + 4, true);
}
