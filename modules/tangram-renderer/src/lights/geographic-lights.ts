// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Geographic longitude/latitude in degrees and altitude in meters. */
type GeographicPosition = readonly [number, number, number];

import {projectGeographicPosition, projectGeographicVector} from '../scene/projection_math';

/** Project a lamp into Tangram's geometry space, choosing the nearest planar world copy. */
export function projectGeographicLight(position: GeographicPosition, globe: boolean, anchorLongitude?: number): [number, number, number] {
    if (!position.every(Number.isFinite) || Math.abs(position[1]) > 90) {
        throw new Error('Geographic lights require finite longitude/latitude/altitude and latitude within +/-90 degrees');
    }
    return projectGeographicPosition(position, globe ? 'globe' : 'web-mercator', anchorLongitude);
}

/** Rotate a geographic spotlight's east/north/up direction into globe common space. */
export function projectGeographicDirection(position: GeographicPosition, direction: readonly [number, number, number], globe: boolean): [number, number, number] {
    return projectGeographicVector(position, direction, globe ? 'globe' : 'web-mercator');
}
