// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import Geo, {type Bounds, type Meters, type Tile} from '../utils/geo';
import {TileID, type TileCoordinate} from '../tile/tile_id';
import type {HostCamera} from '../types';
import {Matrix4} from '@math.gl/core';

/** State consumed by a renderer-owned visibility and LOD adapter. */
export interface VisibilityViewState {
    /** Optional host matrices for policies selecting a precise per-eye footprint. */
    readonly camera?: HostCamera;
    readonly center: {readonly lng: number; readonly lat: number};
    /** Scene/style zoom used to calculate meter scale, independent of data detail. */
    readonly zoom: number;
    /** Requested data-tile level, before source normalization. */
    readonly tile_zoom: number;
    readonly size: {readonly css: {readonly width: number; readonly height: number}};
    readonly bounds: Bounds | null;
    readonly buffer: number;
    readonly wrap: boolean;
}

/** Bounds and LOD state calculated for a Tangram view. */
export interface CalculatedViewBounds {
    /** Data-tile zoom selected for the current view. */
    tileZoom: number;
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

/** Geographic state required to select tiles for a globe viewport. */
export interface GlobeVisibilityViewState {
    /** Tile zoom selected for the current host view. */
    readonly tile_zoom: number;
    /** Number of neighboring tiles included around the geographic bounds. */
    readonly buffer: number;
    /** Host-visible geographic bounds in west, south, east, north order. */
    readonly visibleBounds: readonly [number, number, number, number];
    /** Camera position in the globe's common-space coordinates, when available. */
    readonly cameraPosition?: readonly [number, number, number];
    /** Maximum rendered elevation in geographic meters; omitted means unknown, not zero. */
    readonly maxElevation?: number;
}

/** Projection-specific tile visibility policy for globe views. */
export interface GlobeVisibilityLODAdapter {
    /** Returns visible tiles for the geographic bounds of a globe viewport. */
    findVisibleTileCoordinates(view: GlobeVisibilityViewState): TileCoordinate[];
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
        const tileZoom = view.tile_zoom;
        const metersPerPixel = Geo.metersPerPixel(view.zoom);
        const sizeMeters = {
            x: view.size.css.width * metersPerPixel,
            y: view.size.css.height * metersPerPixel
        };
        const centerCoordinate = Geo.latLngToMeters([view.center.lng, view.center.lat]);
        const centerMeters = {x: centerCoordinate[0], y: centerCoordinate[1]};
        const centerTile = Geo.tileForMeters([centerMeters.x, centerMeters.y], tileZoom);
        const bounds = (view.camera && getGroundBounds(view.camera)) || {
            sw: {
                x: centerMeters.x - sizeMeters.x / 2,
                y: centerMeters.y - sizeMeters.y / 2
            },
            ne: {
                x: centerMeters.x + sizeMeters.x / 2,
                y: centerMeters.y + sizeMeters.y / 2
            }
        };

        return {tileZoom, metersPerPixel, sizeMeters, centerMeters, centerTile, bounds};
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

/** Intersects a planar host frustum with EPSG:3857 ground, retaining the legacy fallback near the horizon. */
function getGroundBounds(camera: HostCamera): Bounds | null {
    const matrix = new Matrix4(camera.projection).multiplyRight(camera.view);
    const determinant = matrix.determinant();
    if (!Number.isFinite(determinant) || determinant === 0) {
        return null;
    }
    matrix.invert();
    const points: number[][] = [];
    for (const [horizontal, vertical] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const near = matrix.transformAsPoint([horizontal, vertical, -1]);
        const far = matrix.transformAsPoint([horizontal, vertical, 1]);
        const parameter = -near[2] / (far[2] - near[2]);
        if (!Number.isFinite(parameter) || parameter < 0 || parameter > 1) {
            return null;
        }
        const point = [near[0] + (far[0] - near[0]) * parameter, near[1] + (far[1] - near[1]) * parameter];
        if (!point.every(Number.isFinite)) {
            return null;
        }
        points.push(point);
    }
    return {
        sw: {x: Math.min(...points.map(point => point[0])), y: Math.min(...points.map(point => point[1]))},
        ne: {x: Math.max(...points.map(point => point[0])), y: Math.max(...points.map(point => point[1]))}
    };
}

/**
 * Selects Web Mercator tiles intersecting geographic bounds on a globe.
 * Antimeridian-crossing bounds are split into two ranges and duplicate tiles
 * are removed while preserving traversal order. Horizon rejection requires both
 * a host camera and an explicit conservative elevation bound. Geographic bounds
 * must already enclose elevated content; this policy does not infer a frustum footprint.
 */
export class WebMercatorGlobeVisibilityAdapter implements GlobeVisibilityLODAdapter {
    /**
     * Returns buffered tiles intersecting host bounds and the visible globe hemisphere.
     * @param view Tile zoom, buffer, geographic bounds, and optional camera position.
     * @returns Visible tile coordinates.
     */
    findVisibleTileCoordinates(view: GlobeVisibilityViewState): TileCoordinate[] {
        if (view.maxElevation !== undefined &&
            (!Number.isFinite(view.maxElevation) || view.maxElevation < 0)) {
            throw new Error('Globe visibility maxElevation must be a finite non-negative number');
        }
        const [west, south, east, north] = view.visibleBounds;
        const zoom = view.tile_zoom;
        const tileCount = Math.pow(2, zoom);
        const northY = latitudeToTileY(north, zoom);
        const southY = latitudeToTileY(south, zoom);
        const yStart = Math.max(0, Math.min(northY, southY) - view.buffer);
        const yEnd = Math.min(tileCount - 1, Math.max(northY, southY) + view.buffer);
        const longitudeRanges = splitLongitudeRange(west, east);
        const coordinates: TileCoordinate[] = [];
        const seen = new Set<string>();

        for (const [rangeWest, rangeEast] of longitudeRanges) {
            const xStart = longitudeToTileX(rangeWest, zoom) - view.buffer;
            const xEnd = longitudeToTileX(rangeEast, zoom) + view.buffer;
            for (let x = xStart; x <= xEnd; x++) {
                const wrappedX = ((x % tileCount) + tileCount) % tileCount;
                for (let y = yStart; y <= yEnd; y++) {
                    const key = `${wrappedX}/${y}/${zoom}`;
                    if (!seen.has(key) && isTileVisibleFromCamera(wrappedX, y, zoom, view.cameraPosition, view.maxElevation)) {
                        seen.add(key);
                        coordinates.push(TileID.coord({x: wrappedX, y, z: zoom}));
                    }
                }
            }
        }
        return coordinates;
    }
}

const GLOBE_RADIUS = 256;
// Must match the geographic altitude scale used by deck.gl and Tangram's globe shaders.
const GLOBE_EARTH_RADIUS = 6370972;

function isTileVisibleFromCamera(
    x: number,
    y: number,
    zoom: number,
    cameraPosition?: readonly [number, number, number],
    maxElevation?: number
): boolean {
    if (maxElevation === undefined || !cameraPosition || cameraPosition.length !== 3 ||
        cameraPosition.some(value => !Number.isFinite(value))) {
        return true;
    }

    const cameraDistance = Math.hypot(...cameraPosition);
    if (cameraDistance <= GLOBE_RADIUS) {
        return true;
    }

    const tileCount = Math.pow(2, zoom);
    const west = x / tileCount * 360 - 180;
    const east = (x + 1) / tileCount * 360 - 180;
    const north = tileYToLatitude(y, zoom);
    const south = tileYToLatitude(y + 1, zoom);
    const center = geographicUnitVector((west + east) / 2, (north + south) / 2);
    const cameraDirection = cameraPosition.map(value => value / cameraDistance);
    const centerDotCamera = center[0] * cameraDirection[0] +
        center[1] * cameraDirection[1] + center[2] * cameraDirection[2];
    // A meridian-then-parallel path bounds every point in the tile, including
    // curved edges and very coarse tiles whose antipode is not a corner.
    const tileAngularRadius = Math.min(Math.PI,
        ((north - south) / 2 + (east - west) / 2) * Math.PI / 180
    );
    const horizonAngle = Math.acos(GLOBE_RADIUS / cameraDistance);
    // A tangent line to the reference sphere can see elevated points beyond the
    // ground horizon by acos(R / (R + height)). The bound is radial, not eye altitude.
    const elevationAngle = Math.acos(1 / (1 + maxElevation / GLOBE_EARTH_RADIUS));
    return centerDotCamera + 1e-12 >=
        Math.cos(Math.min(Math.PI, horizonAngle + elevationAngle + tileAngularRadius));
}

function geographicUnitVector(longitude: number, latitude: number): [number, number, number] {
    const longitudeRadians = longitude * Math.PI / 180;
    const latitudeRadians = latitude * Math.PI / 180;
    const latitudeCosine = Math.cos(latitudeRadians);
    return [
        Math.sin(longitudeRadians) * latitudeCosine,
        -Math.cos(longitudeRadians) * latitudeCosine,
        Math.sin(latitudeRadians)
    ];
}

function tileYToLatitude(y: number, zoom: number): number {
    const tileCount = Math.pow(2, zoom);
    const mercatorY = Math.PI * (1 - 2 * y / tileCount);
    return Math.atan(Math.sinh(mercatorY)) * 180 / Math.PI;
}

function splitLongitudeRange(west: number, east: number): [number, number][] {
    if (east - west >= 360) {
        return [[-180, 180 - Number.EPSILON]];
    }
    const normalizedWest = normalizeLongitude(west);
    const normalizedEast = normalizeLongitude(east);
    return normalizedWest <= normalizedEast
        ? [[normalizedWest, normalizedEast]]
        : [[normalizedWest, 180 - Number.EPSILON], [-180, normalizedEast]];
}

function normalizeLongitude(longitude: number): number {
    return ((longitude + 180) % 360 + 360) % 360 - 180;
}

function longitudeToTileX(longitude: number, zoom: number): number {
    const tileCount = Math.pow(2, zoom);
    return Math.min(tileCount - 1, Math.max(0,
        Math.floor(((longitude + 180) / 360) * tileCount)));
}

function latitudeToTileY(latitude: number, zoom: number): number {
    const tileCount = Math.pow(2, zoom);
    const clampedLatitude = Math.max(-85.05112878, Math.min(85.05112878, latitude));
    const radians = clampedLatitude * Math.PI / 180;
    const y = (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2;
    return Math.min(tileCount - 1, Math.max(0, Math.floor(y * tileCount)));
}
