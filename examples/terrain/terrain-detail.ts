// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {getTerrainTileBounds} from './tile-selection';

/** Camera projection boundary; source zoom is independent of camera/style zoom. */
export interface TerrainDetailView {
    /** Camera zoom only supplies a fallback for unprojectable horizon footprints. */
    zoom: number;
    /** Geographic center in degrees. */
    longitude: number;
    latitude: number;
    /** Project geographic XYZ to top-origin CSS pixels and clip depth. */
    project(position: number[]): number[];
}

/** Measured local tile-footprint policy, not a certified terrain-error bound. */
export interface TerrainDetailOptions {
    /** Desired maximum projected tile edge, in CSS pixels (default 512). */
    targetTilePixels?: number;
    /** Provider limits, default z0–12. */
    minZoom?: number;
    maxZoom?: number;
    /** Previous data zoom; allows a symmetric deadband around the target. */
    previousZoom?: number;
    /** Relative footprint deadband, default 20%. */
    hysteresis?: number;
    /** Plane used for the projection estimate, physical meters (default 2500). */
    elevation?: number;
}

/** Bounded local projected LOD with hysteresis; does not mutate the logical camera. */
export function selectTerrainDetail(view: TerrainDetailView, options: TerrainDetailOptions = {}): {zoom: number; projectedTilePixels: number | null; limited: boolean} {
    const minZoom = options.minZoom ?? 0, maxZoom = options.maxZoom ?? 12, target = options.targetTilePixels ?? 512;
    const hysteresis = options.hysteresis ?? 0.2, elevation = options.elevation ?? 2500;
    if (![view.zoom, view.longitude, view.latitude, elevation, target, hysteresis].every(Number.isFinite) || target < 64 || target > 2048 || hysteresis < 0 || hysteresis > 0.5 ||
        !Number.isSafeInteger(minZoom) || !Number.isSafeInteger(maxZoom) || minZoom < 0 || maxZoom > 12 || minZoom > maxZoom ||
        options.previousZoom !== undefined && (!Number.isSafeInteger(options.previousZoom) || options.previousZoom < minZoom || options.previousZoom > maxZoom)) throw new Error('Invalid terrain detail policy');
    const longitude = ((view.longitude + 180) % 360 + 360) % 360 - 180;
    const latitude = Math.max(-85.0511287798066, Math.min(85.0511287798066, view.latitude));
    const measure = (zoom: number): number | null => {
        const count = 2 ** zoom;
        const column = Math.min(count - 1, Math.floor((longitude + 180) / 360 * count));
        const row = Math.max(0, Math.min(count - 1, Math.floor((1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2 * count)));
        const bounds = getTerrainTileBounds(zoom, column, row);
        const points = [[bounds[0], bounds[1]], [bounds[2], bounds[1]], [bounds[2], bounds[3]], [bounds[0], bounds[3]]].map(point => view.project([...point, elevation]));
        if (points.some(point => point.length < 3 || !point.every(Number.isFinite) || point[2] < -1 || point[2] > 1)) return null;
        return Math.max(...points.map((point, index) => Math.hypot(point[0] - points[(index + 1) % 4][0], point[1] - points[(index + 1) % 4][1])));
    };
    let zoom = options.previousZoom ?? Math.max(minZoom, Math.min(maxZoom, Math.ceil(view.zoom + Math.log2(512 / target))));
    let pixels = measure(zoom);
    const refineThreshold = target * (options.previousZoom === undefined ? 1 : 1 + hysteresis);
    // Behind-camera/horizon samples retain the bounded camera-zoom fallback.
    // Missing measurements must not force maximum detail and needless downloads.
    while (zoom < maxZoom && pixels !== null && pixels > refineThreshold) {zoom++; pixels = measure(zoom);}
    while (zoom > minZoom) {
        const coarser = measure(zoom - 1);
        if (coarser === null || coarser > target * (1 - hysteresis)) break;
        zoom--; pixels = coarser;
    }
    return {zoom, projectedTilePixels: pixels, limited: pixels === null || zoom === maxZoom && pixels > refineThreshold};
}
