// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {PROJECTED_COMMON_SCALE} from '../procedures/projected-coordinate-transform';

/** Transform an ENU normal with the inverse transpose of a sampled map Jacobian.
 * Columns are common XY per physical east/north meter; vertical meters retain
 * the projection's fixed common scale. Reject singular kernels rather than emit
 * NaNs or invent a surface orientation. This is not a terrain normal map.
 */
export function projectSurfaceNormal(normal: readonly [number, number, number],
    east: readonly [number, number], north: readonly [number, number]): [number, number, number] {
    const determinant = east[0] * north[1] - north[0] * east[1];
    const magnitude = Math.hypot(...east) * Math.hypot(...north);
    if (![...normal, ...east, ...north].every(Number.isFinite) || magnitude === 0 ||
        Math.abs(determinant) <= magnitude * 1e-12) throw new Error('Projected surface normal requires a nonsingular finite Jacobian');
    const transformed: [number, number, number] = [
        (north[1] * normal[0] - east[1] * normal[1]) / determinant,
        (east[0] * normal[1] - north[0] * normal[0]) / determinant,
        normal[2] / PROJECTED_COMMON_SCALE
    ];
    const length = Math.hypot(...transformed);
    if (!Number.isFinite(length) || length === 0) throw new Error('Projected surface normal must be nonzero and finite');
    return [transformed[0] / length, transformed[1] / length, transformed[2] / length];
}
