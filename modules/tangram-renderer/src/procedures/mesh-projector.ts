// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type VertexLayout from '../gl/vertex_layout';

/** Detached accounting for optional projection-independent worker preparation. */
export interface MeshPreparationStatistics {
    /** Number of retained source meshes. */
    entries: number;
    /** Retained original/prepared typed-array bytes. */
    bytes: number;
    /** Successful preparation reuses. */
    hits: number;
    /** Requests requiring a new preparation. */
    misses: number;
    /** Optional detached statistics for the independently bounded, opt-in projected output cache. */
    projectedResults?: {entries: number; bytes: number; hits: number; misses: number};
}

/** Cumulative projection work in one worker, reset with source preparation; not resident GPU memory. */
export interface MeshProjectionStatistics {
    /** Meshes whose projection completed successfully. */
    completedMeshes: number;
    /** Requests rejected by preparation, refinement or the projection engine. */
    failedMeshes: number;
    /** Original packed vertices across completed requests. */
    sourceVertices: number;
    /** Final vertices across completed requests, including unchanged originals. */
    outputVertices: number;
    /** Final triangles across completed requests. */
    outputTriangles: number;
    /** Projector batches submitted, including samples and failed requests. */
    projectionBatches: number;
    /** Coordinate pairs submitted to local or host kernels. */
    projectedPositions: number;
    /** Successful sampled edge-refinement rounds. */
    edgeRounds: number;
    /** Successful sampled interior-refinement rounds. */
    interiorRounds: number;
}

/** Initial CPU basemap projections; no arbitrary CRS or dynamic camera projection. */
export type ProjectedBasemapOptions = {
    /** Projection with fixed documented ellipsoid, origin and standard parallels. */
    type: 'equal-earth' | 'albers' | 'equirectangular' | 'mercator' | 'web-mercator';
    /** Maximum Mercator angular edge span before projection; defaults to four degrees. */
    maxAngularSpan?: number;
    /** Per-mesh additional vertex budget; defaults to 65,536. */
    maxAdditionalVertices?: number;
    /** Optional sampled edge/interior error in common units; ribbons use edges only. */
    maxProjectedError?: number;
    /** Reuse completed projected meshes; host engines require a stable worker-local cache identity. */
    cacheProjectedMeshes?: boolean;
};

/** Worker-local packed triangle input; the original tile coordinates must survive. */
export interface MeshProjectionRequest {
    /** Finalized interleaved vertex bytes. */
    vertices: Uint8Array;
    /** Triangle indices or an unindexed triangle stream. */
    indices: Uint16Array | Uint32Array | false;
    /** Layout shared by main-thread and worker polygon styles. */
    layout: VertexLayout;
    /** Source tile's north-west EPSG:3857 origin and actual data zoom. */
    tile: {min: {x: number; y: number}; coords: {z: number}; overzoom2?: number; style_z?: number};
    /** Lines carry centerline positions and separate packed extrusion; other meshes are already expanded. */
    geometry?: 'polygons' | 'raster' | 'lines' | 'points' | 'text';
    /** Validated scene-wide projection and refinement limits. */
    projection: ProjectedBasemapOptions;
    /** Optional worker-local bridge to a caller-owned host engine; never serialized with the scene. */
    projectPositions?: (coordinates: Float64Array) => Promise<Float64Array>;
    /** Immutable host transform identity for opt-in result caching; absence bypasses host result caching. */
    projectionCacheKey?: string;
}

/** Completed packed mesh, independent of projection backend ownership. */
export type ProjectedMesh = {
    vertices: Uint8Array;
    indices: Uint16Array | Uint32Array;
};

/** Worker procedure; a host-injected backend may require an asynchronous batch round trip. */
export type MeshProjector = (request: MeshProjectionRequest) => ProjectedMesh | Promise<ProjectedMesh>;

let meshProjector: MeshProjector | undefined;

/** Validate fixed or strictly ordered zoom-stop distances with one unit across every stop. */
export function getProjectedRoadUnit(value: unknown, positive = true): 'm' | 'px' {
    const parse = (distance: unknown): 'm' | 'px' => {
        const match = typeof distance === 'string' ? /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(m|px)\s*$/.exec(distance) : null;
        const number = typeof distance === 'number' ? distance : match ? Number(match[1]) : NaN;
        if (!Number.isFinite(number) || (positive && number <= 0)) throw new Error('Projected roads require finite distances and positive widths');
        return match?.[2] === 'px' ? 'px' : 'm';
    };
    if (!Array.isArray(value)) return parse(value);
    if (!value.length) throw new Error('Projected road zoom stops must not be empty');
    let previousZoom = -Infinity;
    let unit: 'm' | 'px' | undefined;
    for (const stop of value) {
        if (!Array.isArray(stop) || stop.length !== 2 || typeof stop[0] !== 'number' ||
            !Number.isFinite(stop[0]) || stop[0] < 0 || stop[0] > 22 || stop[0] <= previousZoom) {
            throw new Error('Projected road zoom stops require strictly increasing levels in [0, 22]');
        }
        previousZoom = stop[0];
        const current = parse(stop[1]);
        if (unit && unit !== current) throw new Error('Projected road zoom stops must keep one unit');
        unit = current;
    }
    if (!unit) throw new Error('Projected road zoom stops must not be empty');
    return unit;
}
let clearPreparation: (() => void) | undefined;
let getPreparationStatistics: (() => MeshPreparationStatistics) | undefined;
let getProjectionStatistics: (() => MeshProjectionStatistics) | undefined;

/** Install the optional CPU projector in this worker without importing math.gl into normal bundles. */
export function registerMeshProjector(projector: MeshProjector, clear?: () => void,
    getStatistics?: () => MeshPreparationStatistics, getWorkStatistics?: () => MeshProjectionStatistics): void {
    if (typeof projector !== 'function') throw new Error('Mesh projector requires a function');
    if (meshProjector) throw new Error('Mesh projector is already registered');
    meshProjector = projector;
    clearPreparation = clear;
    getPreparationStatistics = getStatistics;
    getProjectionStatistics = getWorkStatistics;
}

/** Release optional worker preparation at reset without importing its implementation in the core. */
export function clearMeshProjectorPreparation(): void {
    clearPreparation?.();
}

/** Snapshot optional preparation diagnostics without importing the projected worker in the core. */
export function getMeshProjectorPreparationStatistics(): MeshPreparationStatistics | undefined {
    return getPreparationStatistics?.();
}

/** Snapshot optional projection work without importing projection kernels into renderer core. */
export function getMeshProjectorWorkStatistics(): MeshProjectionStatistics | undefined {
    return getProjectionStatistics?.();
}

/** Fail explicitly when a projected scene omitted its opt-in worker script. */
export function projectTileMesh(request: MeshProjectionRequest): ReturnType<MeshProjector> {
    if (!meshProjector) throw new Error('CPU projection requires the projected-basemaps worker script');
    return meshProjector(request);
}

/** Validate serialized scene options before layouts, shaders or meshes are created. */
export function normalizeProjectedBasemapOptions(value: unknown): ProjectedBasemapOptions {
    if (!value || typeof value !== 'object' || !('type' in value) ||
        !['equal-earth', 'albers', 'equirectangular', 'mercator', 'web-mercator'].includes(String(value.type))) {
        throw new Error('CPU projection requires equal-earth, albers, equirectangular, mercator or web-mercator');
    }
    const maxAngularSpan = 'maxAngularSpan' in value ? value.maxAngularSpan : 4;
    const maxAdditionalVertices = 'maxAdditionalVertices' in value ? value.maxAdditionalVertices : 65536;
    const maxProjectedError = 'maxProjectedError' in value ? value.maxProjectedError : undefined;
    const cacheProjectedMeshes = 'cacheProjectedMeshes' in value ? value.cacheProjectedMeshes : false;
    if (typeof cacheProjectedMeshes !== 'boolean') throw new Error('CPU projection mesh caching must be boolean');
    if (maxProjectedError !== undefined && (typeof maxProjectedError !== 'number' || !Number.isFinite(maxProjectedError) || maxProjectedError <= 0)) {
        throw new Error('CPU projection requires a positive finite projected error');
    }
    if (typeof maxAngularSpan !== 'number' || !Number.isFinite(maxAngularSpan) || maxAngularSpan < 1 || maxAngularSpan > 30 ||
        typeof maxAdditionalVertices !== 'number' || !Number.isSafeInteger(maxAdditionalVertices) ||
        maxAdditionalVertices < 0 || maxAdditionalVertices > 262144) {
        throw new Error('CPU projection requires angular span in [1, 30] and vertex budget in [0, 262144]');
    }
    const type = value.type;
    if (type !== 'equal-earth' && type !== 'albers' && type !== 'equirectangular' &&
        type !== 'mercator' && type !== 'web-mercator') throw new Error('Invalid CPU projection');
    return {type, maxAngularSpan, maxAdditionalVertices, ...(maxProjectedError === undefined ? {} : {maxProjectedError}),
        ...(cacheProjectedMeshes ? {cacheProjectedMeshes: true} : {})};
}
