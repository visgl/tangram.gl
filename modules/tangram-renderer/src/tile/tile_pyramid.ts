// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import {TileID, type TileReference} from './tile_id';

/** Resident proxy metadata; traversal references never acquire a live tile's methods. */
type PyramidTile = TileReference & {key: string; loaded: boolean};
/** Resident owner and count of retained descendants. */
type PyramidEntry<Tile extends PyramidTile> = {tile?: Tile; descendants: number};

export default class TilePyramid<Tile extends PyramidTile = PyramidTile> {
    tiles: Record<string, PyramidEntry<Tile>>;
    max_proxy_descendant_depth: number;
    max_proxy_ancestor_depth: number;
    children_cache: Record<string, Record<string, TileReference[]>>;

    constructor() {
        this.tiles = {};
        this.max_proxy_descendant_depth = 6; // # of levels to search up/down for proxy tiles
        this.max_proxy_ancestor_depth = 7;
        this.children_cache = {}; // cache for children of coordinates
    }

    addTile(tile: Tile): void {
        // Add target tile
        this.tiles[tile.key] = this.tiles[tile.key] || { descendants: 0 };
        this.tiles[tile.key].tile = tile;

        // Add to parents
        let reference: TileReference = tile;
        while (reference.style_z >= 0) {
            const parent = TileID.parent(reference);
            if (!parent?.key) {
                return;
            }

            reference = parent;
            if (!this.tiles[parent.key]) {
                this.tiles[parent.key] = { descendants: 0 };
            }
            this.tiles[parent.key].descendants++;
        }
    }

    removeTile(tile: Tile): void {
        // Remove target tile
        if (this.tiles[tile.key]) {
            delete this.tiles[tile.key].tile;

            if (this.tiles[tile.key].descendants === 0) {
                delete this.tiles[tile.key]; // remove whole tile in tree
            }
        }

        // Decrement reference count up the tile pyramid
        let reference: TileReference = tile;
        while (reference.style_z >= 0) {
            const parent = TileID.parent(reference);
            if (!parent?.key) {
                return;
            }

            reference = parent;
            if (this.tiles[parent.key] && this.tiles[parent.key].descendants > 0) {
                this.tiles[parent.key].descendants--;
                if (this.tiles[parent.key].descendants === 0 && !this.tiles[parent.key].tile) {
                    delete this.tiles[parent.key]; // remove whole tile in tree
                }
            }
        }
    }

    // Find the parent tile for a given tile and style zoom level
    getAncestor (tile: TileReference): Tile | undefined {
        let level = 0;
        while (level < this.max_proxy_ancestor_depth) {
            const parent = TileID.parent(tile);
            if (!parent?.key) {
                return;
            }

            tile = parent;
            const owner = this.tiles[parent.key]?.tile;
            if (owner?.loaded) {
                return owner;
            }

            level++;
        }
    }

    // Find the descendant tiles for a given tile and style zoom level
    getDescendants (tile: TileReference, level = 0): Tile[] {
        const descendants: Tile[] = [];
        if (level < this.max_proxy_descendant_depth) {
            const tiles = TileID.children(tile, this.children_cache);
            if (!tiles) {
                return descendants;
            }

            tiles.forEach(t => {
                if (t.key && this.tiles[t.key]) {
                    const owner = this.tiles[t.key].tile;
                    if (owner?.loaded) {
                        descendants.push(owner);
                    }
                    else if (this.tiles[t.key].descendants > 0) { // didn't find any children, try next level
                        descendants.push(...(this.getDescendants(t, level + 1) || []));
                    }
                }
            });
        }

        return descendants;
    }

}
