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
    /** Optional current/previous affine globe bases and relief vectors, twelve channels per vertex. */
    globeBasis?: Float32Array;
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
    /** Affine globe channels enclose canonical face cuts without projecting them back onto the sphere. */
    globe?: {
        /** Zero-relief common-space endpoint extrema. */
        base: {minimum: number[]; maximum: number[]};
        /** Common-space displacement per unit exaggeration. */
        relief: {minimum: number[]; maximum: number[]};
    };
}

/** Compatibility owners without worker summaries pay one indexed scan, never one scan per eye/frame. */
const boundsSummaries = new WeakMap<DrapedTerrainBoundsInput, DrapedTerrainBoundsSummary>();

/** Compute bounds from the actual indexed vertices so long globe chords and unwrapped tiles remain enclosed. */
export function summarizeDrapedTerrainBounds(mesh: DrapedTerrainBoundsInput): DrapedTerrainBoundsSummary {
    const cached = mesh.boundsSummary ?? boundsSummaries.get(mesh);
    if (cached) return cached;
    const directions: DrapedTerrainBoundsSummary['directions'] = {minimum: [Infinity, Infinity, Infinity], maximum: [-Infinity, -Infinity, -Infinity]};
    const offsets: [number, number] = [Infinity, -Infinity], heights: [number, number] = [Infinity, -Infinity];
    const globeBounds = mesh.globeBasis ? {base: {minimum: [Infinity, Infinity, Infinity], maximum: [-Infinity, -Infinity, -Infinity]},
        relief: {minimum: [Infinity, Infinity, Infinity], maximum: [-Infinity, -Infinity, -Infinity]}} : undefined;
    if (mesh.globeBasis && mesh.globeBasis.length !== mesh.positions.length * 4) throw new Error('Invalid terrain globe basis channels');
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
            if (mesh.globeBasis && globeBounds) for (const endpoint of [0, 6]) {
                const base = mesh.globeBasis[vertex * 12 + endpoint + axis], relief = mesh.globeBasis[vertex * 12 + endpoint + 3 + axis];
                if (!Number.isFinite(base) || !Number.isFinite(relief)) throw new Error('Invalid terrain globe basis channels');
                globeBounds.base.minimum[axis] = Math.min(globeBounds.base.minimum[axis], base); globeBounds.base.maximum[axis] = Math.max(globeBounds.base.maximum[axis], base);
                globeBounds.relief.minimum[axis] = Math.min(globeBounds.relief.minimum[axis], relief); globeBounds.relief.maximum[axis] = Math.max(globeBounds.relief.maximum[axis], relief);
            }
        }
        offsets[0] = Math.min(offsets[0], position[2]); offsets[1] = Math.max(offsets[1], position[2]);
        heights[0] = Math.min(heights[0], current, previous); heights[1] = Math.max(heights[1], current, previous);
    }
    const summary = {directions, offsets, heights, ...(globeBounds ? {globe: globeBounds} : {})}; boundsSummaries.set(mesh, summary); return summary;
}
