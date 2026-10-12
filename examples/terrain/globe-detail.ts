// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {getTerrainTileBounds, getTerrainTileKey, type TerrainTileCoordinate} from './tile-selection';

/** Four canonical children, in stable north-to-south order. */
export function getTerrainChildren(tile: TerrainTileCoordinate): TerrainTileCoordinate[] {
    return [0, 1, 2, 3].map(index => ({zoom: tile.zoom + 1, column: tile.column * 2 + index % 2, row: tile.row * 2 + Math.floor(index / 2)}));
}

/** Whether one canonical tile contains another (including equality). */
export function terrainTileContains(parent: TerrainTileCoordinate, child: TerrainTileCoordinate): boolean {
    const scale = 2 ** (child.zoom - parent.zoom);
    return scale >= 1 && Math.floor(child.column / scale) === parent.column && Math.floor(child.row / scale) === parent.row;
}

/** Edge adjacency across mixed zooms and the antimeridian; corner contact is not an edge. */
export function terrainTilesTouch(first: TerrainTileCoordinate, second: TerrainTileCoordinate): boolean {
    const zoom = Math.max(first.zoom, second.zoom), world = 2 ** zoom;
    const firstScale = 2 ** (zoom - first.zoom), secondScale = 2 ** (zoom - second.zoom);
    const west = first.column * firstScale, east = west + firstScale, north = first.row * firstScale, south = north + firstScale;
    const top = second.row * secondScale, bottom = top + secondScale;
    return [-world, 0, world].some(shift => {
        const left = second.column * secondScale + shift, right = left + secondScale;
        return (east === left || west === right) && Math.max(north, top) < Math.min(south, bottom) ||
            (south === top || north === bottom) && Math.max(west, left) < Math.min(east, right);
    });
}

/** Minimal projection contract; no Deck instance, device or source ownership. */
export interface GlobeTerrainDetailView {
    /** Geographic camera target and logical zoom. */
    longitude: number;
    latitude: number;
    zoom: number;
    /** Top-origin CSS viewport rectangle. */
    x: number;
    y: number;
    width: number;
    height: number;
    /** Radius-256 globe common-space camera position. */
    cameraPosition: readonly number[];
    /** Project geographic degrees/physical-meter altitude to CSS pixels and clip depth. */
    project(position: number[]): number[];
}

/** A complete balanced leaf cover; resource limits may keep some visible terrain coarse. */
export interface GlobeTerrainDetail {
    /** Complete non-overlapping world cover, rooted at z2. */
    tiles: TerrainTileCoordinate[];
    /** True when the leaf/source cap prevents reaching the sampled footprint target. */
    limited: boolean;
}

/** Refine visible footprints while retaining global fallback and a bounded 2:1 hierarchy. */
export function selectGlobeTerrainDetail(view: GlobeTerrainDetailView, options: {
    /** Maximum projected sample spacing per half-tile, CSS pixels; default 256. */
    targetPixels?: number;
    /** Leaf cap, integer 16–128; default 96. */
    maxTiles?: number;
    /** Source upper zoom, integer 2–12; default 12. */
    maxZoom?: number;
    /** Previous cover supplies a 20% coarsen/refine deadband. */
    previous?: readonly TerrainTileCoordinate[];
} = {}): GlobeTerrainDetail {
    const target = options.targetPixels ?? 256, limit = options.maxTiles ?? 96, maximum = options.maxZoom ?? 12;
    if (![view.longitude, view.latitude, view.zoom, view.x, view.y, view.width, view.height, ...view.cameraPosition, target].every(Number.isFinite) || view.width <= 0 || view.height <= 0 || view.cameraPosition.length !== 3 ||
        target < 64 || target > 1024 || !Number.isSafeInteger(limit) || limit < 16 || limit > 128 || !Number.isSafeInteger(maximum) || maximum < 2 || maximum > 12) throw new Error('Invalid globe terrain detail policy');
    const cameraDistance = Math.hypot(...view.cameraPosition);
    if (cameraDistance <= 256) throw new Error('Globe terrain detail camera must be outside the globe');
    const longitude = ((view.longitude + 180) % 360 + 360) % 360 - 180;
    const targetColumn = (longitude + 180) / 360;
    const targetRow = (1 - Math.asinh(Math.tan(Math.max(-85.0511287798066, Math.min(85.0511287798066, view.latitude)) * Math.PI / 180)) / Math.PI) / 2;
    const measures = new Map<string, number>();
    /** Sample curved edges and center, not just a coarse chord across a hemisphere. */
    function measure(tile: TerrainTileCoordinate): number {
        const key = getTerrainTileKey(tile), cached = measures.get(key);
        if (cached !== undefined) return cached;
        const bounds = getTerrainTileBounds(tile.zoom, tile.column, tile.row), count = 2 ** tile.zoom;
        const containsTarget = Math.floor(targetColumn * count) === tile.column && Math.min(count - 1, Math.floor(targetRow * count)) === tile.row;
        const points: (number[] | null)[] = [];
        let visible = containsTarget;
        for (let row = 0; row < 3; row++) for (let column = 0; column < 3; column++) {
            const latitude = bounds[1] + (bounds[3] - bounds[1]) * row / 2, longitude = bounds[0] + (bounds[2] - bounds[0]) * column / 2;
            const radiansLongitude = longitude * Math.PI / 180, radiansLatitude = latitude * Math.PI / 180;
            const facing = Math.sin(radiansLongitude) * Math.cos(radiansLatitude) * view.cameraPosition[0] - Math.cos(radiansLongitude) * Math.cos(radiansLatitude) * view.cameraPosition[1] + Math.sin(radiansLatitude) * view.cameraPosition[2];
            // Use the full facing hemisphere conservatively; terrain can extend past the sea-level horizon.
            const point = facing > 0 ? view.project([longitude, latitude, 0]) : null;
            if (point && point.length >= 3 && point.every(Number.isFinite) && point[2] >= -1 && point[2] <= 1) {
                points.push(point);
                visible ||= point[0] >= view.x - target && point[0] <= view.x + view.width + target && point[1] >= view.y - target && point[1] <= view.y + view.height + target;
            } else points.push(null);
        }
        let pixels = 0;
        if (visible) {
            for (let index = 0; index < 9; index++) for (const neighbor of [index % 3 < 2 ? index + 1 : -1, index < 6 ? index + 3 : -1]) {
                const first = points[index], second = points[neighbor];
                if (first && second) pixels = Math.max(pixels, Math.hypot(first[0] - second[0], first[1] - second[1]));
            }
            if (!pixels && containsTarget) pixels = 256 * 2 ** (view.zoom - tile.zoom);
        }
        measures.set(key, pixels); return pixels;
    }
    let tiles = Array.from({length: 16}, (_, index) => ({zoom: 2, column: index % 4, row: Math.floor(index / 4)}));
    let limited = false;
    for (;;) {
        const candidates = tiles.filter(tile => measure(tile) > target * (options.previous?.some(previous => previous.zoom > tile.zoom && terrainTileContains(tile, previous)) ? 0.8 : 1.2))
            .sort((first, second) => measure(second) - measure(first) || getTerrainTileKey(first).localeCompare(getTerrainTileKey(second)));
        let refined = false;
        for (const candidate of candidates) {
            if (candidate.zoom >= maximum) {limited = true; continue;}
            let proposed = tiles.flatMap(tile => tile === candidate ? getTerrainChildren(tile) : [tile]);
            // Refinement can require neighboring refinements; reject the entire transaction if it exceeds the cap.
            for (;;) {
                const coarse = proposed.find(tile => proposed.some(neighbor => neighbor.zoom > tile.zoom + 1 && terrainTilesTouch(tile, neighbor)));
                if (!coarse || proposed.length > limit) break;
                proposed = proposed.flatMap(tile => tile === coarse ? getTerrainChildren(tile) : [tile]);
            }
            if (proposed.length > limit) {limited = true; continue;}
            tiles = proposed; refined = true; break;
        }
        if (!refined) break;
    }
    return {tiles: tiles.sort((first, second) => first.zoom - second.zoom || first.row - second.row || first.column - second.column), limited};
}
