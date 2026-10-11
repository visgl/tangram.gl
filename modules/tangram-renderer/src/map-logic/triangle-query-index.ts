// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {intersectRayBounds, intersectRayTriangle} from '@math.gl/culling/queries';
import quickselect from 'quickselect';

/** Nearest two-sided triangle; the ray parameter retains the supplied direction scale. */
export interface IndexedTriangleHit {
    /** Original triangle offset, unaffected by bounds partitioning. */
    triangleIndex: number;
    /** Parameter along origin + direction × parameter. */
    parameter: number;
    /** Weights in the original index order. */
    barycentric: [number, number, number];
}

/** Detached query result with deterministic work counts for conformance/performance tests. */
export interface TriangleQueryResult {
    /** Nearest hit in the closed forward segment, or null. */
    hit: IndexedTriangleHit | null;
    /** Number of tested hierarchy boxes. */
    testedBounds: number;
    /** Number of actual triangle intersection tests. */
    testedTriangles: number;
}

/** Internal binary bounds partition; leaves retain original triangle identities. */
interface TriangleBoundsNode {
    /** Closed lower corner. */
    minimum: [number, number, number];
    /** Closed upper corner. */
    maximum: [number, number, number];
    /** First offset in the partitioned triangle list. */
    start: number;
    /** Exclusive last offset. */
    end: number;
    /** Child offsets, absent at leaves. */
    children?: [number, number];
}

/** Immutable CPU triangle index; no projection, scene, DOM, GPU or source ownership. */
export class TriangleQueryIndex {
    /** Original number of triangles, including degenerates. */
    readonly triangleCount: number;
    /** Approximate retained typed-array bytes; node object overhead is not included. */
    readonly arrayBytes: number;
    /** Copied vertices and original topology. */
    private readonly positions: Float64Array;
    private readonly indices: Uint32Array;
    /** Partitioned original triangle identifiers. */
    private readonly order: Uint32Array;
    /** Closed bounds, built once for the immutable geometry. */
    private readonly nodes: TriangleBoundsNode[] = [];

    /** Copy finite XYZ triangles and partition their bounds into small balanced leaves. */
    constructor(positions: ArrayLike<number>, indices: ArrayLike<number>, leafSize = 8) {
        if (!Number.isSafeInteger(positions.length) || !Number.isSafeInteger(indices.length) || positions.length % 3 || indices.length % 3 ||
            !Number.isSafeInteger(leafSize) || leafSize < 1 || leafSize > 64) throw new Error('Invalid triangle index dimensions or leaf size');
        if (indices.length / 3 > 0xffffffff || !Array.from(positions).every(Number.isFinite) || !Array.from(indices).every(index => Number.isSafeInteger(index) && index >= 0 && index < positions.length / 3 && index <= 0xffffffff)) throw new Error('Triangle positions and indices must be finite and in range');
        this.positions = Float64Array.from(positions);
        this.indices = Uint32Array.from(indices);
        this.triangleCount = indices.length / 3;
        const order = Array.from({length: this.triangleCount}, (_, index) => index);
        if (this.triangleCount) this.buildNode(order, 0, this.triangleCount, leafSize);
        this.order = Uint32Array.from(order);
        this.arrayBytes = this.positions.byteLength + this.indices.byteLength + this.order.byteLength;
    }

    /** Two-sided math.gl queries with bounds pruning, finite clipping and stable tie-breaking. */
    queryRay(origin: readonly [number, number, number], direction: readonly [number, number, number], maxParameter = Infinity,
        acceptHit?: (hit: IndexedTriangleHit) => boolean): TriangleQueryResult {
        if (maxParameter < 0 || Number.isNaN(maxParameter)) throw new Error('Triangle ray limit must be non-negative');
        const result: TriangleQueryResult = {hit: null, testedBounds: 0, testedTriangles: 0};
        const length = Math.hypot(...direction);
        if (origin.length !== 3 || direction.length !== 3 || !origin.every(Number.isFinite) || !direction.every(Number.isFinite) || !Number.isFinite(length) || length === 0 || !this.nodes.length) return result;
        const stack = [0];
        while (stack.length) {
            const node = this.nodes[stack.pop()!];
            result.testedBounds++;
            if (intersectRayBounds(origin, direction, node.minimum, node.maximum, result.hit?.parameter ?? maxParameter) === null) continue;
            if (node.children) {stack.push(node.children[1], node.children[0]); continue;}
            for (let offset = node.start; offset < node.end; offset++) {
                const triangleIndex = this.order[offset];
                result.testedTriangles++;
                const hit = intersectRayTriangle(origin, direction, this.getVertex(triangleIndex, 0), this.getVertex(triangleIndex, 1), this.getVertex(triangleIndex, 2), {maxT: result.hit?.parameter ?? maxParameter});
                if (hit && (!result.hit || hit.t < result.hit.parameter || hit.t === result.hit.parameter && triangleIndex < result.hit.triangleIndex)) {
                    const candidate = {triangleIndex, parameter: hit.t, barycentric: hit.barycentric};
                    if (!acceptHit || acceptHit(candidate)) result.hit = candidate;
                }
            }
        }
        return result;
    }

    /** Read a detached original vertex for bounds and triangle kernels. */
    private getVertex(triangle: number, offset: number): [number, number, number] {
        const start = this.indices[triangle * 3 + offset] * 3;
        return [this.positions[start], this.positions[start + 1], this.positions[start + 2]];
    }

    /** Partition on the longest bounds axis; midpoint splitting bounds recursion depth. */
    private buildNode(order: number[], start: number, end: number, leafSize: number): number {
        const minimum: [number, number, number] = [Infinity, Infinity, Infinity];
        const maximum: [number, number, number] = [-Infinity, -Infinity, -Infinity];
        for (let offset = start; offset < end; offset++) for (let vertex = 0; vertex < 3; vertex++) {
            const positionOffset = this.indices[order[offset] * 3 + vertex] * 3;
            for (let axis = 0; axis < 3; axis++) {const value = this.positions[positionOffset + axis]; minimum[axis] = Math.min(minimum[axis], value); maximum[axis] = Math.max(maximum[axis], value);}
        }
        const index = this.nodes.length;
        const node: TriangleBoundsNode = {minimum, maximum, start, end};
        this.nodes.push(node);
        if (end - start > leafSize) {
            let axis = 0;
            for (let candidate = 1; candidate < 3; candidate++) if (maximum[candidate] - minimum[candidate] > maximum[axis] - minimum[axis]) axis = candidate;
            const centroid = (triangle: number) => (this.positions[this.indices[triangle * 3] * 3 + axis] + this.positions[this.indices[triangle * 3 + 1] * 3 + axis] + this.positions[this.indices[triangle * 3 + 2] * 3 + axis]) / 3;
            const middle = start + Math.floor((end - start) / 2);
            quickselect(order, middle, start, end - 1, (first, second) => centroid(first) - centroid(second) || first - second);
            node.children = [this.buildNode(order, start, middle, leafSize), this.buildNode(order, middle, end, leafSize)];
        }
        return index;
    }
}
