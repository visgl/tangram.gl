// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {countProjectedTileCoordinates, WebMercatorVisibilityAdapter, projectGeographicPosition,
    getTileGeographicBounds} from '@vis.gl/tangram-renderer/core';
import {validateProjectedGeographicBounds, validateProjectedNavigationViewport} from './projected-navigation';
import type {ProjectedBasemapNavigation, ProjectedBasemapType, ProjectedGeographicBounds,
    ProjectedNavigationViewport} from './projected-navigation';

/** Explicit opt-in uniform source detail policy, independent of geographic style zoom. */
export interface ProjectedTileDetailOptions {
    /** Fixed geographic loading region; this policy does not infer visible geographic bounds. */
    visibleBounds: ProjectedGeographicBounds;
    /** Lowest permissible data level in [0, 6]; defaults to 0. */
    minZoom?: number;
    /** Highest permissible data level in [0, 6]; defaults to 6. */
    maxZoom?: number;
    /** Desired maximum sampled tile span in CSS pixels; defaults to 256. */
    targetTilePixels?: number;
    /** Positive per-source candidate limit; defaults to 256. */
    maxTiles?: number;
    /** Previous level, used only if it remains in range and within budget. */
    currentTileZoom?: number;
    /** Fractional hysteresis around adjacent-level thresholds in [0, 0.5); defaults to 0.15. */
    hysteresis?: number;
}

/** Diagnostic result; exhausting resource/detail bounds is explicit rather than hidden. */
export interface ProjectedTileDetail {
    /** Selected source detail, suitable for projectedTileZoom. */
    tileZoom: number;
    /** Actual single-world logical candidates per source at that detail. */
    candidateCount: number;
    /** Maximum screen span of the sampled, domain-clipped tile footprints. */
    estimatedTilePixels: number;
    /** Whether a finer level was unavailable because it exceeds maxTiles. */
    budgetLimited: boolean;
    /** Whether the maximum configured detail still cannot reach the target pixel span. */
    detailLimited: boolean;
}

/** Choose uniform XYZ detail from projected tile samples, camera scale, hysteresis and candidate limits. */
export async function selectProjectedTileDetail(navigation: ProjectedBasemapNavigation, viewport: ProjectedNavigationViewport,
    type: ProjectedBasemapType, options: ProjectedTileDetailOptions): Promise<ProjectedTileDetail> {
    validateProjectedNavigationViewport(viewport);
    const {visibleBounds, minZoom = 0, maxZoom = 6, targetTilePixels = 256, maxTiles = 256, currentTileZoom,
        hysteresis = 0.15} = options;
    validateProjectedGeographicBounds(visibleBounds, type);
    if (![minZoom, maxZoom].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 6) || minZoom > maxZoom ||
        !Number.isFinite(targetTilePixels) || targetTilePixels <= 0 || !Number.isSafeInteger(maxTiles) || maxTiles < 1 ||
        !Number.isFinite(hysteresis) || hysteresis < 0 || hysteresis >= 0.5 ||
        (currentTileZoom !== undefined && (!Number.isSafeInteger(currentTileZoom) || currentTileZoom < 0 || currentTileZoom > 6))) {
        throw new Error('Projected tile detail requires ordered levels 0–6, positive pixel/candidate limits and finite hysteresis');
    }
    const candidates: {zoom: number; count: number}[] = [];
    for (let zoom = minZoom; zoom <= maxZoom; zoom++) {
        const count = countProjectedTileCoordinates(visibleBounds, zoom);
        if (count > maxTiles) break;
        candidates.push({zoom, count});
    }
    if (!candidates.length) throw new Error('Projected minimum tile detail exceeds the candidate budget');
    const southwest = projectGeographicPosition([visibleBounds[0], visibleBounds[1], 0], 'web-mercator');
    const northeast = projectGeographicPosition([visibleBounds[2], visibleBounds[3], 0], 'web-mercator');
    const traversal = new WebMercatorVisibilityAdapter();
    const measurements = new Map<number, number>();
    const measure = async (zoom: number) => {
        const cached = measurements.get(zoom);
        if (cached !== undefined) return cached;
        const tiles = traversal.findVisibleTileCoordinates({center: {lng: 0, lat: 0}, zoom, tile_zoom: zoom,
            size: {css: {width: viewport.width, height: viewport.height}}, buffer: 0, wrap: false,
            bounds: {sw: {x: southwest[0], y: southwest[1]}, ne: {x: northeast[0], y: northeast[1]}}});
        const coordinates: number[] = [];
        for (const tile of tiles) {
            const bounds = getTileGeographicBounds(tile);
            const west = Math.max(visibleBounds[0], bounds.west), south = Math.max(visibleBounds[1], bounds.south);
            const east = Math.min(visibleBounds[2], bounds.east), north = Math.min(visibleBounds[3], bounds.north);
            // Nine samples per clipped candidate; interior samples capture bowed regional projections.
            for (let column = 0; column <= 2; column++) for (let row = 0; row <= 2; row++) {
                coordinates.push(west + (east - west) * column / 2, south + (north - south) * row / 2);
            }
        }
        const positions = await navigation.projectPositions(new Float64Array(coordinates), type);
        let maximum = 0;
        for (let offset = 0; offset < positions.length; offset += 18) {
            let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
            for (let index = offset; index < offset + 18; index += 2) {
                const screen = viewport.project([positions[index], positions[index + 1], 0]);
                if (![screen[0], screen[1]].every(Number.isFinite)) throw new Error('Projected tile detail produced nonfinite screen positions');
                west = Math.min(west, screen[0]); east = Math.max(east, screen[0]);
                south = Math.min(south, screen[1]); north = Math.max(north, screen[1]);
            }
            maximum = Math.max(maximum, east - west, north - south);
        }
        measurements.set(zoom, maximum);
        return maximum;
    };
    let selected = candidates[candidates.length - 1];
    const current = candidates.find(candidate => candidate.zoom === currentTileZoom);
    if (current) {
        const pixels = await measure(current.zoom);
        const coarser = candidates.find(candidate => candidate.zoom === current.zoom - 1);
        if (pixels <= targetTilePixels * (1 + hysteresis) &&
            (!coarser || await measure(coarser.zoom) > targetTilePixels * (1 - hysteresis))) selected = current;
        else {
            for (const candidate of candidates) if (await measure(candidate.zoom) <= targetTilePixels) {selected = candidate; break;}
        }
    } else {
        for (const candidate of candidates) if (await measure(candidate.zoom) <= targetTilePixels) {selected = candidate; break;}
    }
    const estimatedTilePixels = await measure(selected.zoom);
    const unmet = estimatedTilePixels > targetTilePixels * (1 + hysteresis);
    return {tileZoom: selected.zoom, candidateCount: selected.count, estimatedTilePixels,
        budgetLimited: unmet && candidates[candidates.length - 1].zoom < maxZoom,
        detailLimited: unmet && selected.zoom === maxZoom};
}
