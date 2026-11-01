// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Detached terrain worker diagnostics, including host and worker timings. */
export interface TerrainDecoderStatistics {
    /** Total worker constructions, including replacements after failures. */
    created: number;
    /** Current running requests. */
    active: number;
    /** Current warm idle workers. */
    idle: number;
    /** Completed requests. */
    completed: number;
    /** Failed requests, excluding cancellation. */
    failed: number;
    /** Requests cancelled by their signal or pool teardown. */
    cancelled: number;
    /** Last request's host elapsed time including startup and scheduling. */
    lastRoundTripMs?: number;
    /** Last request's worker decode elapsed time, if reported. */
    lastDecodeMs?: number;
}
