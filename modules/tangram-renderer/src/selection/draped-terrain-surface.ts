// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {TerrainMeshSurface, TerrainSurfaceCollection, type TerrainSurface, type TerrainSurfaceEntry, type TerrainSurfaceBounds} from './terrain_surface';
import {getGeographicProjectionProcedure, PROJECTION_CONSTANTS} from '../scene/projection_math';
import {TriangleQueryIndex} from '../map-logic/triangle-query-index';
import log from '../utils/log';
import {summarizeDrapedTerrainBounds, type DrapedTerrainBoundsSummary} from '../map-logic/draped-terrain-bounds';
import {intersectRayTriangle} from '@math.gl/geometry/culling';
import {Vector3} from '@math.gl/core';
import type {TerrainRay, TerrainSurfaceHit} from './terrain_surface';
import {projectTerrainGlobeVertex} from '../procedures/terrain-globe';

/** Measured CPU costs for one immutable terrain display, excluding other retained snapshots. */
export interface DrapedTerrainQueryStatistics {
    /** Unique retained physical input bytes. */
    inputBytes: number;
    /** Lazily projected geometry bytes. */
    projectedBytes: number;
    /** Completed acceleration hierarchy bytes. */
    queryIndexBytes: number;
    /** Aggregate permitted hierarchy bytes for this snapshot. */
    reservedQueryIndexBytes: number;
    /** Number of queried draw entries, including repeated clip leases. */
    preparedMeshes: number;
    /** Projected owners allocated by this snapshot. */
    projectionBuilds: number;
    /** Projection and cooperative hierarchy CPU time, excluding suspended time. */
    preparationMs: number;
    /** Ray-query CPU time. */
    queryMs: number;
    /** Owners whose acceleration failed; their exact linear queries remain available. */
    preparationFailures: number;
    /** Demanded entries using bounded-memory exact triangle projection rather than retained copies. */
    streamingMeshes: number;
}

/** Do not retry failed acceleration until a new projected owner is admitted. */
const failedPreparation = new WeakSet<ProjectedQuerySurface>();
/** Immutable worker inputs are checked once, not rescanned for every eye and animation frame. */
const validatedGlobeBasis = new WeakSet<DrapedTerrainQueryMesh>();

/** Cached or bounded-memory picking owner, with the same exact clipping boundary. */
type ProjectedQuerySurface = TerrainMeshSurface | StreamingTerrainSurface;
/** Candidate clip evaluated in original triangle/barycentric coordinates. */
type AcceptTerrainPosition = (position: readonly [number, number, number], triangleIndex: number, weights: readonly [number, number, number]) => boolean;

/** Project only the current triangle when retaining another full mesh would exceed the snapshot budget. */
class StreamingTerrainSurface implements TerrainSurface {
    /** Captured content projection, independent of a deck viewport. */
    readonly projection: TerrainSurface['projection'];
    /** Source arrays remain immutable under the same worker-payload contract as cached queries. */
    private readonly mesh: DrapedTerrainQueryMesh;
    /** Display blend used by the matching color pass. */
    private readonly blend: number;
    /** Display-only height multiplier; physical query altitude remains unchanged. */
    private readonly exaggeration: number;

    /** Capture one immutable display without allocating per-vertex projected arrays. */
    constructor(mesh: DrapedTerrainQueryMesh, projection: TerrainSurface['projection'], blend: number, exaggeration: number) {
        this.mesh = mesh; this.projection = projection; this.blend = blend; this.exaggeration = exaggeration;
        if (mesh.indices.length % 3 || !mesh.positions.every(Number.isFinite) ||
            mesh.indices.some(index => index >= mesh.positions.length / 3 || !Number.isFinite(mesh.heights[index * 2]) || !Number.isFinite(mesh.heights[index * 2 + 1]))) throw new Error('Terrain mesh: triangle positions, indices and physical heights must be finite and in range');
    }

    /** Streaming owners retain no additional full-mesh typed arrays or acceleration. */
    getStatistics(): {geometryBytes: number; queryIndexBytes: number} {return {geometryBytes: 0, queryIndexBytes: 0};}

    /** Match cached exact nearest-hit, face, physical-height, and source-clip semantics. */
    intersectRay(ray: TerrainRay, maximum = Infinity, accept?: AcceptTerrainPosition): TerrainSurfaceHit | null {
        if (maximum < 0 || Number.isNaN(maximum)) throw new Error('Terrain ray distance must be non-negative');
        const length = Math.hypot(...ray.direction);
        if (ray.origin.length !== 3 || ray.direction.length !== 3 || !ray.origin.every(Number.isFinite) ||
            !ray.direction.every(Number.isFinite) || !Number.isFinite(length) || length === 0) return null;
        const direction: [number, number, number] = [ray.direction[0] / length, ray.direction[1] / length, ray.direction[2] / length];
        const mercator = getGeographicProjectionProcedure('web-mercator'), projection = getGeographicProjectionProcedure(this.projection);
        let nearest: TerrainSurfaceHit | null = null;
        for (let triangle = 0; triangle < this.mesh.indices.length / 3; triangle++) {
            const physicalHeights: number[] = [];
            const vertices = [0, 1, 2].map(vertex => {
                const index = this.mesh.indices[triangle * 3 + vertex], offset = index * 3;
                const current = this.mesh.heights[index * 2], previous = this.mesh.heights[index * 2 + 1];
                const height = previous + (current - previous) * this.blend;
                physicalHeights.push(this.mesh.positions[offset + 2] + height);
                const position: [number, number, number] = [this.mesh.positions[offset], this.mesh.positions[offset + 1], this.mesh.positions[offset + 2] + height * this.exaggeration];
                return this.projection === 'globe' ? this.mesh.globeBasis ? projectTerrainGlobeVertex(this.mesh.globeBasis, index, this.blend, this.exaggeration,
                    [position[0], position[1], this.mesh.positions[offset + 2]]) : projection.project(mercator.unproject(position)) : position;
            });
            const candidate = intersectRayTriangle(ray.origin, direction, vertices[0], vertices[1], vertices[2], {maxT: nearest?.distance ?? maximum});
            if (!candidate || nearest && candidate.t >= nearest.distance) continue;
            const position: [number, number, number] = [ray.origin[0] + direction[0] * candidate.t, ray.origin[1] + direction[1] * candidate.t, ray.origin[2] + direction[2] * candidate.t];
            if (accept && !accept(position, triangle, candidate.barycentric)) continue;
            const normal = new Vector3(vertices[1]).subtract(vertices[0]).cross(new Vector3(vertices[2]).subtract(vertices[0]));
            if (this.projection === 'globe' && (Math.hypot(...position) === 0 || normal.dot(direction) >= 0)) continue;
            normal.normalize();
            const coordinate = projection.unproject(position);
            coordinate[2] = candidate.barycentric.reduce((height, weight, vertex) => height + weight * physicalHeights[vertex], 0);
            nearest = {position, coordinate, distance: candidate.t, normal: [normal[0], normal[1], normal[2]], triangleIndex: triangle, barycentric: candidate.barycentric};
        }
        return nearest;
    }
}

/** Worker-owned query channels extracted from the final ground draw topology. */
export interface DrapedTerrainQueryMesh {
    /** Absolute Mercator XYZ before terrain displacement; includes authored ground offsets. */
    positions: Float64Array;
    /** Current and previous physical height per vertex, interleaved in that order. */
    heights: Float32Array;
    /** Optional affine canonical globe channels: current base/relief, previous base/relief, three components each. */
    globeBasis?: Float32Array;
    /** Exact admitted draw triangles, excluding holes. */
    indices: Uint16Array | Uint32Array;
    /** Indexed XY footprint used to avoid allocating query geometry for unrelated vertical probes. */
    bounds: readonly [number, number, number, number];
    /** Worker-computed immutable extrema, avoiding vertex scans and projected allocations during the first host probe. */
    boundsSummary?: DrapedTerrainBoundsSummary;
}

/** Conservative display envelope without allocating any per-vertex projected query buffers. */
function getDisplayBounds(mesh: DrapedTerrainQueryMesh, projection: TerrainSurface['projection'], exaggeration: number,
    clips?: readonly (readonly number[])[]): TerrainSurfaceBounds | null {
    if (!mesh.indices.length || clips?.length === 0) return null;
    const summary = summarizeDrapedTerrainBounds(mesh);
    const low = summary.offsets[0] + summary.heights[0] * exaggeration;
    const high = summary.offsets[1] + summary.heights[1] * exaggeration;
    let minimum: [number, number, number], maximum: [number, number, number];
    if (projection === 'web-mercator') {
        minimum = [mesh.bounds[0], mesh.bounds[1], low]; maximum = [mesh.bounds[2], mesh.bounds[3], high];
        if (clips) {
            minimum[0] = Math.max(minimum[0], Math.min(...clips.map(clip => clip[0])));
            minimum[1] = Math.max(minimum[1], Math.min(...clips.map(clip => clip[1])));
            maximum[0] = Math.min(maximum[0], Math.max(...clips.map(clip => clip[2])));
            maximum[1] = Math.min(maximum[1], Math.max(...clips.map(clip => clip[3])));
            if (minimum[0] > maximum[0] || minimum[1] > maximum[1]) return null;
        }
    } else if (summary.globe) {
        minimum = [0, 0, 0]; maximum = [0, 0, 0];
        for (const axis of [0, 1, 2]) {
            const offsets = summary.offsets.flatMap(offset => [summary.directions.minimum[axis] * offset, summary.directions.maximum[axis] * offset])
                .map(value => value * PROJECTION_CONSTANTS.globeRadius / PROJECTION_CONSTANTS.earthRadius);
            minimum[axis] = summary.globe.base.minimum[axis] + summary.globe.relief.minimum[axis] * exaggeration + Math.min(...offsets);
            maximum[axis] = summary.globe.base.maximum[axis] + summary.globe.relief.maximum[axis] * exaggeration + Math.max(...offsets);
        }
    } else {
        const radii = [low, high].map(height => PROJECTION_CONSTANTS.globeRadius * (1 + height / PROJECTION_CONSTANTS.earthRadius));
        minimum = [0, 0, 0]; maximum = [0, 0, 0];
        for (const axis of [0, 1, 2]) {
            const products = radii.flatMap(radius => [summary.directions.minimum[axis] * radius, summary.directions.maximum[axis] * radius]);
            minimum[axis] = Math.min(...products); maximum[axis] = Math.max(...products);
        }
    }
    // Round outward: multiplication/division order differs from exact projected vertices.
    for (const axis of [0, 1, 2]) {
        const margin = Math.max(1, Math.abs(minimum[axis]), Math.abs(maximum[axis])) * 1e-12;
        minimum[axis] -= margin; maximum[axis] += margin;
    }
    return {minimum, maximum};
}

/** One admitted draw owner; callers never include pending worker generations. */
export interface DrapedTerrainQueryEntry {
    /** Stable tile/style/variant identity. */
    id: string;
    /** Final worker geometry retained independently of GPU buffers. */
    mesh: DrapedTerrainQueryMesh;
    /** Blend actually submitted for this draw generation. */
    blend: number;
    /** Optional absolute Mercator rectangles matching coarse globe fallback clipping. */
    clips?: readonly (readonly [number, number, number, number])[];
    /** Half-open interior ownership; terminal EPSG:3857 world edges stay closed for physical probes. Default false. */
    halfOpenClips?: boolean;
}

const projectedQueries = new WeakMap<DrapedTerrainQueryMesh, {projection: TerrainSurface['projection']; blend: number; exaggeration: number; indexLimit: number; surface: TerrainMeshSurface}>();
/** Geometry identity, not a reusable tile/style name, invalidates cached visibility after ordinary tile rebuilds. */
const meshIdentities = new WeakMap<DrapedTerrainQueryMesh, number>();
let nextMeshIdentity = 0;
/** Stable identity for one immutable worker payload. */
function getMeshIdentity(mesh: DrapedTerrainQueryMesh): number {
    let identity = meshIdentities.get(mesh);
    if (identity === undefined) {identity = nextMeshIdentity++; meshIdentities.set(mesh, identity);}
    return identity;
}

/** Reuse one immutable projected query owner while an admitted mesh's displacement remains unchanged. */
function getProjectedSurface(mesh: DrapedTerrainQueryMesh, projection: TerrainSurface['projection'], blend: number, exaggeration: number, indexLimit: number): TerrainMeshSurface {
    const cached = projectedQueries.get(mesh);
    if (cached?.projection === projection && cached.blend === blend && cached.exaggeration === exaggeration && cached.indexLimit === indexLimit) return cached.surface;
    const positions = new Float64Array(mesh.positions.length), physicalHeights = new Float64Array(mesh.positions.length / 3);
    const mercator = getGeographicProjectionProcedure('web-mercator'), globe = getGeographicProjectionProcedure('globe');
    for (let vertex = 0; vertex < physicalHeights.length; vertex++) {
        const offset = vertex * 3, current = mesh.heights[vertex * 2], previous = mesh.heights[vertex * 2 + 1];
        const height = previous + (current - previous) * blend;
        physicalHeights[vertex] = mesh.positions[offset + 2] + height;
        const position: [number, number, number] = [mesh.positions[offset], mesh.positions[offset + 1], mesh.positions[offset + 2] + height * exaggeration];
        positions.set(projection === 'globe' ? mesh.globeBasis ? projectTerrainGlobeVertex(mesh.globeBasis, vertex, blend, exaggeration,
            [position[0], position[1], mesh.positions[offset + 2]]) : globe.project(mercator.unproject(position)) : position, offset);
    }
    // No per-frame hierarchy allocations during morphing; settled meshes reuse this owner.
    const surface = new TerrainMeshSurface({projection, positions, indices: mesh.indices, physicalHeights, cullBackfaces: projection === 'globe', maxQueryIndexBytes: indexLimit, deferQueryIndexBuild: true});
    projectedQueries.set(mesh, {projection, blend, exaggeration, indexLimit, surface});
    return surface;
}

/** Conservative finite-ray XY admission; direction parameters are not assumed to be normalized. */
function intersectsFootprint(ray: import('./terrain_surface').TerrainRay, maximum: number | undefined, bounds: DrapedTerrainQueryMesh['bounds']): boolean {
    let near = 0, far = (maximum ?? Infinity) / Math.hypot(...ray.direction);
    for (const axis of [0, 1]) {
        if (ray.direction[axis] === 0) {
            if (ray.origin[axis] < bounds[axis] || ray.origin[axis] > bounds[axis + 2]) return false;
        } else {
            const first = (bounds[axis] - ray.origin[axis]) / ray.direction[axis], second = (bounds[axis + 2] - ray.origin[axis]) / ray.direction[axis];
            near = Math.max(near, Math.min(first, second)); far = Math.min(far, Math.max(first, second));
            if (near > far) return false;
        }
    }
    return true;
}

/** Immutable frame-specific surface, matching ground draw topology and temporal displacement. */
export class DrapedTerrainSurfaceSnapshot extends TerrainSurfaceCollection {
    /** Lazy query owners and measured work for this snapshot, never global renderer/GPU ownership. */
    private readonly queryOwners: {surface?: ProjectedQuerySurface; prepare(): ProjectedQuerySurface; blend: number; projectionBuilds: number; preparationMs: number; queryMs: number}[];
    /** Scene mesh generation, not source-cache or provider revision. */
    readonly generation: number;
    /** Shared monotonic clock used for both eyes and the corresponding draw. */
    readonly frameTime: number;
    /** GPU relief multiplier captured with the snapshot. */
    readonly exaggeration: number;
    /** Retained physical query input arrays, including indices; excludes projected copies and GPU memory. */
    readonly inputBytes: number;
    /** Admitted membership, blend and exaggeration key for skipping repeated settled host probes. */
    readonly displayKey: string;
    /** Demand-admitted index bytes; unqueried display entries never reserve acceleration. */
    get reservedQueryIndexBytes(): number {return this.indexBudget.reserved;}
    /** Snapshot-local reservation state shared by repeated clip leases. */
    private readonly indexBudget: {reserved: number};

    /** Capture displacement without copying/projecting every mesh until it is queried. */
    constructor(projection: TerrainSurface['projection'], entries: readonly DrapedTerrainQueryEntry[], generation: number, frameTime: number, exaggeration: number, maxQueryIndexBytes = 16 * 1024 * 1024, maxProjectedQueryBytes = 32 * 1024 * 1024) {
        if (!Number.isSafeInteger(generation) || generation < 0 || !Number.isFinite(frameTime) || !Number.isFinite(exaggeration) || exaggeration < 0 || exaggeration > 1000) throw new Error('Invalid terrain surface frame');
        if (!Number.isSafeInteger(maxQueryIndexBytes) || maxQueryIndexBytes < 0) throw new Error('Invalid terrain query index budget');
        if (!Number.isSafeInteger(maxProjectedQueryBytes) || maxProjectedQueryBytes < 0) throw new Error('Invalid terrain projected query budget');
        const queryOwners: DrapedTerrainSurfaceSnapshot['queryOwners'] = [];
        const indexBudget = {reserved: 0};
        const indexLimits = new Map<DrapedTerrainQueryMesh, number>();
        const admittedSurfaces = new Map<DrapedTerrainQueryMesh, Map<number, ProjectedQuerySurface>>();
        let projectedBytes = 0;
        const surfaces: TerrainSurfaceEntry[] = entries.map(entry => {
            if (!Number.isFinite(entry.blend) || entry.blend < 0 || entry.blend > 1) throw new Error('Invalid terrain surface blend');
            const mesh = entry.mesh;
            if (mesh.positions.length % 3 || mesh.heights.length !== mesh.positions.length / 3 * 2) throw new Error('Invalid terrain query channels');
            if (mesh.globeBasis && !validatedGlobeBasis.has(mesh)) {
                if (mesh.globeBasis.length !== mesh.positions.length * 4 || !mesh.globeBasis.every(Number.isFinite)) throw new Error('Invalid terrain globe basis channels');
                validatedGlobeBasis.add(mesh);
            }
            const blend = entry.blend, clips = entry.clips?.map(bounds => [...bounds]), halfOpenClips = entry.halfOpenClips ?? false;
            if (typeof halfOpenClips !== 'boolean') throw new Error('Invalid terrain query clip ownership');
            const required = TriangleQueryIndex.getRequiredHierarchyBytes(mesh.indices.length / 3);
            if (clips?.some(bounds => bounds.length !== 4 || !bounds.every(Number.isFinite) || bounds[0] > bounds[2] || bounds[1] > bounds[3])) throw new Error('Invalid terrain query clip');
            const worldHalf = Math.PI * PROJECTION_CONSTANTS.mercatorRadius;
            // A finite world has no owner beyond its east/north edge. Normalize
            // source-bound reconstruction ulps, but never close interior seams.
            if (halfOpenClips) for (const bounds of clips ?? []) for (const axis of [2, 3]) {
                if (Math.abs(bounds[axis] - worldHalf) <= worldHalf * Number.EPSILON * 8) bounds[axis] = worldHalf;
            }
            let displayBounds: TerrainSurfaceBounds | null | undefined;
            const owner: DrapedTerrainSurfaceSnapshot['queryOwners'][number] = {blend, projectionBuilds: 0, preparationMs: 0, queryMs: 0, prepare() {
                if (!owner.surface) {
                    const existing = admittedSurfaces.get(mesh)?.get(blend);
                    if (existing) {owner.surface = existing; return existing;}
                    const started = performance.now();
                    // TerrainMeshSurface owns Float64 XYZ, Float64 physical heights, and Uint32 topology.
                    const geometryBytes = mesh.positions.length * 8 + mesh.heights.length / 2 * 8 + mesh.indices.length * 4;
                    if (geometryBytes > maxProjectedQueryBytes - projectedBytes) {
                        // A live mesh key must not pin an earlier snapshot's
                        // projected arrays after this demand is denied residency.
                        // Older snapshots keep their own admitted surface owner.
                        projectedQueries.delete(mesh);
                        owner.surface = new StreamingTerrainSurface(mesh, projection, blend, exaggeration);
                    } else {
                        projectedBytes += geometryBytes;
                    // Near-first collection admission chooses the first demanded owner, not
                    // constructor membership order. Clip leases of the same settled mesh share it.
                    const indexLimit = blend !== 1 ? 0 : indexLimits.get(mesh) ?? (required <= maxQueryIndexBytes - indexBudget.reserved ? required : 0);
                    if (blend === 1 && !indexLimits.has(mesh)) {indexLimits.set(mesh, indexLimit); indexBudget.reserved += indexLimit;}
                    const cached = projectedQueries.get(mesh);
                    owner.projectionBuilds = Number(cached?.projection !== projection || cached.blend !== blend || cached.exaggeration !== exaggeration || cached.indexLimit !== indexLimit);
                    owner.surface = getProjectedSurface(mesh, projection, blend, exaggeration, indexLimit);
                    }
                    owner.preparationMs += performance.now() - started;
                    const blends = admittedSurfaces.get(mesh) ?? new Map<number, ProjectedQuerySurface>();
                    blends.set(blend, owner.surface); admittedSurfaces.set(mesh, blends);
                }
                return owner.surface;
            }};
            queryOwners.push(owner);
            return {id: entry.id, surface: {projection, getBounds() {
                if (displayBounds === undefined) displayBounds = getDisplayBounds(mesh, projection, exaggeration, clips);
                return displayBounds ? {minimum: [...displayBounds.minimum], maximum: [...displayBounds.maximum]} : null;
            }, intersectRay(ray, maximum) {
                if (clips?.length === 0 || !mesh.indices.length) return null;
                if (projection === 'web-mercator' && !intersectsFootprint(ray, maximum, mesh.bounds)) return null;
                const surface = owner.prepare();
                const started = performance.now();
                const hit = surface.intersectRay(ray, maximum, clips ? (point, triangleIndex, weights) => {
                    // The draw clips its interpolated tile-position varying, not the inverse
                    // geographic projection of the curved triangle's common-space hit.
                    const position = projection === 'web-mercator' ? point : [0, 1].map(axis => weights.reduce((value, weight, vertex) => value + weight * mesh.positions[mesh.indices[triangleIndex * 3 + vertex] * 3 + axis], 0));
                    return clips.some(bounds => position[0] >= bounds[0] && (halfOpenClips && bounds[2] !== worldHalf ? position[0] < bounds[2] : position[0] <= bounds[2]) &&
                        position[1] >= bounds[1] && (halfOpenClips && bounds[3] !== worldHalf ? position[1] < bounds[3] : position[1] <= bounds[3]));
                } : undefined);
                owner.queryMs += performance.now() - started;
                return hit;
            }}};
        });
        super(projection, surfaces);
        this.generation = generation; this.frameTime = frameTime; this.exaggeration = exaggeration;
        this.queryOwners = queryOwners;
        this.indexBudget = indexBudget;
        this.inputBytes = [...new Set(entries.map(entry => entry.mesh))].reduce((bytes, mesh) => bytes + mesh.positions.byteLength + mesh.heights.byteLength + mesh.indices.byteLength + (mesh.globeBasis?.byteLength ?? 0), 0);
        this.displayKey = `${projection}/${generation}/${exaggeration}/${maxQueryIndexBytes}/${maxProjectedQueryBytes}/${entries.map(entry => `${entry.id}:${getMeshIdentity(entry.mesh)}:${entry.blend}:${JSON.stringify(entry.clips)}:${Boolean(entry.halfOpenClips)}`).join(',')}`;
    }

    /** Fairly warm demanded settled owners; closing releases every partial hierarchy. */
    *prepareQueryIndexSteps(): Generator<void, void, void> {
        const warmed = new Set<ProjectedQuerySurface>();
        const pending: {owner: DrapedTerrainSurfaceSnapshot['queryOwners'][number]; steps: Generator<void, void, void>}[] = [];
        for (const owner of this.queryOwners) {
            const surface = owner.surface;
            if (!surface || surface instanceof StreamingTerrainSurface || owner.blend !== 1 || warmed.has(surface) || failedPreparation.has(surface)) continue;
            warmed.add(surface);
            pending.push({owner, steps: surface.prepareQueryIndexSteps()});
        }
        try {
            while (pending.length) {
                for (let index = 0; index < pending.length;) {
                    const {owner, steps} = pending[index];
                    const started = performance.now();
                    let done: boolean | undefined;
                    try {done = steps.next().done;}
                    catch (error) {
                        if (owner.surface) failedPreparation.add(owner.surface);
                        log('warn', 'Terrain query acceleration failed; retaining exact linear queries', error);
                        done = true;
                    }
                    finally {owner.preparationMs += performance.now() - started;}
                    if (done) {steps.return(); pending.splice(index, 1);}
                    else {index++; yield;}
                }
            }
        } finally {
            for (const {steps} of pending) steps.return();
        }
    }

    /** Detached snapshot-local CPU query costs; excludes other retained host snapshots and GPU/transient storage. */
    getStatistics(): DrapedTerrainQueryStatistics {
        const statistics = {inputBytes: this.inputBytes, projectedBytes: 0, queryIndexBytes: 0, reservedQueryIndexBytes: this.reservedQueryIndexBytes, preparedMeshes: 0, projectionBuilds: 0, preparationMs: 0, queryMs: 0, preparationFailures: 0, streamingMeshes: 0};
        const counted = new Set<ProjectedQuerySurface>();
        for (const owner of this.queryOwners) {
            if (owner.surface && !counted.has(owner.surface)) {
                const sizes = owner.surface.getStatistics();
                statistics.projectedBytes += sizes.geometryBytes; statistics.queryIndexBytes += sizes.queryIndexBytes;
                statistics.preparationFailures += Number(failedPreparation.has(owner.surface));
                counted.add(owner.surface);
            }
            statistics.preparedMeshes += Number(owner.surface !== undefined);
            statistics.streamingMeshes += Number(owner.surface instanceof StreamingTerrainSurface);
            statistics.projectionBuilds += owner.projectionBuilds;
            statistics.preparationMs += owner.preparationMs; statistics.queryMs += owner.queryMs;
        }
        return statistics;
    }
}
