// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import Geo from '../utils/geo';
import type {HostProjection} from '../types';
import type {TileCoordinate, TileCoordinates} from './tile_id';
import type {GlobeVisibilityLODAdapter, VisibilityLODAdapter, VisibilityViewState} from '../scene/visibility_adapter';

/** Geographic XYZ tile bounds; an unwrapped world copy retains its longitude offset. */
export interface GeographicTileBounds {
    /** Western longitude in degrees. */
    west: number;
    /** Southern latitude in degrees. */
    south: number;
    /** Eastern longitude in degrees. */
    east: number;
    /** Northern latitude in degrees. */
    north: number;
}

/** One host eye's traversal inputs, independent of deck.gl viewport classes. */
export interface TangramTraversalEye {
    /** Geographic view state with style and data zoom kept distinct. */
    readonly view: VisibilityViewState;
    /** Projection and footprint policy. */
    readonly projection: HostProjection;
    /** Optional globe/common-space camera position. */
    readonly position?: ArrayLike<number>;
    /** Host eyes need independent bounds; classic views already have calculated bounds. */
    readonly calculateBounds?: boolean;
    /** Projected LOD overrides per-eye automatic detail, never style zoom. */
    readonly dataZoom?: number;
}

/** Shared logical traversal state; stereo consumers contribute an eye union. */
export interface TangramTraversalState {
    /** Empty until the view is ready. */
    readonly eyes: readonly TangramTraversalEye[];
    /** Host render-view collections deduplicate even a single eye; classic ordering remains unchanged. */
    readonly union?: boolean;
}

/** Structured geographic bounds suitable for both Tangram and loaders.gl adapters. */
export function getTileGeographicBounds(index: TileCoordinates): GeographicTileBounds {
    const northwest = Geo.metersForTile(index);
    const southeast = Geo.metersForTile({x: index.x + 1, y: index.y + 1, z: index.z});
    const [west, north] = Geo.metersToLatLng([northwest.x, northwest.y]);
    const [east, south] = Geo.metersToLatLng([southeast.x, southeast.y]);
    return {west, south, east, north};
}

/**
 * Traversal seam structurally compatible with loaders.gl Tileset2DAdapter.
 * Tangram owns footprint/LOD inputs; source normalization and fallback pinning remain separate.
 */
export default class TangramTileTraversalAdapter {
    /** Existing planar/FirstPerson visibility implementation. */
    private readonly planar: VisibilityLODAdapter;
    /** Existing curved globe/horizon visibility implementation. */
    private readonly globe: GlobeVisibilityLODAdapter;

    /** Bind the unchanged projection-specific selection procedures. */
    constructor(planar: VisibilityLODAdapter, globe: GlobeVisibilityLODAdapter) {
        this.planar = planar;
        this.globe = globe;
    }

    /** Select the same logical data tiles before source sparse-zoom/overzoom normalization. */
    getTileIndices({viewState}: {viewState: TangramTraversalState}): TileCoordinate[] {
        if (viewState.eyes.length === 1 && !viewState.union) return this.selectEye(viewState.eyes[0]);
        const coordinates = new Map<string, TileCoordinate>();
        for (const eye of viewState.eyes) for (const coordinate of this.selectEye(eye)) {
            coordinates.set(coordinate.key ?? `${coordinate.x}/${coordinate.y}/${coordinate.z}`, coordinate);
        }
        return Array.from(coordinates.values());
    }

    /** Geographic tile metadata, with XYZ's north-down Y convention preserved. */
    getTileBoundingBox(_context: {viewState: TangramTraversalState}, index: TileCoordinates): GeographicTileBounds {
        return getTileGeographicBounds(index);
    }

    /** Original per-eye projection dispatch and explicit footprint handling. */
    private selectEye(eye: TangramTraversalEye): TileCoordinate[] {
        let state = eye.view;
        if (eye.calculateBounds) {
            const bounds = this.planar.calculateBounds(state);
            state = {...state, bounds: bounds.bounds, tile_zoom: eye.dataZoom ?? bounds.tileZoom};
        }
        const projection = eye.projection;
        if (projection.type === 'globe') {
            return this.globe.findVisibleTileCoordinates({tile_zoom: state.tile_zoom, buffer: state.buffer,
                visibleBounds: projection.visibleBounds,
                ...(projection.maxElevation === undefined ? {} : {maxElevation: projection.maxElevation}),
                cameraPosition: eye.position ? [eye.position[0], eye.position[1], eye.position[2]] : undefined});
        }
        if (projection.visibleBounds !== undefined) {
            const bounds = projection.visibleBounds;
            if (bounds === null) return [];
            const southwest = Geo.latLngToMeters([bounds[0], bounds[1]]);
            const northeast = Geo.latLngToMeters([bounds[2], bounds[3]]);
            if (!southwest.every(Number.isFinite) || !northeast.every(Number.isFinite)) {
                throw new Error('HostFrame planar visibleBounds must project to finite meters');
            }
            state = {...state, bounds: {sw: {x: southwest[0], y: southwest[1]}, ne: {x: northeast[0], y: northeast[1]}}};
        }
        return this.planar.findVisibleTileCoordinates(state);
    }
}
