// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {TerrainMeshSurface, TerrainSurfaceCollection, type TerrainSurface, type TerrainSurfaceEntry} from './terrain_surface';
import {getGeographicProjectionProcedure} from '../scene/projection_math';

/** Worker-owned query channels extracted from the final ground draw topology. */
export interface DrapedTerrainQueryMesh {
    /** Absolute Mercator XYZ before terrain displacement; includes authored ground offsets. */
    positions: Float64Array;
    /** Current and previous physical height per vertex, interleaved in that order. */
    heights: Float32Array;
    /** Exact admitted draw triangles, excluding holes. */
    indices: Uint16Array | Uint32Array;
    /** Indexed XY footprint used to avoid allocating query geometry for unrelated vertical probes. */
    bounds: readonly [number, number, number, number];
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
}

const projectedQueries = new WeakMap<DrapedTerrainQueryMesh, {projection: TerrainSurface['projection']; blend: number; exaggeration: number; surface: TerrainMeshSurface}>();

/** Reuse one immutable projected query owner while an admitted mesh's displacement remains unchanged. */
function getProjectedSurface(mesh: DrapedTerrainQueryMesh, projection: TerrainSurface['projection'], blend: number, exaggeration: number): TerrainMeshSurface {
    const cached = projectedQueries.get(mesh);
    if (cached?.projection === projection && cached.blend === blend && cached.exaggeration === exaggeration) return cached.surface;
    const positions = new Float64Array(mesh.positions.length), physicalHeights = new Float64Array(mesh.positions.length / 3);
    const mercator = getGeographicProjectionProcedure('web-mercator'), globe = getGeographicProjectionProcedure('globe');
    for (let vertex = 0; vertex < physicalHeights.length; vertex++) {
        const offset = vertex * 3, current = mesh.heights[vertex * 2], previous = mesh.heights[vertex * 2 + 1];
        const height = previous + (current - previous) * blend;
        physicalHeights[vertex] = mesh.positions[offset + 2] + height;
        const position: [number, number, number] = [mesh.positions[offset], mesh.positions[offset + 1], mesh.positions[offset + 2] + height * exaggeration];
        positions.set(projection === 'globe' ? globe.project(mercator.unproject(position)) : position, offset);
    }
    // No per-frame hierarchy allocations during morphing; settled meshes reuse this owner.
    const surface = new TerrainMeshSurface({projection, positions, indices: mesh.indices, physicalHeights, cullBackfaces: projection === 'globe', maxQueryIndexBytes: 0});
    projectedQueries.set(mesh, {projection, blend, exaggeration, surface});
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
    private readonly queryOwners: {surface?: TerrainMeshSurface; projectionBuilds: number; preparationMs: number; queryMs: number}[];
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

    /** Capture displacement without copying/projecting every mesh until it is queried. */
    constructor(projection: TerrainSurface['projection'], entries: readonly DrapedTerrainQueryEntry[], generation: number, frameTime: number, exaggeration: number) {
        if (!Number.isSafeInteger(generation) || generation < 0 || !Number.isFinite(frameTime) || !Number.isFinite(exaggeration) || exaggeration < 0 || exaggeration > 1000) throw new Error('Invalid terrain surface frame');
        const queryOwners: DrapedTerrainSurfaceSnapshot['queryOwners'] = [];
        const surfaces: TerrainSurfaceEntry[] = entries.map(entry => {
            if (!Number.isFinite(entry.blend) || entry.blend < 0 || entry.blend > 1) throw new Error('Invalid terrain surface blend');
            const mesh = entry.mesh;
            if (mesh.positions.length % 3 || mesh.heights.length !== mesh.positions.length / 3 * 2) throw new Error('Invalid terrain query channels');
            const blend = entry.blend, clips = entry.clips?.map(bounds => [...bounds]);
            if (clips?.some(bounds => bounds.length !== 4 || !bounds.every(Number.isFinite) || bounds[0] > bounds[2] || bounds[1] > bounds[3])) throw new Error('Invalid terrain query clip');
            const owner: DrapedTerrainSurfaceSnapshot['queryOwners'][number] = {projectionBuilds: 0, preparationMs: 0, queryMs: 0};
            queryOwners.push(owner);
            return {id: entry.id, surface: {projection, intersectRay(ray, maximum) {
                if (projection === 'web-mercator' && !intersectsFootprint(ray, maximum, mesh.bounds)) return null;
                if (!owner.surface) {
                    const cached = projectedQueries.get(mesh), started = performance.now();
                    owner.projectionBuilds = Number(cached?.projection !== projection || cached.blend !== blend || cached.exaggeration !== exaggeration);
                    owner.surface = getProjectedSurface(mesh, projection, blend, exaggeration);
                    owner.preparationMs += performance.now() - started;
                }
                const started = performance.now();
                const hit = owner.surface.intersectRay(ray, maximum, clips ? (_point, triangleIndex, weights) => {
                    // The draw clips its interpolated tile-position varying, not the inverse
                    // geographic projection of the curved triangle's common-space hit.
                    const position = [0, 1].map(axis => weights.reduce((value, weight, vertex) => value + weight * mesh.positions[mesh.indices[triangleIndex * 3 + vertex] * 3 + axis], 0));
                    return clips.some(bounds => position[0] >= bounds[0] && position[0] <= bounds[2] && position[1] >= bounds[1] && position[1] <= bounds[3]);
                } : undefined);
                owner.queryMs += performance.now() - started;
                return hit;
            }}};
        });
        super(projection, surfaces);
        this.generation = generation; this.frameTime = frameTime; this.exaggeration = exaggeration;
        this.queryOwners = queryOwners;
        this.inputBytes = entries.reduce((bytes, entry) => bytes + entry.mesh.positions.byteLength + entry.mesh.heights.byteLength + entry.mesh.indices.byteLength, 0);
        this.displayKey = `${generation}/${exaggeration}/${entries.map(entry => `${entry.id}:${entry.blend}`).join(',')}`;
    }

    /** Detached snapshot-local CPU query costs; excludes other retained host snapshots and GPU/transient storage. */
    getStatistics(): {inputBytes: number; projectedBytes: number; preparedMeshes: number; projectionBuilds: number; preparationMs: number; queryMs: number} {
        const statistics = {inputBytes: this.inputBytes, projectedBytes: 0, preparedMeshes: 0, projectionBuilds: 0, preparationMs: 0, queryMs: 0};
        for (const owner of this.queryOwners) {
            statistics.projectedBytes += owner.surface?.getStatistics().geometryBytes ?? 0;
            statistics.preparedMeshes += Number(owner.surface !== undefined);
            statistics.projectionBuilds += owner.projectionBuilds;
            statistics.preparationMs += owner.preparationMs; statistics.queryMs += owner.queryMs;
        }
        return statistics;
    }
}
