// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Geographic longitude/latitude in degrees and altitude in meters. */
type GeographicPosition = readonly [number, number, number];

const MERCATOR_RADIUS = 6378137;
const EARTH_RADIUS = 6370972;
const GLOBE_RADIUS = 256;

/** Project a lamp into Tangram's geometry space, choosing the nearest planar world copy. */
export function projectGeographicLight(position: GeographicPosition, globe: boolean, anchorLongitude?: number): [number, number, number] {
    let [longitude, latitude, altitude] = position;
    if (!position.every(Number.isFinite) || Math.abs(latitude) > 90) {
        throw new Error('Geographic lights require finite longitude/latitude/altitude and latitude within +/-90 degrees');
    }
    if (globe) {
        longitude *= Math.PI / 180;
        latitude *= Math.PI / 180;
        const radius = GLOBE_RADIUS * (1 + altitude / EARTH_RADIUS);
        return [Math.sin(longitude) * Math.cos(latitude) * radius,
            -Math.cos(longitude) * Math.cos(latitude) * radius, Math.sin(latitude) * radius];
    }
    if (anchorLongitude != null && Number.isFinite(anchorLongitude)) {
        longitude += Math.round((anchorLongitude - longitude) / 360) * 360;
    }
    latitude = Math.max(-85.0511287798066, Math.min(85.0511287798066, latitude));
    return [MERCATOR_RADIUS * longitude * Math.PI / 180,
        MERCATOR_RADIUS * Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360)), altitude];
}

/** Rotate a geographic spotlight's east/north/up direction into globe common space. */
export function projectGeographicDirection(position: GeographicPosition, direction: readonly [number, number, number], globe: boolean): [number, number, number] {
    const [east, north, up] = direction;
    if (!globe) return [east, north, up];
    const longitude = position[0] * Math.PI / 180;
    const latitude = position[1] * Math.PI / 180;
    return [east * Math.cos(longitude) - north * Math.sin(longitude) * Math.sin(latitude) + up * Math.sin(longitude) * Math.cos(latitude),
        east * Math.sin(longitude) + north * Math.cos(longitude) * Math.sin(latitude) - up * Math.cos(longitude) * Math.cos(latitude),
        north * Math.cos(latitude) + up * Math.sin(latitude)];
}
