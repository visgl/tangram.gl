// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {getProjectedCoordinateOptions, PROJECTED_COMMON_SCALE, countProjectedTileCoordinates,
    normalizeProjectedBasemapOptions} from '@vis.gl/tangram-renderer/core';
import type {ProjectionEngine, ProjectionEngineTransform, ProjectedBasemapOptions} from '@vis.gl/tangram-renderer/core';

/** Supported fixed projection, not an arbitrary target CRS. */
export type ProjectedBasemapType = ProjectedBasemapOptions['type'];
/** Ordered single-world west, south, east and north in degrees. */
export type ProjectedGeographicBounds = readonly [number, number, number, number];
/** Geographic longitude and latitude in degrees. */
export type ProjectedGeographicPosition = readonly [number, number];

/** Public deck orthographic methods; screen positions use top-left CSS pixels. */
export interface ProjectedNavigationViewport {
    /** Must be false; geographic deck cameras have a different common-space contract. */
    isGeospatial: boolean;
    /** Canvas width in CSS pixels. */
    width: number;
    /** Canvas height in CSS pixels. */
    height: number;
    /** Public deck viewport discriminator. */
    constructor: {displayName?: string; name?: string};
    /** Map common-space positions to screen pixels. */
    project(position: number[]): number[];
    /** Map screen pixels to the projected ground plane. */
    unproject(position: number[], options?: {targetZ?: number}): number[];
}

/** Orthographic state returned by the geographic fit operation. */
export interface ProjectedFitViewState {
    /** Center of the sampled projected extent, in common units. */
    target: [number, number, number];
    /** Log2 CSS pixels per common unit. */
    zoom: number;
}

/** Optional CSS padding and finite zoom range for sampled geographic fitting. */
export interface ProjectedFitOptions {
    /** Padding on every side in CSS pixels; defaults to 24. */
    padding?: number;
    /** Minimum orthographic zoom; defaults to -10. */
    minZoom?: number;
    /** Maximum orthographic zoom; defaults to 10. */
    maxZoom?: number;
}

/** Camera loading result, always restricted to the caller's single-world source region. */
export interface ProjectedCameraCoverage {
    /** Conservative geographic envelope, or null when the ground rectangle misses the source domain. */
    bounds: ProjectedGeographicBounds | null;
    /** Albers currently retains the complete source region rather than guessing curved extrema. */
    domainFallback: boolean;
}

/** Geographic focus retained while changing the worker's projection. */
export interface ProjectedFocusTransition {
    /** New common-space target with the existing orthographic zoom. */
    viewState: ProjectedFitViewState;
    /** Geographic focus used for the new target. */
    focus: ProjectedGeographicPosition;
    /** True when the destination's smaller domain requires clamping the focus. */
    clamped: boolean;
    /** True when the old target has no valid geographic inverse. */
    domainFallback: boolean;
}

/** Geographic domain shared by navigation and the existing projected preview. */
export function getProjectedGeographicBounds(type: ProjectedBasemapType): ProjectedGeographicBounds {
    normalizeProjectedBasemapOptions({type});
    return type === 'albers' ? [-170, 5, -40, 75] : [-180, -85.0511287798066, 180, 85.0511287798066];
}

/** Reject geographic, perspective or invalid-sized viewports before interpreting their methods. */
export function validateProjectedNavigationViewport(viewport: ProjectedNavigationViewport): void {
    if (viewport.isGeospatial !== false ||
        (viewport.constructor.displayName !== 'OrthographicViewport' && viewport.constructor.name !== 'OrthographicViewport') ||
        ![viewport.width, viewport.height].every(value => Number.isFinite(value) && value > 0)) {
        throw new Error('Projected navigation requires a finite deck.gl OrthographicViewport');
    }
}

/** Validate a source rectangle against both the tile world and the projection's current domain. */
export function validateProjectedGeographicBounds(bounds: ProjectedGeographicBounds, type: ProjectedBasemapType): void {
    countProjectedTileCoordinates(bounds, 0);
    const domain = getProjectedGeographicBounds(type);
    if (bounds[0] < domain[0] || bounds[1] < domain[1] || bounds[2] > domain[2] || bounds[3] > domain[3]) {
        throw new Error('Projected navigation bounds must remain within the projection domain');
    }
}

/** Caller-owned engine navigation; no projection kernels or deck cameras enter renderer core. */
export class ProjectedBasemapNavigation {
    /** Independent compiled forward/reverse CRS pairs, including lazy factory initialization. */
    private readonly transforms = new Map<string, Promise<ProjectionEngineTransform>>();
    /** Prevent late asynchronous work from publishing after example teardown. */
    private disposed = false;

    /** Retain a factory without taking ownership of its registrations, grids or lifetime. */
    constructor(private readonly engine: ProjectionEngine) {
        if (!engine || typeof engine.createProjection !== 'function' || typeof engine.createProjectionAsync !== 'function') {
            throw new Error('Projected navigation requires a ProjectionEngine factory');
        }
    }

    /** Project a detached longitude/latitude batch into north-positive common coordinates. */
    async projectPositions(coordinates: Float64Array, type: ProjectedBasemapType): Promise<Float64Array> {
        const domain = getProjectedGeographicBounds(type);
        if (!(coordinates instanceof Float64Array) || coordinates.length % 2 !== 0) {
            throw new Error('Projected navigation requires finite geographic pairs inside the projection domain');
        }
        const result = coordinates.slice();
        if (!result.every((value, index) => Number.isFinite(value) && value >= domain[index % 2] && value <= domain[index % 2 + 2])) {
            throw new Error('Projected navigation requires finite geographic pairs inside the projection domain');
        }
        const transform = await this.getTransform(type, false);
        transform.projectFlatSync(result, 2);
        for (let index = 0; index < result.length; index++) result[index] *= PROJECTED_COMMON_SCALE;
        if (!result.every(Number.isFinite)) throw new Error('Projected navigation produced nonfinite common coordinates');
        return result;
    }

    /** Project a geographic focus point without mutating the supplied pair. */
    async projectPosition(position: ProjectedGeographicPosition, type: ProjectedBasemapType): Promise<[number, number, number]> {
        if (position.length !== 2) throw new Error('Projected focus requires a longitude/latitude pair');
        const result = await this.projectPositions(new Float64Array(position), type);
        return [result[0], result[1], 0];
    }

    /** Invert ground; finite outside-domain/folded results return null. Engine errors propagate. */
    async unprojectPosition(position: readonly [number, number], type: ProjectedBasemapType): Promise<[number, number] | null> {
        if (position.length !== 2 || !position.every(Number.isFinite)) throw new Error('Projected inverse requires a finite common pair');
        const point: [number, number] = [position[0], position[1]];
        const result = new Float64Array(point.map(value => value / PROJECTED_COMMON_SCALE));
        const transform = await this.getTransform(type, true);
        transform.projectFlatSync(result, 2);
        const domain = getProjectedGeographicBounds(type);
        if (!result.every((value, index) => Number.isFinite(value) && value >= domain[index] - 1e-7 && value <= domain[index + 2] + 1e-7)) return null;
        const geographic: [number, number] = [Math.max(domain[0], Math.min(domain[2], result[0])),
            Math.max(domain[1], Math.min(domain[3], result[1]))];
        // Some inverse kernels wrap or fold outside the drawn map. Require a forward round trip.
        const restored = await this.projectPosition(geographic, type);
        if (Math.hypot(restored[0] - point[0], restored[1] - point[1]) <= 1e-5) return geographic;
        // The two source-world seam edges are distinct, even if an inverse kernel wraps one onto the other.
        if (domain[0] === -180 && domain[2] === 180 && Math.abs(Math.abs(geographic[0]) - 180) <= 1e-7) {
            const opposite: [number, number] = [geographic[0] < 0 ? 180 : -180, geographic[1]];
            const alternative = await this.projectPosition(opposite, type);
            if (Math.hypot(alternative[0] - point[0], alternative[1] - point[1]) <= 1e-5) return opposite;
        }
        return null;
    }

    /** Probe geographic coordinates on ground, not a rendered feature or depth/picking buffer. */
    async unprojectScreenPosition(viewport: ProjectedNavigationViewport, pixel: readonly [number, number],
        type: ProjectedBasemapType): Promise<[number, number] | null> {
        validateProjectedNavigationViewport(viewport);
        if (pixel.length !== 2 || !pixel.every(Number.isFinite)) throw new Error('Projected probe requires a finite screen pair');
        if (pixel[0] < 0 || pixel[1] < 0 || pixel[0] > viewport.width || pixel[1] > viewport.height) return null;
        const position = viewport.unproject([...pixel], {targetZ: 0});
        return this.unprojectPosition([position[0], position[1]], type);
    }

    /** Bound the viewport's ground rectangle using the fixed projections' separable latitude and longitude scales.
     * Equal Earth's longitude factor decreases with absolute latitude, so both latitude endpoints bound its envelope.
     * Albers has curved, nonseparable extrema; keep the supplied domain until conservative conic coverage is implemented.
     * This does not support wrapped worlds or arbitrary custom projection kernels.
     */
    async getCameraCoverage(viewport: ProjectedNavigationViewport, type: ProjectedBasemapType,
        sourceBounds: ProjectedGeographicBounds = getProjectedGeographicBounds(type)): Promise<ProjectedCameraCoverage> {
        if (this.disposed) throw new Error('Projected navigation is disposed');
        validateProjectedNavigationViewport(viewport);
        validateProjectedGeographicBounds(sourceBounds, type);
        const region: [number, number, number, number] = [...sourceBounds];
        const corners = [[0, 0], [viewport.width, 0], [0, viewport.height], [viewport.width, viewport.height]]
            .map(pixel => viewport.unproject(pixel, {targetZ: 0}));
        if (!corners.every(point => point.length >= 2 && point.slice(0, 2).every(Number.isFinite))) {
            throw new Error('Projected coverage requires finite ground corners');
        }
        if (type === 'albers') return {bounds: region, domainFallback: true};
        const minimumX = Math.min(...corners.map(point => point[0]));
        const maximumX = Math.max(...corners.map(point => point[0]));
        const minimumY = Math.min(...corners.map(point => point[1]));
        const maximumY = Math.max(...corners.map(point => point[1]));
        const southernEdge = await this.projectPosition([0, region[1]], type);
        const northernEdge = await this.projectPosition([0, region[3]], type);
        if (maximumY < southernEdge[1] || minimumY > northernEdge[1]) return {bounds: null, domainFallback: false};
        const south = await this.unprojectPosition([0, Math.max(minimumY, southernEdge[1])], type);
        const north = await this.unprojectPosition([0, Math.min(maximumY, northernEdge[1])], type);
        if (!south || !north) throw new Error('Projection engine could not invert the bounded latitude envelope');
        const southernScale = (await this.projectPosition([180, south[1]], type))[0] / 180;
        const northernScale = (await this.projectPosition([180, north[1]], type))[0] / 180;
        if (![southernScale, northernScale].every(value => Number.isFinite(value) && value > 0)) {
            throw new Error('Projected coverage requires a positive longitude scale');
        }
        // The equator supplies the largest Equal Earth scale if the rectangle crosses it.
        const scales = [southernScale, northernScale];
        if (south[1] < 0 && north[1] > 0) scales.push((await this.projectPosition([180, 0], type))[0] / 180);
        const west = Math.max(region[0], Math.min(...scales.map(scale => minimumX / scale)));
        const east = Math.min(region[2], Math.max(...scales.map(scale => maximumX / scale)));
        if (west > east) return {bounds: null, domainFallback: false};
        // An outward numerical margin protects exact tile edges without introducing an extra wrapped world.
        const margin = 1e-7;
        return {bounds: [Math.max(region[0], west - margin), Math.max(region[1], south[1] - margin),
            Math.min(region[2], east + margin), Math.min(region[3], north[1] + margin)], domainFallback: false};
    }

    /** Preserve geographic focus and numeric zoom; clamp to a smaller destination domain, never mutate the input.
     * A finite outside-domain target falls back to the destination domain center. Engine errors still propagate.
     * Keeping zoom does not imply preserving local ground scale across differently distorted projections.
     */
    async reprojectViewState(state: ProjectedFitViewState, from: ProjectedBasemapType,
        to: ProjectedBasemapType): Promise<ProjectedFocusTransition> {
        if (state.target.length !== 3 || ![...state.target, state.zoom].every(Number.isFinite)) {
            throw new Error('Projection transition requires a finite target and zoom');
        }
        const point: [number, number] = [state.target[0], state.target[1]];
        const zoom = state.zoom;
        const domain = getProjectedGeographicBounds(to);
        const previous = await this.unprojectPosition(point, from);
        const focus: [number, number] = previous ? [Math.max(domain[0], Math.min(domain[2], previous[0])),
            Math.max(domain[1], Math.min(domain[3], previous[1]))] : [(domain[0] + domain[2]) / 2, (domain[1] + domain[3]) / 2];
        return {viewState: {target: await this.projectPosition(focus, to), zoom}, focus,
            clamped: Boolean(previous && (focus[0] !== previous[0] || focus[1] !== previous[1])), domainFallback: previous === null};
    }

    /** Fit a sampled geographic extent; this is navigation, not a conservative visibility proof. */
    async fitBounds(bounds: ProjectedGeographicBounds, dimensions: {width: number; height: number},
        type: ProjectedBasemapType, options: ProjectedFitOptions = {}): Promise<ProjectedFitViewState> {
        validateProjectedGeographicBounds(bounds, type);
        const {padding = 24, minZoom = -10, maxZoom = 10} = options;
        if (![dimensions.width, dimensions.height, padding, minZoom, maxZoom].every(Number.isFinite) ||
            padding < 0 || dimensions.width <= 2 * padding || dimensions.height <= 2 * padding || minZoom > maxZoom) {
            throw new Error('Projected fit requires usable CSS dimensions, padding and an ordered zoom range');
        }
        const coordinates: number[] = [];
        for (let column = 0; column <= 32; column++) for (let row = 0; row <= 32; row++) {
            coordinates.push(bounds[0] + (bounds[2] - bounds[0]) * column / 32,
                bounds[1] + (bounds[3] - bounds[1]) * row / 32);
        }
        const positions = await this.projectPositions(new Float64Array(coordinates), type);
        let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
        for (let index = 0; index < positions.length; index += 2) {
            west = Math.min(west, positions[index]); east = Math.max(east, positions[index]);
            south = Math.min(south, positions[index + 1]); north = Math.max(north, positions[index + 1]);
        }
        const zoom = Math.log2(Math.min((dimensions.width - 2 * padding) / Math.max(east - west, 1e-9),
            (dimensions.height - 2 * padding) / Math.max(north - south, 1e-9)));
        return {target: [(west + east) / 2, (south + north) / 2, 0], zoom: Math.max(minZoom, Math.min(maxZoom, zoom))};
    }

    /** Release navigation-owned caches; leave the shared engine usable by the renderer. */
    dispose(): void {
        this.disposed = true;
        this.transforms.clear();
    }

    /** Share concurrent compilation, allow retry after failure and reject late results on teardown. */
    private async getTransform(type: ProjectedBasemapType, reverse: boolean): Promise<ProjectionEngineTransform> {
        if (this.disposed) throw new Error('Projected navigation is disposed');
        const options = getProjectedCoordinateOptions(type);
        const key = `${type}:${reverse}`;
        let pending = this.transforms.get(key);
        if (!pending) {
            pending = Promise.resolve().then(() => this.engine.createProjectionAsync(reverse ? {from: options.to, to: options.from} : options));
            this.transforms.set(key, pending);
            pending.catch(() => {if (this.transforms.get(key) === pending) this.transforms.delete(key);});
        }
        const transform = await pending;
        if (this.disposed) throw new Error('Projected navigation is disposed');
        return transform;
    }
}
