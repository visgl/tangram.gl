// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Packed signed-short height units per physical meter, shared by builders and optional projection workers. */
export const PACKED_HEIGHT_SCALE = 16;

/** Validate physical annotation meters before signed-short storage can silently wrap. */
export function packProjectedAnnotationHeight(height: unknown, allowElevation = false): number {
    const meters = height ?? 0;
    if (typeof meters !== 'number' || !Number.isFinite(meters)) {
        throw new Error('Projected annotation height must be finite meters');
    }
    if (meters !== 0 && !allowElevation) throw new Error('Projected symbols require ground anchors unless allowElevation is enabled');
    if (meters < -32768 / PACKED_HEIGHT_SCALE || meters > 32767 / PACKED_HEIGHT_SCALE) {
        throw new Error('Projected annotation height exceeds signed-short storage');
    }
    return Math.trunc(meters * PACKED_HEIGHT_SCALE);
}
