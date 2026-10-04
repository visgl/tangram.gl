// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {GeographicAnchor, HostCamera, HostFrameOptions, HostProjection, HostTileLODOptions, HostTileResourceOptions, Viewport} from '../types';

/** Validated per-eye state; optional visibility overrides never change scene/style state. */
export interface NormalizedRenderView {
    readonly id: string;
    readonly viewport: Required<Viewport>;
    readonly camera: HostCamera;
    readonly geographicAnchor?: Required<GeographicAnchor>;
    readonly projection?: HostProjection;
}

/** Host-owned logical frame, shared tile visibility, and independently drawable eyes. */
export default class HostFrame {
    /** Full target dimensions in CSS pixels; origins are top-left. */
    readonly viewport: Required<Viewport>;
    /** Shared geographic/style anchor in degrees, altitude meters, and Tangram zoom. */
    readonly geographicAnchor: Required<GeographicAnchor>;
    /** Shared geographic projection. */
    readonly projection: HostProjection;
    /** Per-eye camera and footprint state. */
    readonly renderViews: readonly NormalizedRenderView[];
    /** Default eye to draw. */
    readonly activeRenderViewId: string;
    /** Conservative neighboring tile buffer. */
    readonly tileBuffer: number;
    /** Shared data-tile level, independent of scene/style zoom, when supplied. */
    readonly tileZoom?: number;
    /** Validated projected-scale LOD settings, when enabled. */
    readonly tileLOD?: Readonly<Required<HostTileLODOptions>>;
    /** Shared opt-in worker and completed off-screen mesh cache limits. */
    readonly tileResources?: Readonly<HostTileResourceOptions>;
    /** Optional globally resident globe fallback level, capped at 64 coordinates per source. */
    readonly globePreloadZoom?: number;
    /** Shared elapsed scene animation time in seconds, when supplied. */
    readonly animationTime?: number;

    /** Copies and validates a host frame without retaining caller matrix arrays. */
    constructor(options: HostFrameOptions) {
        const record = requireRecord(options, 'HostFrame');
        this.viewport = normalizeViewport(record.viewport, 'HostFrame viewport');
        this.geographicAnchor = normalizeAnchor(record.geographicAnchor);
        this.projection = normalizeProjection(record.projection);
        this.tileBuffer = normalizeNonNegative(record.tileBuffer ?? 0, 'tileBuffer');
        this.tileZoom = normalizeTileZoom(record.tileZoom, this.geographicAnchor.zoom);
        this.tileLOD = normalizeTileLOD(record.tileLOD);
        this.tileResources = normalizeTileResources(record.tileResources);
        this.globePreloadZoom = normalizeGlobePreloadZoom(record.globePreloadZoom);
        if (this.globePreloadZoom !== undefined && this.projection.type !== 'globe') {
            throw new Error('HostFrame globePreloadZoom requires a globe projection');
        }
        if (this.tileZoom !== undefined && this.tileLOD !== undefined) {
            throw new Error('HostFrame tileZoom and tileLOD are mutually exclusive');
        }
        this.animationTime = record.animationTime === undefined ? undefined :
            normalizeNonNegative(record.animationTime, 'animationTime');
        if (!Array.isArray(record.renderViews) || record.renderViews.length === 0) {
            throw new Error('HostFrame requires at least one render view');
        }
        const ids = new Set<string>();
        this.renderViews = record.renderViews.map((value: unknown, index: number) => {
            const view = requireRecord(value, `HostFrame render view ${index}`);
            const id = typeof view.id === 'string' && view.id ? view.id : index === 0 ? 'default' : `view-${index}`;
            if (ids.has(id)) {
                throw new Error(`HostFrame render view id '${id}' is duplicated`);
            }
            ids.add(id);
            const projection = view.projection === undefined ? undefined : normalizeProjection(view.projection);
            if (projection && projection.type !== this.projection.type) {
                throw new Error('HostFrame render views must share a projection type');
            }
            if (projection?.type === 'globe' && this.projection.type === 'globe' &&
                this.projection.maxElevation !== undefined) {
                if (projection.maxElevation === undefined) {
                    projection.maxElevation = this.projection.maxElevation;
                }
                else if (projection.maxElevation < this.projection.maxElevation) {
                    throw new Error('HostFrame render-view maxElevation cannot lower the shared scene bound');
                }
            }
            return {
                id,
                viewport: normalizeViewport(view.viewport ?? this.viewport, `HostFrame render view '${id}' viewport`),
                camera: normalizeCamera(view.camera, id),
                geographicAnchor: view.geographicAnchor === undefined ? undefined : normalizeAnchor(view.geographicAnchor),
                projection
            };
        });
        this.activeRenderViewId = typeof record.activeRenderViewId === 'string' && record.activeRenderViewId ||
            this.renderViews[0].id;
        this.getRenderView();
    }

    /** Validates untrusted application input, including the original single-view shape. */
    static from(frame: unknown): HostFrame {
        if (frame instanceof HostFrame) {
            return frame;
        }
        const record = requireRecord(frame, 'HostFrame');
        // Normalize unknown inputs before constructing the typed frame.
        if (record.renderViews !== undefined || record.geographicAnchor !== undefined) {
            return HostFrame.createValidated(record);
        }
        return HostFrame.fromLegacy(record);
    }

    /** Converts the original viewport/view/camera contract. */
    static fromLegacy(frame: unknown): HostFrame {
        const record = requireRecord(frame, 'HostFrame');
        return HostFrame.createValidated({
            ...record,
            geographicAnchor: record.view,
            renderViews: [{id: 'default', viewport: record.viewport, camera: record.camera}]
        });
    }

    /** Returns the selected eye or throws before any scene state is modified. */
    getRenderView(id = this.activeRenderViewId): NormalizedRenderView {
        const view = this.renderViews.find(candidate => candidate.id === id);
        if (!view) {
            throw new Error(`HostFrame render view '${id}' was not found`);
        }
        return view;
    }

    private static createValidated(record: Record<string, unknown>): HostFrame {
        const viewport = normalizeViewport(record.viewport, 'HostFrame viewport');
        if (!Array.isArray(record.renderViews) || record.renderViews.length === 0) {
            throw new Error('HostFrame requires at least one render view');
        }
        return new HostFrame({
            viewport,
            geographicAnchor: normalizeAnchor(record.geographicAnchor),
            projection: normalizeProjection(record.projection),
            renderViews: record.renderViews.map((value: unknown, index: number) => {
                const view = requireRecord(value, `HostFrame render view ${index}`);
                return {
                    id: typeof view.id === 'string' ? view.id : undefined,
                    viewport: normalizeViewport(view.viewport ?? viewport, 'HostFrame render view viewport'),
                    camera: normalizeCamera(view.camera, String(index)),
                    geographicAnchor: view.geographicAnchor === undefined ? undefined : normalizeAnchor(view.geographicAnchor),
                    projection: view.projection === undefined ? undefined : normalizeProjection(view.projection)
                };
            }),
            activeRenderViewId: typeof record.activeRenderViewId === 'string' ? record.activeRenderViewId : undefined,
            tileBuffer: normalizeNonNegative(record.tileBuffer ?? 0, 'tileBuffer'),
            tileZoom: normalizeTileZoom(record.tileZoom, normalizeAnchor(record.geographicAnchor).zoom),
            tileLOD: normalizeTileLOD(record.tileLOD),
            tileResources: normalizeTileResources(record.tileResources),
            globePreloadZoom: normalizeGlobePreloadZoom(record.globePreloadZoom),
            animationTime: record.animationTime === undefined ? undefined : normalizeNonNegative(record.animationTime, 'animationTime')
        });
    }
}

/** Reject unsafe limits before any camera or worker state is modified. */
function normalizeTileResources(value: unknown): HostTileResourceOptions | undefined {
    if (value === undefined) return undefined;
    const record = requireRecord(value, 'HostFrame tileResources');
    const result: HostTileResourceOptions = {};
    for (const name of ['maxConcurrentBuilds', 'maxCachedTiles', 'maxCachedMeshBytes'] as const) {
        const limit = record[name];
        if (limit === undefined) continue;
        if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < (name === 'maxConcurrentBuilds' ? 1 : 0)) {
            throw new Error(`HostFrame tileResources ${name} must be a ${name === 'maxConcurrentBuilds' ? 'positive' : 'non-negative'} safe integer`);
        }
        result[name] = limit;
    }
    return Object.freeze(result);
}

/** Bound global residency before any tile enumeration or scene mutation. */
function normalizeGlobePreloadZoom(value: unknown): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 3) {
        throw new Error('HostFrame globePreloadZoom must be an integer from 0 to 3');
    }
    return value;
}

/** Copy and validate all policy inputs before camera or scene state is touched. */
function normalizeTileLOD(value: unknown): Required<HostTileLODOptions> | undefined {
    if (value === undefined) return undefined;
    const record = requireRecord(value, 'HostFrame tileLOD');
    const targetTilePixels = record.targetTilePixels ?? 512;
    const pixelRatio = record.pixelRatio ?? 1;
    const maxTiles = record.maxTiles ?? 256;
    const hysteresis = record.hysteresis ?? 0.2;
    if (!isFiniteNumber(targetTilePixels) || targetTilePixels <= 0 ||
        !isFiniteNumber(pixelRatio) || pixelRatio <= 0 ||
        !isFiniteNumber(maxTiles) || !Number.isSafeInteger(maxTiles) || maxTiles < 1 ||
        !isFiniteNumber(hysteresis) || hysteresis < 0 || hysteresis >= 1) {
        throw new Error('HostFrame tileLOD requires positive pixel scales, a positive integer maxTiles, and hysteresis in [0, 1)');
    }
    return {targetTilePixels, pixelRatio, maxTiles, hysteresis};
}

/** Validate coarsening without introducing unsupported geometry underzoom. */
function normalizeTileZoom(value: unknown, styleZoom: number): number | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 22 ||
        value > Math.floor(styleZoom)) {
        throw new Error('HostFrame tileZoom must be an integer from 0 to 22, no higher than the shared style zoom');
    }
    return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} requires an object`);
    }
    return Object.fromEntries(Object.entries(value));
}

function normalizeViewport(value: unknown, label: string): Required<Viewport> {
    const record = value && typeof value === 'object' ? requireRecord(value, label) : {};
    if (!isFiniteNumber(record.width) || record.width <= 0 ||
        !isFiniteNumber(record.height) || record.height <= 0) {
        throw new Error(`${label} requires positive width and height`);
    }
    return {x: finiteOr(record.x, 0), y: finiteOr(record.y, 0), width: record.width, height: record.height};
}

function normalizeAnchor(value: unknown): Required<GeographicAnchor> {
    const record = value && typeof value === 'object' ? requireRecord(value, 'HostFrame geographic anchor') : {};
    if (!isFiniteNumber(record.longitude) || !isFiniteNumber(record.latitude) || !isFiniteNumber(record.zoom)) {
        throw new Error('HostFrame geographic anchor requires finite longitude, latitude, and zoom');
    }
    return {longitude: record.longitude, latitude: record.latitude, zoom: record.zoom, altitude: finiteOr(record.altitude, 0)};
}

function normalizeProjection(value: unknown): HostProjection {
    const record = value === undefined ? {} : requireRecord(value, 'HostFrame projection');
    const type = value === undefined ? 'web-mercator' : record.type;
    if (type === 'web-mercator') {
        if (record.visibleBounds === undefined) return {type};
        if (record.visibleBounds === null) return {type, visibleBounds: null};
        const bounds = record.visibleBounds;
        if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(isFiniteNumber) ||
            bounds[0] > bounds[2] || bounds[1] > bounds[3] || bounds[1] <= -90 || bounds[3] >= 90) {
            throw new Error('HostFrame planar projection requires finite ordered visibleBounds with latitudes strictly between -90 and 90');
        }
        return {type, visibleBounds: [bounds[0], bounds[1], bounds[2], bounds[3]]};
    }
    if (type !== 'globe') {
        throw new Error(`HostFrame projection type '${String(type)}' is invalid`);
    }
    const bounds = record.visibleBounds;
    if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(isFiniteNumber)) {
        throw new Error('HostFrame globe projection requires finite visibleBounds');
    }
    return {
        type, visibleBounds: [bounds[0], bounds[1], bounds[2], bounds[3]],
        ...(record.maxElevation === undefined ? {} : {
            maxElevation: normalizeNonNegative(record.maxElevation, 'maxElevation')
        })
    };
}

function normalizeCamera(value: unknown, id: string): HostCamera {
    const record = value && typeof value === 'object' ? requireRecord(value, 'HostFrame camera') : {};
    const view = readFiniteArray(record.view, 16);
    const projection = readFiniteArray(record.projection, 16);
    const position = readFiniteArray(record.position, 3);
    if (!view || !projection || !position) {
        throw new Error(`HostFrame render view '${id}' requires finite camera matrices and position`);
    }
    const projectionMatrix = new Float32Array(projection);
    if (!projectionMatrix.every(Number.isFinite)) {
        throw new Error(`HostFrame render view '${id}' requires finite camera matrices and position`);
    }
    return {view: new Float64Array(view), projection: projectionMatrix, position: [position[0], position[1], position[2]]};
}

function readFiniteArray(value: unknown, length: number): number[] | null {
    if (!Array.isArray(value) && !(value instanceof Float32Array) && !(value instanceof Float64Array)) {
        return null;
    }
    const values: unknown[] = Array.from(value);
    return values.length === length && values.every(isFiniteNumber) ? values : null;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function finiteOr(value: unknown, fallback: number): number {
    return isFiniteNumber(value) ? value : fallback;
}

function normalizeNonNegative(value: unknown, label: string): number {
    if (!isFiniteNumber(value) || value < 0) {
        throw new Error(`HostFrame ${label} must be a finite non-negative number`);
    }
    return value;
}
