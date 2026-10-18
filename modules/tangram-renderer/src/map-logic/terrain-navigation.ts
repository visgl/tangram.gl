// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {TerrainHeightField} from './terrain-height-field';

/** Conservative swept square-footprint guard; it is not a rigid-body physics solver. */
export interface TerrainMotionResult {
    /** True only when every admitted path rectangle has valid source coverage. */
    readonly available: boolean;
    /** No translation should be published when true; orientation can still change. */
    readonly blocked: boolean;
    /** Explicit distinction between an obstacle, no-data and a bounded-work refusal. */
    readonly reason: 'clear' | 'terrain' | 'missing' | 'budget';
    /** Exact rectangle queries performed, useful for deterministic work-budget tests. */
    readonly probes: number;
}

/**
 * Guard all intermediate XY coverage and the entire body footprint, not just
 * endpoint/centerline rays. XY and radius are EPSG:3857 meters; Z/clearance are
 * physical vertical meters. A square conservatively contains a circular avatar.
 */
export function guardTerrainMotion(field: TerrainHeightField, start: readonly [number, number, number], end: readonly [number, number, number], options: {
    /** Half-width of the conservative horizontal footprint in Mercator meters. */
    radius: number;
    /** Required physical eye-to-ground distance. */
    clearance: number;
    /** Maximum horizontal travel per query rectangle, default 2 Mercator meters. */
    maxStep?: number;
    /** Hard rectangle-query cap, default 128. Excessive movement holds translation. */
    maxProbes?: number;
}): TerrainMotionResult {
    const maxStep = options.maxStep ?? 2, maxProbes = options.maxProbes ?? 128;
    if (start.length !== 3 || end.length !== 3 || ![...start, ...end, options.radius, options.clearance, maxStep].every(Number.isFinite) ||
        options.radius < 0 || options.clearance < 0 || maxStep <= 0 || !Number.isSafeInteger(maxProbes) || maxProbes < 1 || maxProbes > 1024) throw new Error('Invalid swept terrain motion');
    const distance = Math.hypot(end[0] - start[0], end[1] - start[1]);
    const steps = Math.max(1, Math.ceil(distance / maxStep));
    if (steps > maxProbes) return {available: false, blocked: true, reason: 'budget', probes: 0};
    let obstacle = false;
    for (let step = 0; step < steps; step++) {
        const first = start.map((value, axis) => value + (end[axis] - value) * step / steps);
        const second = start.map((value, axis) => value + (end[axis] - value) * (step + 1) / steps);
        const range = field.getHeightRange([Math.min(first[0], second[0]) - options.radius, Math.min(first[1], second[1]) - options.radius,
            Math.max(first[0], second[0]) + options.radius, Math.max(first[1], second[1]) + options.radius]);
        if (!range) return {available: false, blocked: true, reason: 'missing', probes: step + 1};
        obstacle ||= Math.min(first[2], second[2]) - options.clearance < range.maximum;
    }
    return {available: true, blocked: obstacle, reason: obstacle ? 'terrain' : 'clear', probes: steps};
}
