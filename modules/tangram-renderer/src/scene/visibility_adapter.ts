// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import Geo, {type Bounds, type Meters, type Tile} from '../utils/geo';
import {TileID, type TileCoordinate} from '../tile/tile_id';

/** State consumed by a renderer-owned visibility and LOD adapter. */
export interface VisibilityViewState {
    readonly center: {readonly lng: number; readonly lat: number};
    readonly zoom: number;
    readonly tile_zoom: number;
    readonly size: {readonly css: {readonly width: number; readonly height: number}};
    readonly bounds: Bounds | null;
    readonly buffer: number;
    readonly wrap: boolean;
}

/** Bounds and LOD state calculated for a Tangram view. */
export interface CalculatedViewBounds {
    metersPerPixel: number;
    sizeMeters: Meters;
    centerMeters: Meters;
    centerTile: Tile;
    bounds: Bounds;
}

/**
 * Renderer-facing visibility and level-of-detail policy.
 *
 * Implementations consume Tangram geographic view state and return Tangram
 * tile coordinates. They do not depend on deck.gl or a specific host camera.
 */
export interface VisibilityLODAdapter {
    /** Calculates the current Web Mercator bounds and derived tile LOD state. */
    calculateBounds(view: VisibilityViewState): CalculatedViewBounds;
    /** Returns visible tiles for the current Web Mercator view. */
    findVisibleTileCoordinates(view: VisibilityViewState): TileCoordinate[];
}

/**
 * Default visibility policy preserving Tangram's rectangular Web Mercator
 * viewport bounds and buffered tile-range behavior.
 */
export class WebMercatorVisibilityAdapter implements VisibilityLODAdapter {
    /**
     * Calculates meter-space viewport bounds and the center tile.
     * @param view Tangram's current geographic view state.
     * @returns Bounds, center, and LOD state used by View.
     */
    calculateBounds(view: VisibilityViewState): CalculatedViewBounds {
        const metersPerPixel = Geo.metersPerPixel(view.zoom);
        const sizeMeters = {
            x: view.size.css.width * metersPerPixel,
            y: view.size.css.height * metersPerPixel
        };
        const centerCoordinate = Geo.latLngToMeters([view.center.lng, view.center.lat]);
        const centerMeters = {x: centerCoordinate[0], y: centerCoordinate[1]};
        const centerTile = Geo.tileForMeters([centerMeters.x, centerMeters.y], view.tile_zoom);
        const bounds = {
            sw: {
                x: centerMeters.x - sizeMeters.x / 2,
                y: centerMeters.y - sizeMeters.y / 2
            },
            ne: {
                x: centerMeters.x + sizeMeters.x / 2,
                y: centerMeters.y + sizeMeters.y / 2
            }
        };

        return {metersPerPixel, sizeMeters, centerMeters, centerTile, bounds};
    }

    /**
     * Selects the buffered tile rectangle intersecting the current view.
     * @param view Tangram's current geographic view state.
     * @returns Visible tile coordinates at the current tile zoom.
     */
    findVisibleTileCoordinates(view: VisibilityViewState): TileCoordinate[] {
        if (!view.bounds) {
            return [];
        }

        const zoom = view.tile_zoom;
        const southwest = Geo.tileForMeters([view.bounds.sw.x, view.bounds.sw.y], zoom);
        const northeast = Geo.tileForMeters([view.bounds.ne.x, view.bounds.ne.y], zoom);
        let range = [
            southwest.x - view.buffer,
            northeast.x + view.buffer,
            northeast.y - view.buffer,
            southwest.y + view.buffer
        ];

        if (!view.wrap) {
            const maxTile = (1 << zoom) - 1;
            range = range.map(value => Math.min(Math.max(0, value), maxTile));
        }

        const coordinates: TileCoordinate[] = [];
        for (let x = range[0]; x <= range[1]; x++) {
            for (let y = range[2]; y <= range[3]; y++) {
                coordinates.push(TileID.coord({x, y, z: zoom}));
            }
        }
        return coordinates;
    }
}
