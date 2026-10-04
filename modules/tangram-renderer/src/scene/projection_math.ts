// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {HostProjection} from '../types';

/** Neutral units shared by CPU geometry, lighting, shader generation and host adapters. */
export const PROJECTION_CONSTANTS = Object.freeze({
    /** EPSG:3857 spherical radius in meters; not the geographic altitude radius. */
    mercatorRadius: 6378137,
    /** Geographic altitude scale matching deck.gl's public GlobeViewport. */
    earthRadius: 6370972,
    /** Globe common-space radius; north is +Z and longitude zero is -Y. */
    globeRadius: 256,
    /** Tangram's reference tile size, distinct from deck's 512-unit world. */
    tileSize: 256,
    /** Mercator's finite square-world latitude cutoff in degrees. */
    maxMercatorLatitude: 85.0511287798066
});

/** Longitude/latitude in degrees and geographic altitude in meters. */
export type GeographicProjectionPosition = readonly [number, number, number];

/** Project geography to absolute Mercator meters or globe common coordinates, never eye space. */
export function projectGeographicPosition(position: GeographicProjectionPosition, projection: HostProjection['type'], anchorLongitude?: number): [number, number, number] {
    let [longitude, latitude, altitude] = position;
    if (!position.every(Number.isFinite) || Math.abs(latitude) > 90) throw new Error('Projection requires finite geographic coordinates and latitude within +/-90 degrees');
    if (projection === 'globe') {
        longitude *= Math.PI / 180; latitude *= Math.PI / 180;
        const radius = PROJECTION_CONSTANTS.globeRadius * (1 + altitude / PROJECTION_CONSTANTS.earthRadius);
        return [Math.sin(longitude) * Math.cos(latitude) * radius,
            -Math.cos(longitude) * Math.cos(latitude) * radius, Math.sin(latitude) * radius];
    }
    if (anchorLongitude != null && Number.isFinite(anchorLongitude)) longitude += Math.round((anchorLongitude - longitude) / 360) * 360;
    latitude = Math.max(-PROJECTION_CONSTANTS.maxMercatorLatitude, Math.min(PROJECTION_CONSTANTS.maxMercatorLatitude, latitude));
    return [PROJECTION_CONSTANTS.mercatorRadius * longitude * Math.PI / 180,
        PROJECTION_CONSTANTS.mercatorRadius * Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360)), altitude];
}

/** Rotate an ENU direction into globe axes without camera transforms or changing its length. */
export function projectGeographicVector(position: GeographicProjectionPosition, direction: readonly [number, number, number], projection: HostProjection['type']): [number, number, number] {
    const [east, north, up] = direction;
    if (projection === 'web-mercator') return [east, north, up];
    const longitude = position[0] * Math.PI / 180, latitude = position[1] * Math.PI / 180;
    return [east * Math.cos(longitude) - north * Math.sin(longitude) * Math.sin(latitude) + up * Math.sin(longitude) * Math.cos(latitude),
        east * Math.sin(longitude) + north * Math.cos(longitude) * Math.sin(latitude) - up * Math.cos(longitude) * Math.cos(latitude),
        north * Math.cos(latitude) + up * Math.sin(latitude)];
}

/** Invert globe common coordinates for spatial picking, rejecting the undefined sphere center. */
export function unprojectGlobePosition(position: readonly [number, number, number]): [number, number, number] {
    const radius = Math.hypot(...position);
    if (!position.every(Number.isFinite) || radius === 0) throw new Error('Globe position must be finite and non-zero');
    return [Math.atan2(position[0], -position[1]) * 180 / Math.PI,
        Math.asin(Math.max(-1, Math.min(1, position[2] / radius))) * 180 / Math.PI,
        (radius / PROJECTION_CONSTANTS.globeRadius - 1) * PROJECTION_CONSTANTS.earthRadius];
}

/** Style pixels in the zoom-zero Mercator convention, not perspective screen-pixel error. */
export function getMercatorMetersPerPixel(zoom: number): number {
    return 2 * Math.PI * PROJECTION_CONSTANTS.mercatorRadius / PROJECTION_CONSTANTS.tileSize / Math.pow(2, zoom);
}

/** Surface differential per EPSG:3857 meter for projected LOD; elevation is intentionally zero. */
export function getProjectionSurface(x: number, y: number, projection: HostProjection['type']): {
    /** Common-space ground position. */
    position: number[];
    /** Change in position per eastward Mercator meter. */
    derivativeX: number[];
    /** Change in position per northward Mercator meter. */
    derivativeY: number[];
} {
    if (projection === 'web-mercator') return {position: [x, y, 0], derivativeX: [1, 0, 0], derivativeY: [0, 1, 0]};
    const longitude = x / PROJECTION_CONSTANTS.mercatorRadius;
    const latitude = Math.atan(Math.sinh(y / PROJECTION_CONSTANTS.mercatorRadius));
    const cosine = Math.cos(latitude), sine = Math.sin(latitude);
    const sineLongitude = Math.sin(longitude), cosineLongitude = Math.cos(longitude);
    const radius = PROJECTION_CONSTANTS.globeRadius, derivativeScale = radius / PROJECTION_CONSTANTS.mercatorRadius;
    return {position: [radius * sineLongitude * cosine, -radius * cosineLongitude * cosine, radius * sine],
        derivativeX: [derivativeScale * cosineLongitude * cosine, derivativeScale * sineLongitude * cosine, 0],
        derivativeY: [-derivativeScale * sineLongitude * sine * cosine,
            derivativeScale * cosineLongitude * sine * cosine, derivativeScale * cosine ** 2]};
}
