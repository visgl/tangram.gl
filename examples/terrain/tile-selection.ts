// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Canonical, finite XYZ identity; one content record is shared across navigation. */
export interface TerrainTileCoordinate {
    /** Source zoom, independent of camera/style zoom. */
    zoom: number;
    /** West-to-east column in the canonical world. */
    column: number;
    /** North-to-south row. */
    row: number;
}

/** Stable source identity, excluding presentation/backend settings. */
export function getTerrainTileKey(tile: TerrainTileCoordinate): string {return `${tile.zoom}/${tile.column}/${tile.row}`;}

/** Immediate ancestor, used for non-overlapping fallback groups. */
export function getTerrainParent(tile: TerrainTileCoordinate): TerrainTileCoordinate | null {
    return tile.zoom ? {zoom: tile.zoom - 1, column: Math.floor(tile.column / 2), row: Math.floor(tile.row / 2)} : null;
}

/** Geographic bounds for a canonical XYZ address, independent of parsers and rendering. */
export function getTerrainTileBounds(zoom: number, column: number, row: number): [number, number, number, number] {
    const count = 2 ** zoom;
    if (!Number.isSafeInteger(zoom) || zoom < 0 || zoom > 22 || !Number.isInteger(column) || !Number.isInteger(row) || column < 0 || row < 0 || column >= count || row >= count) throw new Error('Invalid terrain XYZ tile');
    const latitude = (tileRow: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * tileRow / count))) * 180 / Math.PI;
    return [column / count * 360 - 180, latitude(row + 1), (column + 1) / count * 360 - 180, latitude(row)];
}

/** Bounded screen-footprint selection, without enumerating a horizon-sized rectangle. */
export function selectTerrainTiles(view: {zoom: number; longitude: number; latitude: number; getBounds(options?: {z?: number}): [number, number, number, number]}, maxTiles = 9, sourceZoom?: number): TerrainTileCoordinate[] {
    if (![view.zoom, view.longitude, view.latitude].every(Number.isFinite) || !Number.isSafeInteger(maxTiles) || maxTiles < 1 || maxTiles > 25) throw new Error('Invalid terrain selection');
    // Global Mapterhorn coverage is z0-z12; finer regional archives are not assumed.
    if (sourceZoom !== undefined && (!Number.isSafeInteger(sourceZoom) || sourceZoom < 0 || sourceZoom > 12)) throw new Error('Invalid terrain source zoom');
    const zoom = sourceZoom ?? Math.max(0, Math.min(12, Math.floor(view.zoom)));
    const count = 2 ** zoom;
    const longitude = ((view.longitude + 180) % 360 + 360) % 360 - 180;
    const centerColumn = (longitude + 180) / 360 * count;
    const tileRow = (latitude: number) => (1 - Math.asinh(Math.tan(Math.max(-85.0511287798066, Math.min(85.0511287798066, latitude)) * Math.PI / 180)) / Math.PI) / 2 * count;
    const centerRow = tileRow(view.latitude);
    const bounds = view.getBounds({z: 2500});
    const finiteBounds = bounds.every(Number.isFinite);
    let west = finiteBounds ? (bounds[0] + 180) / 360 * count : centerColumn - 1;
    let east = finiteBounds ? (bounds[2] + 180) / 360 * count : centerColumn + 1;
    if (east < west) east += count;
    const shift = Math.round((centerColumn - (west + east) / 2) / count) * count;
    west += shift; east += shift;
    const north = finiteBounds ? tileRow(bounds[3]) : centerRow - 1;
    const south = finiteBounds ? tileRow(bounds[1]) : centerRow + 1;
    // A fixed-radius candidate window keeps allocation independent of pitch/horizon extent.
    const radius = Math.ceil(Math.sqrt(maxTiles));
    const candidates: {tile: TerrainTileCoordinate; distance: number}[] = [];
    const seen = new Set<string>();
    for (let row = Math.max(0, Math.floor(centerRow) - radius); row <= Math.min(count - 1, Math.floor(centerRow) + radius); row++) {
        for (let column = Math.floor(centerColumn) - radius; column <= Math.floor(centerColumn) + radius; column++) {
            if ((column < west - 1 || column > east + 1 || row < north - 1 || row > south + 1) && (column !== Math.floor(centerColumn) || row !== Math.floor(centerRow))) continue;
            const tile = {zoom, column: ((column % count) + count) % count, row};
            const key = getTerrainTileKey(tile);
            if (seen.has(key)) continue;
            seen.add(key);
            candidates.push({tile, distance: (column + 0.5 - centerColumn) ** 2 + (row + 0.5 - centerRow) ** 2});
        }
    }
    return candidates.sort((first, second) => first.distance - second.distance).slice(0, maxTiles).map(candidate => candidate.tile);
}
