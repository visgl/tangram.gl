// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {TileID, type TileCoordinate, type TileCoordinates, type TileSource} from './tile_id';
import Geo from '../utils/geo';

/** Enumerate one bounded global level, independent of camera or hemisphere. */
export function createGlobePreloadCoordinates(zoom: number): TileCoordinate[] {
    if (!Number.isInteger(zoom) || zoom < 0 || zoom > 3) {
        throw new Error('Globe preload zoom must be an integer from 0 to 3');
    }
    const coordinates: TileCoordinate[] = [];
    for (let x = 0; x < 2 ** zoom; x++) {
        for (let y = 0; y < 2 ** zoom; y++) coordinates.push(TileID.coord({x, y, z: zoom}));
    }
    return coordinates;
}

/** Resolve a coarse ancestor without expanding a source's minimum zoom into global high-detail requests. */
export function getGlobePreloadKey(coordinates: TileCoordinates, source: TileSource, styleZoom: number, zoom: number): string | undefined {
    const normalized = TileID.normalizedCoord(TileID.coordAtZoom(coordinates, zoom), source);
    if (normalized.z > zoom) return undefined;
    return TileID.key(normalized, source, styleZoom);
}

/** Clip a fallback mesh in its local packed tile units to one missing detail tile. */
export function getGlobeFallbackClipBounds(parent: TileCoordinates, child: TileCoordinates): number[] {
    const scale = 2 ** (child.z - parent.z);
    const width = Geo.tile_scale / scale;
    const horizontal = child.x - parent.x * scale;
    const vertical = child.y - parent.y * scale;
    return [horizontal * width, -(vertical + 1) * width, (horizontal + 1) * width, vertical === 0 ? 0 : -vertical * width];
}

/** Only surface geometry can be drawn as a clipped loading placeholder. */
export function isGlobeFallbackStyle(name: string, base?: string | null): boolean {
    const style = base || name;
    return style === 'polygons' || style === 'lines' || style === 'raster';
}
