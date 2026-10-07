// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type VertexLayout from '../gl/vertex_layout';

/** Initial CPU basemap projections; no arbitrary CRS or dynamic camera projection. */
export type ProjectedBasemapOptions = {
    /** Spherical projection, with fixed documented origins and standard parallels. */
    type: 'equal-earth' | 'albers' | 'equirectangular';
    /** Maximum Mercator angular edge span before projection; defaults to four degrees. */
    maxAngularSpan?: number;
    /** Per-mesh additional vertex budget; defaults to 65,536. */
    maxAdditionalVertices?: number;
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
    tile: {min: {x: number; y: number}; coords: {z: number}};
    /** Validated scene-wide projection and refinement limits. */
    projection: ProjectedBasemapOptions;
}

/** Synchronous worker procedure; returned bytes are transferred through the existing mesh protocol. */
export type MeshProjector = (request: MeshProjectionRequest) => {
    vertices: Uint8Array;
    indices: Uint16Array | Uint32Array;
};

let meshProjector: MeshProjector | undefined;

/** Install the optional CPU projector in this worker without importing math.gl into normal bundles. */
export function registerMeshProjector(projector: MeshProjector): void {
    if (typeof projector !== 'function') throw new Error('Mesh projector requires a function');
    if (meshProjector) throw new Error('Mesh projector is already registered');
    meshProjector = projector;
}

/** Fail explicitly when a projected scene omitted its opt-in worker script. */
export function projectTileMesh(request: MeshProjectionRequest): ReturnType<MeshProjector> {
    if (!meshProjector) throw new Error('CPU projection requires the projected-basemaps worker script');
    return meshProjector(request);
}

/** Validate serialized scene options before layouts, shaders or meshes are created. */
export function normalizeProjectedBasemapOptions(value: unknown): ProjectedBasemapOptions {
    if (!value || typeof value !== 'object' || !('type' in value) ||
        !['equal-earth', 'albers', 'equirectangular'].includes(String(value.type))) {
        throw new Error('CPU projection requires equal-earth, albers or equirectangular');
    }
    const maxAngularSpan = 'maxAngularSpan' in value ? value.maxAngularSpan : 4;
    const maxAdditionalVertices = 'maxAdditionalVertices' in value ? value.maxAdditionalVertices : 65536;
    if (typeof maxAngularSpan !== 'number' || !Number.isFinite(maxAngularSpan) || maxAngularSpan < 1 || maxAngularSpan > 30 ||
        typeof maxAdditionalVertices !== 'number' || !Number.isSafeInteger(maxAdditionalVertices) ||
        maxAdditionalVertices < 0 || maxAdditionalVertices > 262144) {
        throw new Error('CPU projection requires angular span in [1, 30] and vertex budget in [0, 262144]');
    }
    const type = value.type;
    if (type !== 'equal-earth' && type !== 'albers' && type !== 'equirectangular') throw new Error('Invalid CPU projection');
    return {type, maxAngularSpan, maxAdditionalVertices};
}
