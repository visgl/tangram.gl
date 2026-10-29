// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {TerrainSurfaceCollection, sampleTerrainElevation, PROJECTION_CONSTANTS} from '@tangram.gl/tangram-renderer/core';
import type {LoadedTerrain} from './load-terrain';
import type {TerrainSurface} from '@tangram.gl/tangram-renderer/core';

/** Sample the highest loaded top triangle at a geographic anchor, excluding visual skirts. */
export function sampleTerrainAnchor(tiles: Iterable<LoadedTerrain>, coordinate: readonly [number, number], clearance: number, displayedSurface?: TerrainSurface): number | null {
    if (!coordinate.every(Number.isFinite) || Math.abs(coordinate[1]) > 90 || !Number.isFinite(clearance) || clearance < 0) throw new Error('Invalid terrain anchor or physical clearance');
    if (Math.abs(coordinate[1]) > PROJECTION_CONSTANTS.maxMercatorLatitude) return null;
    const longitude = ((coordinate[0] + 180) % 360 + 360) % 360 - 180;
    if (displayedSurface) {
        // Reference example's physical-meter bracket; never fall back to a different mesh on a miss.
        const hit = sampleTerrainElevation(displayedSurface, [longitude, coordinate[1]], {minimumAltitude: -12000, maximumAltitude: 12000});
        return hit ? hit.position[2] + clearance : null;
    }
    const entries: {id: string; surface: LoadedTerrain['surface']}[] = [];
    let minimum = Infinity, maximum = -Infinity;
    for (const tile of tiles) {
        const bounds = tile.mesh.header?.boundingBox;
        // Avoid constructing query indexes for every visible tile on each camera move.
        if (!bounds || !Number.isFinite(bounds[1][2]) || longitude < bounds[0][0] || longitude > bounds[1][0] || coordinate[1] < bounds[0][1] || coordinate[1] > bounds[1][1]) continue;
        const actual = tile.surface.getBounds();
        if (!actual) continue;
        minimum = Math.min(minimum, actual.minimum[2]); maximum = Math.max(maximum, actual.maximum[2]);
        entries.push({id: String(entries.length), surface: tile.surface});
    }
    if (!entries.length) return null;
    const collection = new TerrainSurfaceCollection('web-mercator', entries);
    const hit = sampleTerrainElevation(collection, [longitude, coordinate[1]], {minimumAltitude: minimum - 1, maximumAltitude: maximum + 1});
    return hit ? hit.position[2] + clearance : null;
}
