// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {projectGeographicPosition} from '@vis.gl/tangram-renderer/core';
import type {LoadedTerrain} from './load-terrain';

/** Sample the highest loaded top triangle at a geographic anchor, excluding visual skirts. */
export function sampleTerrainAnchor(tiles: Iterable<LoadedTerrain>, coordinate: readonly [number, number], clearance: number): number | null {
    if (!coordinate.every(Number.isFinite) || Math.abs(coordinate[1]) > 85.0511287798 || !Number.isFinite(clearance) || clearance < 0) throw new Error('Invalid terrain anchor or physical clearance');
    const projected = projectGeographicPosition([coordinate[0], coordinate[1], 0], 'web-mercator');
    let elevation: number | null = null;
    for (const tile of tiles) {
        const bounds = tile.mesh.header?.boundingBox;
        if (!bounds || !Number.isFinite(bounds[1][2])) continue;
        const hit = tile.surface.intersectRay({origin: [projected[0], projected[1], bounds[1][2] + 1], direction: [0, 0, -1]});
        if (hit && (elevation === null || hit.position[2] > elevation)) elevation = hit.position[2];
    }
    return elevation === null ? null : elevation + clearance;
}
