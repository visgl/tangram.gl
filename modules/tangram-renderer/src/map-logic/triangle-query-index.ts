// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {intersectRayBounds, intersectRayTriangle} from '@math.gl/geometry/culling';

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

/** Optional lazy hierarchy policy; the immutable geometry is always retained. */
export interface TriangleQueryIndexOptions {
    /** Build on the first bounds-intersecting query rather than at construction. */
    lazy?: boolean;
    /** Maximum hierarchy typed-array bytes; insufficient space uses exact linear queries. */
    maxHierarchyBytes?: number;
    /** Never build synchronously from a query; an explicit cooperative iterator warms acceleration. */
    deferBuild?: boolean;
}

/** Immutable CPU triangle index; no projection, scene, DOM, GPU or source ownership. */
export class TriangleQueryIndex {
    /** Exact packed acceleration bytes for the same balanced partition used by construction. */
    static getRequiredHierarchyBytes(triangleCount: number, leafSize = 8): number {
        if (!Number.isSafeInteger(triangleCount) || triangleCount < 0 || triangleCount > 0xffffffff || !Number.isSafeInteger(leafSize) || leafSize < 1 || leafSize > 64) throw new Error('Invalid triangle hierarchy dimensions');
        const counts = new Map<number, number>();
        const countNodes = (count: number): number => {
            if (!count) return 0;
            if (count <= leafSize) return 1;
            const cached = counts.get(count);
            if (cached !== undefined) return cached;
            const half = Math.floor(count / 2), result = 1 + countNodes(half) + countNodes(count - half);
            counts.set(count, result); return result;
        };
        return triangleCount * 4 + countNodes(triangleCount) * 64;
    }
    /** Original number of triangles, including degenerates. */
    readonly triangleCount: number;
    /** Exact retained geometry typed-array bytes, independent of lazy acceleration. */
    readonly geometryBytes: number;
    /** Exact required order and packed-node bytes, known before hierarchy allocation. */
    readonly requiredHierarchyBytes: number;
    /** Copied vertices and original topology. */
    private readonly positions: Float64Array;
    private readonly indices: Uint32Array;
    /** Partitioned original triangle identifiers. */
    private order?: Uint32Array;
    /** Six Float64 bounds and four Uint32 topology offsets per node. */
    private bounds?: Float64Array;
    private topology?: Uint32Array;
    /** In-progress storage is counted but never traversed until the whole hierarchy is ready. */
    private preparing?: {order: Uint32Array; bounds: Float64Array; topology: Uint32Array};
    private readonly leafSize: number;
    private readonly nodeCount: number;
    private readonly hierarchyAllowed: boolean;
    /** Host-driven warming keeps interactive queries from allocating a synchronous hierarchy. */
    private readonly deferBuild: boolean;
    private readonly minimum: [number, number, number] = [Infinity, Infinity, Infinity];
    private readonly maximum: [number, number, number] = [-Infinity, -Infinity, -Infinity];

    /** Copy finite XYZ triangles and partition their bounds into small balanced leaves. */
    constructor(positions: ArrayLike<number>, indices: ArrayLike<number>, leafSize = 8, options: TriangleQueryIndexOptions = {}) {
        if (!Number.isSafeInteger(positions.length) || !Number.isSafeInteger(indices.length) || positions.length % 3 || indices.length % 3 ||
            !Number.isSafeInteger(leafSize) || leafSize < 1 || leafSize > 64) throw new Error('Invalid triangle index dimensions or leaf size');
        if (indices.length / 3 > 0xffffffff) throw new Error('Triangle positions and indices must be finite and in range');
        if (options.maxHierarchyBytes !== undefined && (!Number.isSafeInteger(options.maxHierarchyBytes) || options.maxHierarchyBytes < 0)) throw new Error('Triangle hierarchy byte limit must be a non-negative integer');
        this.positions = Float64Array.from(positions);
        // Validate the owned snapshot, not a separate read of caller-owned ArrayLike values.
        for (let offset = 0; offset < this.positions.length; offset++) if (!Number.isFinite(this.positions[offset])) throw new Error('Triangle positions and indices must be finite and in range');
        this.indices = new Uint32Array(indices.length);
        for (let offset = 0; offset < indices.length; offset++) {
            const index = indices[offset];
            if (!Number.isSafeInteger(index) || index < 0 || index >= this.positions.length / 3 || index > 0xffffffff) throw new Error('Triangle positions and indices must be finite and in range');
            this.indices[offset] = index;
        }
        this.triangleCount = indices.length / 3;
        this.leafSize = leafSize;
        this.requiredHierarchyBytes = TriangleQueryIndex.getRequiredHierarchyBytes(this.triangleCount, leafSize);
        this.nodeCount = (this.requiredHierarchyBytes - this.triangleCount * 4) / 64;
        this.geometryBytes = this.positions.byteLength + this.indices.byteLength;
        this.hierarchyAllowed = this.requiredHierarchyBytes <= (options.maxHierarchyBytes ?? Infinity);
        this.deferBuild = options.deferBuild ?? false;
        for (let offset = 0; offset < this.positions.length; offset++) {
            const axis = offset % 3;
            this.minimum[axis] = Math.min(this.minimum[axis], this.positions[offset]);
            this.maximum[axis] = Math.max(this.maximum[axis], this.positions[offset]);
        }
        if (!options.lazy && this.hierarchyAllowed) this.buildHierarchy();
    }

    /** Exact currently retained backing arrays, excluding JavaScript objects and construction scratch. */
    get arrayBytes(): number {return this.geometryBytes + this.hierarchyBytes;}

    /** Exact allocated acceleration storage, including pending warming; zero before allocation or in linear mode. */
    get hierarchyBytes(): number {return this.preparing ? this.requiredHierarchyBytes : (this.order?.byteLength ?? 0) + (this.bounds?.byteLength ?? 0) + (this.topology?.byteLength ?? 0);}

    /** Detached conservative geometry bounds, including unreferenced finite vertices; null for an empty vertex buffer. */
    getBounds(): {minimum: [number, number, number]; maximum: [number, number, number]} | null {
        return this.positions.length ? {minimum: [...this.minimum], maximum: [...this.maximum]} : null;
    }

    /** Warm acceleration in bounded scanning/partition chunks; closing the iterator discards partial storage. */
    *prepareHierarchySteps(): Generator<void, void, void> {
        if (this.order || this.preparing || !this.hierarchyAllowed || !this.triangleCount) return;
        const storage = {order: new Uint32Array(this.triangleCount), bounds: new Float64Array(this.nodeCount * 6), topology: new Uint32Array(this.nodeCount * 4)};
        this.preparing = storage;
        try {
            for (let offset = 0; offset < storage.order.length; offset++) {
                storage.order[offset] = offset;
                if (offset % 128 === 127) yield;
            }
            yield* this.buildNodeSteps(storage, 0, this.triangleCount, {next: 0});
            this.bounds = storage.bounds; this.topology = storage.topology; this.order = storage.order;
        } finally {this.preparing = undefined;}
    }

    /** Detached indexed vertex and its original identity, without exposing mutable backing arrays. */
    getTriangleVertex(triangle: number, vertex: number): {index: number; position: [number, number, number]} {
        return {index: this.getVertexIndex(triangle, vertex), position: this.getVertex(triangle, vertex)};
    }

    /** Read one original vertex identity without allocating coordinates or exposing topology storage. */
    getVertexIndex(triangle: number, vertex: number): number {
        if (!Number.isSafeInteger(triangle) || triangle < 0 || triangle >= this.triangleCount || !Number.isSafeInteger(vertex) || vertex < 0 || vertex > 2) throw new Error('Triangle vertex is out of range');
        return this.indices[triangle * 3 + vertex];
    }

    /** Two-sided math.gl queries with bounds pruning, finite clipping and stable tie-breaking. */
    queryRay(origin: readonly [number, number, number], direction: readonly [number, number, number], maxParameter = Infinity,
        acceptHit?: (hit: IndexedTriangleHit) => boolean): TriangleQueryResult {
        if (maxParameter < 0 || Number.isNaN(maxParameter)) throw new Error('Triangle ray limit must be non-negative');
        const result: TriangleQueryResult = {hit: null, testedBounds: 0, testedTriangles: 0};
        const length = Math.hypot(...direction);
        if (origin.length !== 3 || direction.length !== 3 || !origin.every(Number.isFinite) || !direction.every(Number.isFinite) || !Number.isFinite(length) || length === 0 || !this.triangleCount) return result;
        if (intersectRayBounds(origin, direction, this.minimum, this.maximum, maxParameter) === null) return result;
        if (this.hierarchyAllowed && !this.deferBuild && !this.order && !this.preparing) this.buildHierarchy();
        /** Share hit acceptance and stable tie-breaking across accelerated and allocation-free fallback paths. */
        const testTriangle = (triangleIndex: number): void => {
            result.testedTriangles++;
            const hit = intersectRayTriangle(origin, direction, this.getVertex(triangleIndex, 0), this.getVertex(triangleIndex, 1), this.getVertex(triangleIndex, 2), {maxT: result.hit?.parameter ?? maxParameter});
            if (hit && (!result.hit || hit.t < result.hit.parameter || hit.t === result.hit.parameter && triangleIndex < result.hit.triangleIndex)) {
                const candidate = {triangleIndex, parameter: hit.t, barycentric: hit.barycentric};
                if (!acceptHit || acceptHit(candidate)) result.hit = candidate;
            }
        };
        if (!this.order) {
            for (let triangle = 0; triangle < this.triangleCount; triangle++) testTriangle(triangle);
            return result;
        }
        const stack = [{index: 0, near: 0}];
        result.testedBounds++;
        while (stack.length) {
            const {index, near} = stack.pop()!;
            if (near > (result.hit?.parameter ?? maxParameter)) continue;
            const node = this.readNode(index);
            if (node.children) {
                const candidates = node.children.flatMap(child => {
                    const bounds = this.readNode(child); result.testedBounds++;
                    const entry = intersectRayBounds(origin, direction, bounds.minimum, bounds.maximum, result.hit?.parameter ?? maxParameter);
                    return entry === null ? [] : [{index: child, near: entry}];
                });
                candidates.sort((first, second) => second.near - first.near || second.index - first.index);
                stack.push(...candidates); continue;
            }
            for (let offset = node.start; offset < node.end; offset++) {
                testTriangle(this.order[offset]);
            }
        }
        return result;
    }

    /** Preserve synchronous construction/lazy-query compatibility by consuming the same cooperative builder. */
    private buildHierarchy(): void {
        for (const step of this.prepareHierarchySteps()) {void step;}
    }

    /** Decode a node without retaining per-node JavaScript objects. */
    private readNode(index: number): TriangleBoundsNode {
        const bounds = this.bounds!, topology = this.topology!, offset = index * 4;
        return {minimum: [bounds[index * 6], bounds[index * 6 + 1], bounds[index * 6 + 2]], maximum: [bounds[index * 6 + 3], bounds[index * 6 + 4], bounds[index * 6 + 5]], start: topology[offset], end: topology[offset + 1], children: topology[offset + 2] ? [topology[offset + 2], topology[offset + 3]] : undefined};
    }

    /** Read a detached original vertex for bounds and triangle kernels. */
    private getVertex(triangle: number, offset: number): [number, number, number] {
        const start = this.indices[triangle * 3 + offset] * 3;
        return [this.positions[start], this.positions[start + 1], this.positions[start + 2]];
    }

    /** Partition on the longest bounds axis; midpoint splitting bounds recursion depth. */
    private *buildNodeSteps(storage: {order: Uint32Array; bounds: Float64Array; topology: Uint32Array}, start: number, end: number, cursor: {next: number}): Generator<void, number, void> {
        const {order, bounds, topology} = storage;
        const minimum: [number, number, number] = [Infinity, Infinity, Infinity];
        const maximum: [number, number, number] = [-Infinity, -Infinity, -Infinity];
        for (let offset = start; offset < end; offset++) {
            for (let vertex = 0; vertex < 3; vertex++) {
                const positionOffset = this.indices[order[offset] * 3 + vertex] * 3;
                for (let axis = 0; axis < 3; axis++) {const value = this.positions[positionOffset + axis]; minimum[axis] = Math.min(minimum[axis], value); maximum[axis] = Math.max(maximum[axis], value);}
            }
            if ((offset - start) % 128 === 127) yield;
        }
        const index = cursor.next++;
        bounds.set([...minimum, ...maximum], index * 6);
        topology.set([start, end], index * 4);
        if (end - start > this.leafSize) {
            let axis = 0;
            for (let candidate = 1; candidate < 3; candidate++) if (maximum[candidate] - minimum[candidate] > maximum[axis] - minimum[axis]) axis = candidate;
            const centroid = (triangle: number) => (this.positions[this.indices[triangle * 3] * 3 + axis] + this.positions[this.indices[triangle * 3 + 1] * 3 + axis] + this.positions[this.indices[triangle * 3 + 2] * 3 + axis]) / 3;
            const middle = start + Math.floor((end - start) / 2);
            yield* this.partitionSteps(order, middle, start, end - 1, (first, second) => centroid(first) - centroid(second) || first - second);
            const left = yield* this.buildNodeSteps(storage, start, middle, cursor);
            const right = yield* this.buildNodeSteps(storage, middle, end, cursor);
            topology.set([left, right], index * 4 + 2);
        }
        yield;
        return index;
    }

    /** In-place median selection with cooperative comparisons and no temporary full-size JavaScript order array. */
    private *partitionSteps(order: Uint32Array, middle: number, left: number, right: number, compare: (first: number, second: number) => number): Generator<void, void, void> {
        let comparisons = 0;
        while (left < right) {
            const pivot = order[left + Math.floor((right - left) / 2)];
            let lower = left, upper = right;
            while (lower <= upper) {
                while (compare(order[lower], pivot) < 0) {lower++; if (++comparisons % 128 === 0) yield;}
                while (compare(order[upper], pivot) > 0) {upper--; if (++comparisons % 128 === 0) yield;}
                if (lower <= upper) {const value = order[lower]; order[lower++] = order[upper]; order[upper--] = value;}
                if (++comparisons % 128 === 0) yield;
            }
            if (middle <= upper) right = upper;
            else if (middle >= lower) left = lower;
            else return;
        }
    }
}
