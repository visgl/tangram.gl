// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {TerrainGroundTopology} from './terrain-ground-topology';

/** Barycentric reference to one unchanged endpoint face. Negative indices mean absent previous coverage. */
export interface TerrainFaceReference {
    /** Canonical vertex indices in original winding. */
    readonly indices: readonly [number, number, number];
    /** Weights at the final geometric position. */
    readonly weights: readonly [number, number, number];
}

/** Common planar refinement of two field generations; neither endpoint is bilinearly resampled at new cuts. */
export interface TerrainTransitionTopology {
    /** Complete current footprint partition, including newly covered regions. */
    readonly topology: TerrainGroundTopology;
    /** Current endpoint references, one per output vertex. */
    readonly current: readonly TerrainFaceReference[];
    /** Previous endpoint references, null outside the previous admitted footprint. */
    readonly previous: readonly (TerrainFaceReference | null)[];
}

/** Closed face envelope used by the temporary sweep broad phase. */
interface Face {
    /** Canonical face identity. */
    indices: [number, number, number];
    /** Exact sample-domain corners. */
    points: [number, number][];
    /** Closed bounds. */
    bounds: [number, number, number, number];
}

/** Temporary binary broad phase; no retained index escapes preparation. */
interface FaceNode {
    /** Closed descendant envelope. */
    bounds: [number, number, number, number];
    /** Small original-order leaf. */
    faces?: Face[];
    /** Median split children. */
    children?: [FaceNode, FaceNode];
}

/** Bound edge work to overlapping old faces rather than the product of both meshes. */
function buildNode(faces: Face[]): FaceNode | null {
    if (!faces.length) return null;
    const bounds: FaceNode['bounds'] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const face of faces) for (let axis = 0; axis < 2; axis++) {
        bounds[axis] = Math.min(bounds[axis], face.bounds[axis]); bounds[axis + 2] = Math.max(bounds[axis + 2], face.bounds[axis + 2]);
    }
    if (faces.length <= 8) return {bounds, faces};
    const axis = bounds[2] - bounds[0] > bounds[3] - bounds[1] ? 0 : 1;
    faces.sort((first, second) => first.bounds[axis] + first.bounds[axis + 2] - second.bounds[axis] - second.bounds[axis + 2]);
    const middle = Math.floor(faces.length / 2);
    return {bounds, children: [buildNode(faces.slice(0, middle))!, buildNode(faces.slice(middle))!]};
}

/** Signed twice-area, preserving the canonical world-XY winding. */
function cross(first: readonly number[], second: readonly number[], point: readonly number[]): number {
    return (second[0] - first[0]) * (point[1] - first[1]) - (second[1] - first[1]) * (point[0] - first[0]);
}

/** Classify collinearity within world-coordinate representation error, not a fixed geometric epsilon. */
function signedDistance(first: readonly number[], second: readonly number[], point: readonly number[]): number {
    const distance = cross(first, second, point);
    const tolerance = Number.EPSILON * Math.max(1, ...first.map(Math.abs), ...second.map(Math.abs), ...point.map(Math.abs)) *
        (Math.abs(second[0] - first[0]) + Math.abs(second[1] - first[1])) * 16;
    return Math.abs(distance) <= tolerance ? 0 : distance;
}

/** Reference coordinates without changing the existing face's diagonal or endpoint samples. */
function reference(face: Face, point: readonly number[]): TerrainFaceReference {
    const denominator = cross(face.points[0], face.points[1], face.points[2]);
    const first = cross(face.points[1], face.points[2], point) / denominator;
    const second = cross(face.points[2], face.points[0], point) / denominator;
    return {indices: face.indices, weights: [first, second, 1 - first - second]};
}

/** Snapshot an immutable topology's faces; temporary arrays never survive the worker preparation. */
function faces(topology: TerrainGroundTopology): Face[] {
    const result: Face[] = [];
    for (let offset = 0; offset < topology.indices.length; offset += 3) {
        const indices: [number, number, number] = [topology.indices[offset], topology.indices[offset + 1], topology.indices[offset + 2]];
        const points = indices.map((index): [number, number] => [topology.samplePositions[index * 2], topology.samplePositions[index * 2 + 1]]);
        result.push({indices, points, bounds: [Math.min(...points.map(point => point[0])), Math.min(...points.map(point => point[1])),
            Math.max(...points.map(point => point[0])), Math.max(...points.map(point => point[1]))]});
    }
    return result;
}

/**
 * Split current faces along previous edges, retaining both exact planar endpoint
 * surfaces and newly covered ground. Bounded work/vertices reject atomically.
 * This does not claim spherical coplanarity after nonlinear globe projection.
 */
export function refineTerrainTransitionTopology(current: TerrainGroundTopology, previous: TerrainGroundTopology, maxVertices: number,
    maxEdgeTests = 1048576): TerrainTransitionTopology | null {
    if (!Number.isSafeInteger(maxVertices) || maxVertices < 0 || !Number.isSafeInteger(maxEdgeTests) || maxEdgeTests < 0 || current.sampleOffset !== previous.sampleOffset) throw new Error('Invalid terrain transition budget or sampling world');
    if (current.samplePositions.length === previous.samplePositions.length && current.indices.length === previous.indices.length &&
        current.samplePositions.every((value, index) => value === previous.samplePositions[index]) && current.indices.every((value, index) => value === previous.indices[index])) return null;
    const root = buildNode(faces(previous));
    const positions: number[] = [], samplePositions: number[] = [], normalizedPositions: number[] = [], indices: number[] = [];
    const currentReferences: TerrainFaceReference[] = [], previousReferences: (TerrainFaceReference | null)[] = [];
    let tests = 0;
    for (const face of faces(current)) {
        const candidates: Face[] = [];
        const pending = root ? [root] : [];
        while (pending.length) {
            const node = pending.pop()!;
            if (++tests > maxEdgeTests) throw new Error('Terrain transition edge-work budget exceeded');
            if (node.bounds[0] >= face.bounds[2] || node.bounds[2] <= face.bounds[0] || node.bounds[1] >= face.bounds[3] || node.bounds[3] <= face.bounds[1]) continue;
            if (node.faces) for (const candidate of node.faces) {
                if (candidate.bounds[0] < face.bounds[2] && candidate.bounds[2] > face.bounds[0] && candidate.bounds[1] < face.bounds[3] && candidate.bounds[3] > face.bounds[1]) candidates.push(candidate);
            }
            else pending.push(...node.children!);
        }
        let polygons = [face.points];
        const edges = new Set<string>();
        for (const candidate of candidates) for (let edge = 0; edge < 3; edge++) {
            let start = candidate.points[edge], end = candidate.points[(edge + 1) % 3];
            if (start[0] > end[0] || start[0] === end[0] && start[1] > end[1]) [start, end] = [end, start];
            const key = `${start.join(',')}/${end.join(',')}`;
            if (edges.has(key)) continue;
            edges.add(key);
            const next: [number, number][][] = [];
            for (const polygon of polygons) {
                if (++tests > maxEdgeTests) throw new Error('Terrain transition edge-work budget exceeded');
                const distances = polygon.map(point => signedDistance(start, end, point));
                if (!distances.some(value => value < 0) || !distances.some(value => value > 0)) {next.push(polygon); continue;}
                const positive: [number, number][] = [], negative: [number, number][] = [];
                polygon.forEach((point, index) => {
                    const distance = distances[index], following = polygon[(index + 1) % polygon.length], followingDistance = distances[(index + 1) % polygon.length];
                    if (distance >= 0) positive.push(point);
                    if (distance <= 0) negative.push(point);
                    if (distance * followingDistance < 0) {
                        const fraction = distance / (distance - followingDistance);
                        const intersection: [number, number] = [point[0] + (following[0] - point[0]) * fraction, point[1] + (following[1] - point[1]) * fraction];
                        positive.push(intersection); negative.push(intersection);
                    }
                });
                next.push(positive, negative);
                if (next.length * 3 > maxVertices) throw new Error('Terrain transition vertex budget exceeded');
            }
            polygons = next;
        }
        for (const polygon of polygons) {
            if (samplePositions.length / 2 + polygon.length > maxVertices) throw new Error('Terrain transition vertex budget exceeded');
            const center = polygon.reduce(([x, y], point) => [x + point[0] / polygon.length, y + point[1] / polygon.length], [0, 0]);
            const oldFace = candidates.find(candidate => candidate.points.every((point, index) => signedDistance(point, candidate.points[(index + 1) % 3], center) >= 0));
            const base = samplePositions.length / 2;
            for (const point of polygon) {
                const currentReference = reference(face, point);
                currentReferences.push(currentReference); previousReferences.push(oldFace ? reference(oldFace, point) : null);
                samplePositions.push(...point); positions.push(point[0] + current.sampleOffset, point[1]);
                for (let axis = 0; axis < 2; axis++) normalizedPositions.push(currentReference.indices.reduce((sum, index, corner) =>
                    sum + current.normalizedPositions[index * 2 + axis] * currentReference.weights[corner], 0));
            }
            for (let index = 1; index + 1 < polygon.length; index++) if (cross(polygon[0], polygon[index], polygon[index + 1]) !== 0) indices.push(base, base + index, base + index + 1);
        }
    }
    return {topology: {positions: Float64Array.from(positions), samplePositions: Float64Array.from(samplePositions), normalizedPositions: Float64Array.from(normalizedPositions),
        indices: Uint32Array.from(indices), sampleOffset: current.sampleOffset}, current: currentReferences, previous: previousReferences};
}
