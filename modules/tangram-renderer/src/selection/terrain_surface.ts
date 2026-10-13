// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Matrix4, Vector3} from '@math.gl/core';
import {TriangleQueryIndex} from '../map-logic/triangle-query-index';
import type HostFrame from '../scene/host_frame';
import {getGeographicProjectionProcedure, PROJECTION_CONSTANTS} from '../scene/projection_math';
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
    /** Caller collection identity; absent on an individual surface query. */
    surfaceId?: string;
}

/** Host-owned terrain query boundary; it does not load, render or displace a DEM. */
export interface TerrainSurface {
    /** Coordinate convention of both the mesh and rays. */
    readonly projection: 'web-mercator' | 'globe';
    /** Return the nearest two-sided hit within the finite camera segment, or null. */
    intersectRay(ray: TerrainRay, maxDistance?: number): TerrainSurfaceHit | null;
}

/** One stable caller-owned surface identity; collections snapshot membership, not geometry. */
export interface TerrainSurfaceEntry {
    /** Unique nonempty identifier used to distinguish triangle offsets in different tiles. */
    id: string;
    /** Immutable terrain query owner, using the collection's projection. */
    surface: TerrainSurface;
}

/** Nearest collection hit with the identity of its owning tile/surface. */
export interface TerrainCollectionHit extends TerrainSurfaceHit {
    /** Original caller identity, unaffected by nearest-hit clipping. */
    surfaceId: string;
}

/** Explicit geographic probe bracket; altitude values describe displayed geometry, not source elevation. */
export interface TerrainElevationProbe {
    /** Lower geographic altitude in meters; must be strictly below maximumAltitude. */
    minimumAltitude: number;
    /** Upper geographic altitude in meters, above every surface that should be considered. */
    maximumAltitude: number;
    /** Optional Mercator longitude anchor for unwrapped tile coordinates. */
    anchorLongitude?: number;
}

/** Snapshot tile membership and query nearest geometry without owning sources, views, buffers or resources. */
export class TerrainSurfaceCollection implements TerrainSurface {
    /** Shared absolute coordinate convention; mixed projections reject at construction. */
    readonly projection: TerrainSurface['projection'];
    /** Snapshotted membership and caller identities, retaining owners without copying their geometry. */
    private readonly entries: readonly TerrainSurfaceEntry[];

    /** Retain immutable surface references with unique IDs; caller membership changes do not affect this collection. */
    constructor(projection: TerrainSurface['projection'], entries: readonly TerrainSurfaceEntry[]) {
        if (!['web-mercator', 'globe'].includes(projection)) throw new Error('Terrain collection projection must be web-mercator or globe');
        this.projection = projection;
        this.entries = entries.map(({id, surface}) => {
            if (typeof id !== 'string' || !id.length || surface.projection !== projection) throw new Error('Terrain collection requires nonempty IDs and matching projections');
            return Object.freeze({id, surface});
        });
        if (new Set(this.entries.map(entry => entry.id)).size !== this.entries.length) throw new Error('Terrain collection IDs must be unique');
    }

    /** Clip farther tiles after an accepted hit; equal-distance ties retain original membership order. */
    intersectRay(ray: TerrainRay, maxDistance = Infinity): TerrainCollectionHit | null {
        if (maxDistance < 0 || Number.isNaN(maxDistance)) throw new Error('Terrain ray distance must be non-negative');
        const length = Math.hypot(...ray.direction);
        if (ray.origin.length !== 3 || ray.direction.length !== 3 || !ray.origin.every(Number.isFinite) || !ray.direction.every(Number.isFinite) || !Number.isFinite(length) || length === 0) return null;
        let nearest: TerrainCollectionHit | null = null;
        for (const entry of this.entries) {
            const hit = entry.surface.intersectRay(ray, nearest?.distance ?? maxDistance);
            if (hit && (!nearest || hit.distance < nearest.distance)) nearest = {...hit, surfaceId: entry.id};
        }
        return nearest;
    }

    /** Query a finite content-space sightline; misses mean no loaded triangle hit, not certified world visibility. */
    intersectSegment(start: readonly [number, number, number], end: readonly [number, number, number], options: {
        /** Trim origin self-intersections, in mesh coordinate units; defaults to zero. */
        startInset?: number;
        /** Trim target self-intersections, in mesh coordinate units; defaults to zero. */
        endInset?: number;
    } = {}): TerrainCollectionHit | null {
        const startInset = options.startInset ?? 0, endInset = options.endInset ?? 0;
        if (start.length !== 3 || end.length !== 3 || !start.every(Number.isFinite) || !end.every(Number.isFinite) || ![startInset, endInset].every(value => Number.isFinite(value) && value >= 0)) throw new Error('Terrain segment requires finite endpoints and non-negative finite insets');
        const direction: [number, number, number] = [end[0] - start[0], end[1] - start[1], end[2] - start[2]], length = Math.hypot(...direction);
        if (!Number.isFinite(length)) throw new Error('Terrain segment length must be finite');
        if (length === 0 || startInset + endInset >= length) return null;
        const origin: [number, number, number] = [start[0] + direction[0] * startInset / length, start[1] + direction[1] * startInset / length, start[2] + direction[2] * startInset / length];
        const hit = this.intersectRay({origin, direction}, length - startInset - endInset);
        return hit ? {...hit, distance: hit.distance + startInset} : null;
    }
}

/** Probe loaded top triangles along geographic up; returned coordinate altitude retains physical source meters. */
export function sampleTerrainElevation(surface: TerrainSurface, coordinate: readonly [number, number], options: TerrainElevationProbe): TerrainSurfaceHit | null {
    if (coordinate.length !== 2 || !coordinate.every(Number.isFinite) || Math.abs(coordinate[1]) > 90 ||
        ![options.minimumAltitude, options.maximumAltitude].every(Number.isFinite) || options.minimumAltitude >= options.maximumAltitude ||
        options.anchorLongitude !== undefined && !Number.isFinite(options.anchorLongitude)) throw new Error('Invalid terrain elevation probe');
    const projection = getGeographicProjectionProcedure(surface.projection);
    if (Math.abs(coordinate[1]) > projection.latitudeLimit) return null;
    // A radial bracket must not cross the globe center and sample its far hemisphere.
    if (surface.projection === 'globe' && options.minimumAltitude <= -PROJECTION_CONSTANTS.earthRadius) throw new Error('Globe elevation probes must remain above the center');
    const origin = projection.project([coordinate[0], coordinate[1], options.maximumAltitude], options.anchorLongitude);
    const end = projection.project([coordinate[0], coordinate[1], options.minimumAltitude], options.anchorLongitude);
    const direction: [number, number, number] = [end[0] - origin[0], end[1] - origin[1], end[2] - origin[2]];
    if (!origin.every(Number.isFinite) || !end.every(Number.isFinite) || !Number.isFinite(Math.hypot(...direction))) throw new Error('Terrain elevation probe exceeds finite projection range');
    return surface.intersectRay({origin, direction}, Math.hypot(...direction));
}

/** Resolve a Mercator camera/anchor floor; this is a point probe, not swept-volume collision or locomotion. */
export function resolveTerrainClearance(surface: TerrainSurface, coordinate: readonly [number, number, number], clearance: number, options: TerrainElevationProbe): {
    /** Geographic position raised only when it lies below displayed terrain plus clearance. */
    coordinate: [number, number, number];
    /** Source elevation meters, independent of any caller-provided display displacement. */
    physicalElevation: number;
    /** True when the supplied altitude was raised. */
    adjusted: boolean;
} | null {
    if (surface.projection !== 'web-mercator') throw new Error('Terrain clearance requires a physical-meter Mercator frame');
    if (coordinate.length !== 3 || !coordinate.every(Number.isFinite) || !Number.isFinite(clearance) || clearance < 0) throw new Error('Invalid terrain clearance');
    const hit = sampleTerrainElevation(surface, [coordinate[0], coordinate[1]], options);
    if (!hit) return null;
    const altitude = Math.max(coordinate[2], hit.position[2] + clearance);
    if (!Number.isFinite(altitude)) throw new Error('Terrain clearance exceeds finite altitude range');
    return {coordinate: [coordinate[0], coordinate[1], altitude], physicalElevation: hit.coordinate[2], adjusted: altitude > coordinate[2]};
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
            this.physicalHeights = Float64Array.from(physicalHeights);
            for (let triangle = 0; triangle < this.queryIndex.triangleCount; triangle++) for (let vertex = 0; vertex < 3; vertex++) if (!Number.isFinite(this.physicalHeights[this.queryIndex.getVertexIndex(triangle, vertex)])) throw new Error('Terrain physical heights must match indexed vertices');
        }
    }

    /** Exact retained typed arrays; snapshots cannot mutate query ownership. */
    getStatistics(): TerrainMeshStatistics {
        return {geometryBytes: this.queryIndex.geometryBytes + (this.physicalHeights?.byteLength ?? 0), queryIndexBytes: this.queryIndex.hierarchyBytes, requiredQueryIndexBytes: this.queryIndex.requiredHierarchyBytes};
    }

    /** Cooperatively warm picking acceleration; queries during preparation remain exact linear queries. */
    *prepareQueryIndexSteps(): Generator<void, void, void> {yield* this.queryIndex.prepareHierarchySteps();}

    /** Detached conservative mesh bounds; no mutable geometry or acceleration buffers escape. */
    getBounds(): {minimum: [number, number, number]; maximum: [number, number, number]} | null {return this.queryIndex.getBounds();}

    /** Indexed queries; an optional display clip rejects candidates before nearest-hit selection. */
    intersectRay(ray: TerrainRay, maxDistance = Infinity, acceptPosition?: (position: readonly [number, number, number]) => boolean): TerrainSurfaceHit | null {
        if (maxDistance < 0 || Number.isNaN(maxDistance)) throw new Error('Terrain ray distance must be non-negative');
        const length = Math.hypot(...ray.direction);
        if (ray.origin.length !== 3 || ray.direction.length !== 3 || !ray.origin.every(Number.isFinite) ||
            !ray.direction.every(Number.isFinite) || !Number.isFinite(length) || length === 0 || !this.queryIndex.triangleCount) return null;
        const direction: [number, number, number] = [ray.direction[0] / length, ray.direction[1] / length, ray.direction[2] / length];
        const hit = this.queryIndex.queryRay(ray.origin, direction, maxDistance, candidate => {
            if (acceptPosition && !acceptPosition([ray.origin[0] + direction[0] * candidate.parameter, ray.origin[1] + direction[1] * candidate.parameter, ray.origin[2] + direction[2] * candidate.parameter])) return false;
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
        if (physicalHeights) coordinate[2] = hit.barycentric.reduce((height, weight, vertex) => height + weight * physicalHeights[this.queryIndex.getVertexIndex(hit.triangleIndex, vertex)], 0);
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
