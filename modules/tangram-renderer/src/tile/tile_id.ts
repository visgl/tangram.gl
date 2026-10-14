// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

export type TileCoordinates = {
    x: number;
    y: number;
    z: number;
};
export type TileCoordinate = TileCoordinates & {key: string; center_dist?: number};

export type TileSource = {
    id: string | number;
    name: string;
    zoom_bias?: number;
    zooms: number[];
};

export type TileReference = {
    coords: TileCoordinates;
    source: TileSource;
    style_z: number;
    key?: string;
};

type TileChildrenCache = Record<string, Record<string, TileReference[]>>;

type TileIdApi = {
    coord(coordinates: TileCoordinates): TileCoordinate;
    coordKey(coordinates: TileCoordinates): string;
    key(coordinates: TileCoordinates, source: TileSource, styleZoom: number): string | undefined;
    normalizedKey(
        coordinates: TileCoordinates,
        source: TileSource,
        styleZoom: number
    ): string | undefined;
    normalizedCoord(coordinates: TileCoordinates, source: TileSource): TileCoordinate;
    coordAtZoom(coordinates: TileCoordinates, zoom: number): TileCoordinate;
    coordForTileZooms(coordinates: TileCoordinates, zooms: number[]): TileCoordinate;
    findZoomInRange(zoom: number, zooms: number[]): number;
    isDescendant(parent: TileCoordinates, descendant: TileCoordinates): boolean;
    parent(tile: TileReference): TileReference | null | undefined;
    children(tile: TileReference, cache?: TileChildrenCache): TileReference[];
};

export const TileID: TileIdApi = {
    coord(coordinates) {
        return {x: coordinates.x, y: coordinates.y, z: coordinates.z, key: this.coordKey(coordinates)};
    },

    coordKey({x, y, z}) {
        return x + '/' + y + '/' + z;
    },

    key (coordinates, source, styleZoom) {
        if (coordinates.y < 0 || coordinates.y >= (1 << coordinates.z) || coordinates.z < 0) {
            return; // cull tiles out of range (x will wrap)
        }
        return [source.name, coordinates.x, coordinates.y, coordinates.z, styleZoom].join('/');
    },

    normalizedKey (coordinates, source, styleZoom) {
        return this.key(this.normalizedCoord(coordinates, source), source, styleZoom);
    },

    normalizedCoord (coordinates, source) {
        if (source.zoom_bias) {
            coordinates = this.coordAtZoom(
                coordinates,
                Math.max(coordinates.z - source.zoom_bias, source.zooms[0])
            );
        }
        return this.coordForTileZooms(coordinates, source.zooms);
    },

    coordAtZoom({x, y, z}, zoom) {
        zoom = Math.max(0, zoom); // zoom can't go below zero
        if (z !== zoom) {
            const scale = Math.pow(2, z - zoom);
            x = Math.floor(x / scale);
            y = Math.floor(y / scale);
            z = zoom;
        }
        return this.coord({x, y, z});
    },

    coordForTileZooms ({x, y, z}, zooms) {
        const normalizedZoom = this.findZoomInRange(z, zooms);
        if (normalizedZoom !== z) {
            return this.coordAtZoom({x, y, z}, normalizedZoom);
        }
        return this.coord({x, y, z});
    },

    findZoomInRange(zoom, zooms) {
        return zooms.filter(sourceZoom => zoom >= sourceZoom).reverse()[0] || zooms[0];
    },

    isDescendant(parent, descendant) {
        if (descendant.z > parent.z) {
            const {x, y} = this.coordAtZoom(descendant, parent.z);
            return parent.x === x && parent.y === y;
        }
        return false;
    },

    // Return identifying info for tile's parent tile
    parent ({coords, source, style_z: styleZoom}) {
        if (styleZoom > 0) { // no more tiles above style zoom 0
            styleZoom--;
            const sourceZoom = Math.max(styleZoom - (source.zoom_bias || 0), source.zooms[0]);
            const coordinates = this.coordForTileZooms(this.coordAtZoom(coords, sourceZoom), source.zooms);

            if (coordinates.z > styleZoom) {
                return null;
            }

            return {
                key: this.key(coordinates, source, styleZoom),
                coords: coordinates,
                style_z: styleZoom,
                source
            };
        }
    },

    // Return identifying info for tile's child tiles
    children ({coords, source, style_z: styleZoom}, cache = {}) {
        styleZoom++;
        const coordinates = this.coordForTileZooms(
            this.coordAtZoom(coords, styleZoom - (source.zoom_bias || 0)),
            source.zooms
        );
        if (coordinates.z === coords.z) {
            // same coord zoom for next level down
            return [{
                key: this.key(coordinates, source, styleZoom),
                coords: coordinates,
                style_z: styleZoom,
                source
            }];
        }
        else {
            // coord zoom advanced down
            const key = this.key(coordinates, source, styleZoom);
            if (!key) {
                return [];
            }
            cache[source.id] = cache[source.id] || {};
            if (cache[source.id][key] == null) {
                const span = Math.pow(2, coordinates.z - coords.z);
                const startX = coords.x * span;
                const startY = coords.y * span;
                const children: TileReference[] = [];
                for (let x = startX; x < startX + span; x++) {
                    for (let y = startY; y < startY + span; y++) {
                        const childCoordinates = this.coord({x, y, z: coordinates.z});
                        children.push({
                            key: this.key(childCoordinates, source, styleZoom),
                            coords: childCoordinates,
                            style_z: styleZoom,
                            source
                        });
                    }
                }
                cache[source.id][key] = children;
            }
            return cache[source.id][key];
        }
    }
};
