// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {GeographicAnchor, HostCamera, HostFrameOptions, HostProjection, Viewport} from '../types';

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
    /** Shared elapsed scene animation time in seconds, when supplied. */
    readonly animationTime?: number;

    /** Copies and validates a host frame without retaining caller matrix arrays. */
    constructor(options: HostFrameOptions) {
        const record = requireRecord(options, 'HostFrame');
        this.viewport = normalizeViewport(record.viewport, 'HostFrame viewport');
        this.geographicAnchor = normalizeAnchor(record.geographicAnchor);
        this.projection = normalizeProjection(record.projection);
        this.tileBuffer = normalizeNonNegative(record.tileBuffer ?? 0, 'tileBuffer');
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
            animationTime: record.animationTime === undefined ? undefined : normalizeNonNegative(record.animationTime, 'animationTime')
        });
    }
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
    const type = record.type ?? 'web-mercator';
    if (type === 'web-mercator') {
        return {type};
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
