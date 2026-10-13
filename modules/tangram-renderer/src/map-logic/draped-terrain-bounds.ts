// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {getGeographicProjectionProcedure, PROJECTION_CONSTANTS} from '../scene/projection_math';

/** Immutable worker query channels; no scene, GPU, provider or query-index ownership. */
interface DrapedTerrainBoundsInput {
    /** Absolute Mercator XYZ, with authored offsets in meters. */
    positions: Float64Array;
    /** Current/previous physical DEM heights, interleaved per vertex. */
    heights: Float32Array;
    /** Actual rendered triangle indices. */
    indices: Uint16Array | Uint32Array;
    /** Optional trusted worker summary of these exact immutable channels. */
    boundsSummary?: DrapedTerrainBoundsSummary;
}

/** Independent channel extrema enclose every convex rendered triangle throughout its height morph. */
export interface DrapedTerrainBoundsSummary {
    /** Radius-one globe directions of indexed vertices, not geographic rectangle corners. */
    directions: {minimum: [number, number, number]; maximum: [number, number, number]};
    /** Authored meter offsets, independent of relief exaggeration. */
    offsets: readonly [number, number];
    /** Physical current/previous DEM endpoints, conservatively enclosing all morph fractions. */
    heights: readonly [number, number];
}

/** Compatibility owners without worker summaries pay one indexed scan, never one scan per eye/frame. */
const boundsSummaries = new WeakMap<DrapedTerrainBoundsInput, DrapedTerrainBoundsSummary>();

/** Compute bounds from the actual indexed vertices so long globe chords and unwrapped tiles remain enclosed. */
export function summarizeDrapedTerrainBounds(mesh: DrapedTerrainBoundsInput): DrapedTerrainBoundsSummary {
    const cached = mesh.boundsSummary ?? boundsSummaries.get(mesh);
    if (cached) return cached;
    const directions: DrapedTerrainBoundsSummary['directions'] = {minimum: [Infinity, Infinity, Infinity], maximum: [-Infinity, -Infinity, -Infinity]};
    const offsets: [number, number] = [Infinity, -Infinity], heights: [number, number] = [Infinity, -Infinity];
    const mercator = getGeographicProjectionProcedure('web-mercator'), globe = getGeographicProjectionProcedure('globe');
    for (const vertex of mesh.indices) {
        if (vertex * 3 + 2 >= mesh.positions.length) throw new Error('Invalid terrain bounds index');
        const position = [mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1], mesh.positions[vertex * 3 + 2]] as const;
        const current = mesh.heights[vertex * 2], previous = mesh.heights[vertex * 2 + 1];
        if (![...position, current, previous].every(Number.isFinite)) throw new Error('Invalid terrain bounds channels');
        const direction = globe.project(mercator.unproject([position[0], position[1], 0]));
        for (const axis of [0, 1, 2]) {
            directions.minimum[axis] = Math.min(directions.minimum[axis], direction[axis] / PROJECTION_CONSTANTS.globeRadius);
            directions.maximum[axis] = Math.max(directions.maximum[axis], direction[axis] / PROJECTION_CONSTANTS.globeRadius);
        }
        offsets[0] = Math.min(offsets[0], position[2]); offsets[1] = Math.max(offsets[1], position[2]);
        heights[0] = Math.min(heights[0], current, previous); heights[1] = Math.max(heights[1], current, previous);
    }
    const summary = {directions, offsets, heights}; boundsSummaries.set(mesh, summary); return summary;
}
