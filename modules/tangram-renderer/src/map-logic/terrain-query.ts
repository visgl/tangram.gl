// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {TerrainSurface, TerrainSurfaceHit, TerrainSurfaceBounds, TerrainRay} from '../selection/terrain_surface';

/** Read-only structural hit accepted from loaders.gl-compatible terrain providers. */
export type TerrainQueryHit = Omit<TerrainSurfaceHit, 'position' | 'coordinate' | 'normal' | 'barycentric'> & {
    /** Displayed XYZ in the provider's content units. */
    readonly position: readonly [number, number, number];
    /** Longitude/latitude degrees and unexaggerated physical source meters. */
    readonly coordinate: readonly [number, number, number];
    /** Unit normal following displayed winding. */
    readonly normal: readonly [number, number, number];
    /** Original triangle vertex order. */
    readonly barycentric: readonly [number, number, number];
};

/**
 * Structural loaders.gl terrain surface contract. No package-version, GPU, deck or
 * HostFrame dependency is introduced. The provider owns its current displayed generation.
 */
export interface TerrainQuerySource {
    /** Mercator XYZ meters or host-defined center-relative globe common units. */
    readonly projection: TerrainSurface['projection'];
    /** Nearest loaded hit, with distance independent of direction length; misses do not certify coverage. */
    intersectRay(ray: TerrainRay, maxDistance?: number): TerrainQueryHit | null;
    /** Optional conservative displayed envelope; null means empty, absence means unknown. */
    getBounds?(): {readonly minimum: readonly [number, number, number]; readonly maximum: readonly [number, number, number]} | null;
}

/**
 * Borrow a shared terrain query provider without taking disposal or index ownership.
 * Preserve Tangram's mutable result API using detached tuples. In particular, physical
 * coordinate altitude is not reconstructed from exaggerated displayed positions.
 */
export function adaptTerrainQuerySource(source: TerrainQuerySource): TerrainSurface {
    if (!['web-mercator', 'globe'].includes(source.projection)) throw new Error('Invalid terrain query projection');
    const adapter: TerrainSurface = {
        projection: source.projection,
        intersectRay(ray, maxDistance) {
            const hit = source.intersectRay(ray, maxDistance);
            return hit ? {...hit, position: [...hit.position], coordinate: [...hit.coordinate], normal: [...hit.normal], barycentric: [...hit.barycentric]} : null;
        }
    };
    if (source.getBounds) adapter.getBounds = (): TerrainSurfaceBounds | null => {
        const bounds = source.getBounds?.();
        return bounds ? {minimum: [...bounds.minimum], maximum: [...bounds.maximum]} : null;
    };
    return adapter;
}
