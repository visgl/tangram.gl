// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Matrix4, Vector3} from '@math.gl/core';
import {intersectRayBounds, intersectRayTriangle} from '@math.gl/culling/queries';
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
}

/** Small immutable reference implementation; large tilesets may inject an indexed surface. */
export class TerrainMeshSurface implements TerrainSurface {
    /** Mercator XY/physical Z meters, or already projected globe common coordinates. */
    readonly projection: TerrainSurface['projection'];
    /** Detached vertex snapshot. */
    private readonly positions: Float64Array;
    /** Detached triangle topology. */
    private readonly indices: Uint32Array;
    /** Overall lower bounds for rejecting rays before triangle traversal. */
    private readonly minimum: [number, number, number] = [Infinity, Infinity, Infinity];
    /** Overall upper bounds; an empty mesh never reaches traversal. */
    private readonly maximum: [number, number, number] = [-Infinity, -Infinity, -Infinity];

    /** Copy a finite indexed triangle mesh; mutation of caller buffers cannot change queries. */
    constructor(options: TerrainMeshOptions) {
        if (!['web-mercator', 'globe'].includes(options.projection)) throw new Error('Terrain projection must be web-mercator or globe');
        if (options.positions.length % 3 || options.indices.length % 3) throw new Error('Terrain requires XYZ positions and triangle indices');
        const positions = Array.from(options.positions);
        const indices = Array.from(options.indices);
        if (!positions.every(Number.isFinite) || !indices.every(index => Number.isSafeInteger(index) && index >= 0 && index < positions.length / 3)) {
            throw new Error('Terrain mesh positions and indices must be finite and in range');
        }
        this.projection = options.projection;
        this.positions = new Float64Array(positions);
        this.indices = new Uint32Array(indices);
        for (let index = 0; index < positions.length; index++) {
            const axis = index % 3;
            this.minimum[axis] = Math.min(this.minimum[axis], positions[index]);
            this.maximum[axis] = Math.max(this.maximum[axis], positions[index]);
        }
    }

    /** Two-sided math.gl triangle queries; O(triangles), with an overall bounds rejection. */
    intersectRay(ray: TerrainRay, maxDistance = Infinity): TerrainSurfaceHit | null {
        if (maxDistance < 0 || Number.isNaN(maxDistance)) throw new Error('Terrain ray distance must be non-negative');
        const length = Math.hypot(...ray.direction);
        if (ray.origin.length !== 3 || ray.direction.length !== 3 || !ray.origin.every(Number.isFinite) ||
            !ray.direction.every(Number.isFinite) || !Number.isFinite(length) || length === 0 || !this.indices.length) return null;
        const direction: [number, number, number] = [ray.direction[0] / length, ray.direction[1] / length, ray.direction[2] / length];
        if (intersectRayBounds(ray.origin, direction, this.minimum, this.maximum, maxDistance) === null) return null;
        let result: TerrainSurfaceHit | null = null;
        for (let index = 0; index < this.indices.length; index += 3) {
            const vertices = [0, 1, 2].map((offset): [number, number, number] => {
                const start = this.indices[index + offset] * 3;
                return [this.positions[start], this.positions[start + 1], this.positions[start + 2]];
            });
            const hit = intersectRayTriangle(ray.origin, direction, vertices[0], vertices[1], vertices[2],
                {maxT: result?.distance ?? maxDistance});
            if (!hit || result && hit.t >= result.distance) continue;
            const position: [number, number, number] = [ray.origin[0] + direction[0] * hit.t,
                ray.origin[1] + direction[1] * hit.t, ray.origin[2] + direction[2] * hit.t];
            if (this.projection === 'globe' && Math.hypot(...position) === 0) continue;
            const normal = new Vector3(vertices[1]).subtract(vertices[0]).cross(new Vector3(vertices[2]).subtract(vertices[0])).normalize();
            result = {position, coordinate: getGeographicProjectionProcedure(this.projection).unproject(position),
                distance: hit.t, normal: [normal[0], normal[1], normal[2]], triangleIndex: index / 3, barycentric: hit.barycentric};
        }
        return result;
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
