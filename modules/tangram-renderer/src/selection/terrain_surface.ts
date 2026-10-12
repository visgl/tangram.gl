// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Matrix4, Vector3} from '@math.gl/core';
import {TriangleQueryIndex} from '../map-logic/triangle-query-index';
import type HostFrame from '../scene/host_frame';
import {getGeographicProjectionProcedure} from '../scene/projection_math';
import type {FeatureSelectionOptions} from '../types';

/** A ray in the same absolute content coordinates as the supplied terrain. */
export interface TerrainRay {
    /** Absolute origin, before host view and room-placement transforms. */
    origin: readonly [number, number, number];
    /** Nonzero direction; the query normalizes its length. */
    direction: readonly [number, number, number];
}

/** Nearest terrain triangle, not a worker feature ID or a GPU selection result. */
export interface TerrainSurfaceHit {
    /** Absolute EPSG:3857 meters or radius-256 globe common coordinates. */
    position: [number, number, number];
    /** Longitude/latitude degrees and physical altitude meters. */
    coordinate: [number, number, number];
    /** Distance from the ray origin in the surface's coordinate units. */
    distance: number;
    /** Normal in the supplied mesh's coordinate system, following triangle winding. */
    normal: [number, number, number];
    /** Triangle offset in the supplied index list. */
    triangleIndex: number;
    /** Vertex weights in index order. */
    barycentric: [number, number, number];
    /** Eye used for a screen query; absent for a content-space ray. */
    renderViewId?: string;
}

/** Host-owned terrain query boundary; it does not load, render or displace a DEM. */
export interface TerrainSurface {
    /** Coordinate convention of both the mesh and rays. */
    readonly projection: 'web-mercator' | 'globe';
    /** Return the nearest two-sided hit within the finite camera segment, or null. */
    intersectRay(ray: TerrainRay, maxDistance?: number): TerrainSurfaceHit | null;
}

/** Indexed content-space triangles; source buffers are copied at construction. */
export interface TerrainMeshOptions {
    /** Coordinate convention, matching the HostFrame or XR placement. */
    projection: TerrainSurface['projection'];
    /** Interleaved absolute XYZ coordinates, not tile-local positions. */
    positions: ArrayLike<number>;
    /** Three zero-based vertex indices per triangle. */
    indices: ArrayLike<number>;
    /** Optional source meters per vertex, preserving physical queries on exaggerated display meshes. */
    physicalHeights?: ArrayLike<number>;
    /** Match an outward backface-culled draw pass; default false preserves two-sided queries. */
    cullBackfaces?: boolean;
    /** Lazy hierarchy typed-array limit; exact linear picking is used when acceleration does not fit. */
    maxQueryIndexBytes?: number;
}

/** Detached retained-storage diagnostics; no GPU or JavaScript heap estimate is included. */
export interface TerrainMeshStatistics {
    /** Owned immutable positions, topology and optional physical heights. */
    geometryBytes: number;
    /** Currently allocated packed hierarchy storage. */
    queryIndexBytes: number;
    /** Required acceleration bytes, even when linear picking is selected. */
    requiredQueryIndexBytes: number;
}

/** Immutable physical terrain surface backed by the reusable CPU triangle hierarchy. */
export class TerrainMeshSurface implements TerrainSurface {
    /** Mercator XY/physical Z meters, or already projected globe common coordinates. */
    readonly projection: TerrainSurface['projection'];
    /** Optional detached physical elevations; only indexed vertices must be finite. */
    private readonly physicalHeights?: Float64Array;
    /** Optional render-pass face convention; unrelated to geographic height units. */
    private readonly cullBackfaces: boolean;
    /** Projection-independent immutable triangle query index. */
    private readonly queryIndex: TriangleQueryIndex;

    /** Copy a finite indexed triangle mesh; mutation of caller buffers cannot change queries. */
    constructor(options: TerrainMeshOptions) {
        if (!['web-mercator', 'globe'].includes(options.projection)) throw new Error('Terrain projection must be web-mercator or globe');
        if (options.positions.length % 3 || options.indices.length % 3) throw new Error('Terrain requires XYZ positions and triangle indices');
        this.projection = options.projection;
        try {
            this.queryIndex = new TriangleQueryIndex(options.positions, options.indices, 8, {lazy: true, maxHierarchyBytes: options.maxQueryIndexBytes});
        } catch (error) {throw new Error(`Terrain mesh: ${error instanceof Error ? error.message : String(error)}`);}
        this.cullBackfaces = options.cullBackfaces ?? false;
        const physicalHeights = options.physicalHeights;
        if (physicalHeights) {
            if (physicalHeights.length !== options.positions.length / 3) throw new Error('Terrain physical heights must match indexed vertices');
            for (let offset = 0; offset < options.indices.length; offset++) if (!Number.isFinite(physicalHeights[options.indices[offset]])) throw new Error('Terrain physical heights must match indexed vertices');
            this.physicalHeights = Float64Array.from(physicalHeights);
        }
    }

    /** Exact retained typed arrays; snapshots cannot mutate query ownership. */
    getStatistics(): TerrainMeshStatistics {
        return {geometryBytes: this.queryIndex.geometryBytes + (this.physicalHeights?.byteLength ?? 0), queryIndexBytes: this.queryIndex.hierarchyBytes, requiredQueryIndexBytes: this.queryIndex.requiredHierarchyBytes};
    }

    /** Two-sided indexed math.gl queries; distance is normalized to the surface's coordinate units. */
    intersectRay(ray: TerrainRay, maxDistance = Infinity): TerrainSurfaceHit | null {
        if (maxDistance < 0 || Number.isNaN(maxDistance)) throw new Error('Terrain ray distance must be non-negative');
        const length = Math.hypot(...ray.direction);
        if (ray.origin.length !== 3 || ray.direction.length !== 3 || !ray.origin.every(Number.isFinite) ||
            !ray.direction.every(Number.isFinite) || !Number.isFinite(length) || length === 0 || !this.queryIndex.triangleCount) return null;
        const direction: [number, number, number] = [ray.direction[0] / length, ray.direction[1] / length, ray.direction[2] / length];
        const hit = this.queryIndex.queryRay(ray.origin, direction, maxDistance, candidate => {
            if (this.projection === 'globe' && Math.hypot(ray.origin[0] + direction[0] * candidate.parameter,
                ray.origin[1] + direction[1] * candidate.parameter, ray.origin[2] + direction[2] * candidate.parameter) === 0) return false;
            if (!this.cullBackfaces) return true;
            const vertices = [0, 1, 2].map(vertex => this.queryIndex.getTriangleVertex(candidate.triangleIndex, vertex).position);
            const first = new Vector3(vertices[0]);
            const normal = new Vector3(vertices[1]).subtract(first).cross(new Vector3(vertices[2]).subtract(first));
            return normal.dot(direction) < 0;
        }).hit;
        if (!hit) return null;
        const index = hit.triangleIndex * 3;
        const vertices = [0, 1, 2].map(offset => this.queryIndex.getTriangleVertex(hit.triangleIndex, offset).position);
        const position: [number, number, number] = [ray.origin[0] + direction[0] * hit.parameter,
            ray.origin[1] + direction[1] * hit.parameter, ray.origin[2] + direction[2] * hit.parameter];
        const normal = new Vector3(vertices[1]).subtract(vertices[0]).cross(new Vector3(vertices[2]).subtract(vertices[0])).normalize();
        const coordinate = getGeographicProjectionProcedure(this.projection).unproject(position);
        const physicalHeights = this.physicalHeights;
        if (physicalHeights) coordinate[2] = hit.barycentric.reduce((height, weight, vertex) => height + weight * physicalHeights[this.queryIndex.getTriangleVertex(hit.triangleIndex, vertex).index], 0);
        return {position, coordinate,
            distance: hit.parameter, normal: [normal[0], normal[1], normal[2]], triangleIndex: index / 3, barycentric: hit.barycentric};
    }
}

/** Route top-origin CSS pixels through the actual HostFrame eye and its near/far segment. */
export function pickTerrainAt(frame: HostFrame, pixel: {x: number; y: number}, surface: TerrainSurface,
    options: FeatureSelectionOptions = {}, activeViewId?: string): TerrainSurfaceHit | null {
    if (surface.projection !== frame.projection.type) throw new Error('Terrain surface and HostFrame projection must match');
    if (![pixel.x, pixel.y].every(Number.isFinite)) throw new Error('Terrain query pixels must be finite');
    if (options.radius !== undefined && options.radius !== 0) throw new Error('Terrain queries select one ray, not a pixel radius');
    const resolved = frame.resolveSelectionPoint(pixel, options, activeViewId);
    if (!resolved) return null;
    const {view, pixel: local} = resolved;
    const matrix = new Matrix4(Array.from(view.camera.projection));
    // Globe HostCamera.projection already contains the host view matrix.
    if (surface.projection !== 'globe') matrix.multiplyRight(Array.from(view.camera.view));
    const determinant = matrix.determinant();
    if (!Number.isFinite(determinant) || determinant === 0) return null;
    matrix.invert();
    const x = 2 * local.x / view.viewport.width - 1;
    const y = 1 - 2 * local.y / view.viewport.height;
    const points = [-1, 1].map(z => matrix.transform([x, y, z, 1]));
    if (points.some(point => !point.every(Number.isFinite) || point[3] === 0)) return null;
    const origin: [number, number, number] = [points[0][0] / points[0][3], points[0][1] / points[0][3], points[0][2] / points[0][3]];
    const direction: [number, number, number] = [points[1][0] / points[1][3] - origin[0],
        points[1][1] / points[1][3] - origin[1], points[1][2] / points[1][3] - origin[2]];
    const hit = surface.intersectRay({origin, direction}, Math.hypot(...direction));
    return hit ? {...hit, renderViewId: view.id} : null;
}
