// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Layer} from '@deck.gl/core';
import {Matrix4} from '@math.gl/core';
import {HostFrame, Renderer, normalizeProjectedBasemapOptions} from '@vis.gl/tangram-renderer/core';
import type {HostFrameOptions, ProjectedBasemapOptions} from '@vis.gl/tangram-renderer/core';
import createTangramLayerClass from '../tangram-layer';

/** The public, non-geospatial OrthographicViewport camera consumed by the adapter. */
export interface ProjectedViewport {
    /** Viewports must use Cartesian common-space positions, not automatic Mercator offsets. */
    isGeospatial: boolean;
    /** Viewport width in CSS pixels. */
    width: number;
    /** Viewport height in CSS pixels. */
    height: number;
    /** World-to-camera matrix supplied by deck.gl. */
    viewMatrix: ArrayLike<number>;
    /** Camera-to-clip matrix supplied by deck.gl. */
    projectionMatrix: ArrayLike<number>;
    /** Explicit deck.gl orthographic contract; perspective viewports are rejected. */
    constructor: {displayName?: string; name?: string};
}

/** Explicit geographic coverage and source detail; viewport zoom is not geographic style zoom. */
export interface ProjectedViewOptions {
    /** Must match the scene's worker projection; Albers initially uses a North American footprint. */
    projection: ProjectedBasemapOptions;
    /** Single-world west/south/east/north degrees; no poles or arbitrary-cut meridians. */
    visibleBounds: readonly [number, number, number, number];
    /** Data/style level in [0, 6], deliberately independent of OrthographicView zoom. */
    tileZoom: number;
}

/** Supply a common-space orthographic camera without claiming its matrices contain EPSG:3857 meters. */
export function getProjectedViewFrame(viewport: ProjectedViewport, options: ProjectedViewOptions,
    dimensions = {width: viewport.width, height: viewport.height}): HostFrameOptions {
    if (viewport.isGeospatial !== false ||
        (viewport.constructor.displayName !== 'OrthographicViewport' && viewport.constructor.name !== 'OrthographicViewport')) {
        throw new Error('CPU-projected basemaps require deck.gl OrthographicView');
    }
    const cameraProjection = new Matrix4(Array.from(viewport.projectionMatrix)).multiplyRight(Array.from(viewport.viewMatrix));
    const [west, south, east, north] = options.visibleBounds;
    const projection = normalizeProjectedBasemapOptions(options.projection);
    if (projection.type === 'albers' && (west < -170 || east > -40 || south < 5 || north > 75)) {
        throw new Error('Initial Albers coverage must remain within [-170, 5, -40, 75] degrees');
    }
    const frame: HostFrameOptions = {
        viewport: dimensions,
        projection: {type: 'projected', visibleBounds: options.visibleBounds},
        geographicAnchor: {longitude: (west + east) / 2, latitude: (south + north) / 2, zoom: options.tileZoom},
        tileZoom: options.tileZoom,
        tileBuffer: 0,
        renderViews: [{id: 'projected', camera: {view: new Float64Array(new Matrix4()),
            projection: new Float64Array(cameraProjection), position: [0, 0, 1]}}]
    };
    // Validate before any renderer frame or tile state is modified.
    new HostFrame(frame);
    return frame;
}

/** Add the isolated projection worker to an inline scene without mutating its sources or style definitions. */
export function createProjectedBasemapScene(scene: Record<string, unknown>, projection: ProjectedBasemapOptions,
    workerUrl: string): Record<string, unknown> {
    const options = normalizeProjectedBasemapOptions(projection);
    const url = new URL(workerUrl);
    if (!['http:', 'https:', 'blob:'].includes(url.protocol)) throw new Error('Projection worker requires an HTTP(S) or Blob URL');
    if (scene.import !== undefined) throw new Error('Initial projected basemaps require a self-contained inline scene');
    const styles = readRecord(scene.styles ?? {}, 'styles');
    for (const value of Object.values(styles)) {
        const style = readRecord(value, 'style');
        if (!['polygons', 'raster'].includes(String(style.base)) || style.mix !== undefined ||
            style.shaders !== undefined || (style.lighting !== undefined && style.lighting !== false)) {
            throw new Error('Projected styles require an unlit polygons/raster base without mixins or shaders');
        }
    }
    validateProjectedDraws(readRecord(scene.layers ?? {}, 'layers'), styles);
    const settings = scene.scene;
    if (settings !== undefined && (!settings || typeof settings !== 'object' || Array.isArray(settings))) {
        throw new Error('Projected scene settings must be an object');
    }
    const scripts = settings && 'scripts' in settings ? settings.scripts : [];
    if (!Array.isArray(scripts) || !scripts.every(script => typeof script === 'string')) {
        throw new Error('Projected scene scripts must be an array of URLs');
    }
    return {...scene, scene: {...settings, scripts: [...new Set([...scripts, url.href])], cpu_projection: options}};
}

/** Reject unsupported authored features before any worker starts or a partial map can appear. */
function validateProjectedDraws(node: Record<string, unknown>, styles: Record<string, unknown>): void {
    if (node.draw !== undefined) {
        for (const [name, value] of Object.entries(readRecord(node.draw, 'draw'))) {
            const draw = readRecord(value, 'draw style');
            if (!(name === 'polygons' || name === 'raster' || name in styles) ||
                (draw.extrude !== undefined && draw.extrude !== false) || draw.z !== undefined || draw.interactive === true) {
                throw new Error('Projected basemaps currently support only flat, noninteractive polygon and raster draws');
            }
        }
    }
    for (const [key, value] of Object.entries(node)) {
        if (key !== 'draw' && value && typeof value === 'object' && !Array.isArray(value)) {
            validateProjectedDraws(readRecord(value, 'layer'), styles);
        }
    }
}

/** Copy validated object records without accepting arrays or prototype properties as configuration. */
function readRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Projected ${label} must be an object`);
    return Object.fromEntries(Object.entries(value));
}

/** Opt-in deck.gl basemap layer; the ordinary package root still uses its existing view adapters. */
export const ProjectedBasemapLayer = createTangramLayerClass({Layer, ClassicWebGLRenderer: Renderer,
    Renderer: undefined}, {
        getFrame(viewport: ProjectedViewport, properties: {scene: unknown; projectedVisibleBounds?: ProjectedViewOptions['visibleBounds'];
            projectedTileZoom?: number}, dimensions: {width: number; height: number}) {
            const scene = readRecord(properties.scene, 'scene');
            const settings = readRecord(scene.scene, 'scene settings');
            const projection = normalizeProjectedBasemapOptions(settings.cpu_projection);
            return getProjectedViewFrame(viewport, {
                projection,
                visibleBounds: properties.projectedVisibleBounds ?? (projection.type === 'albers' ? [-170, 5, -40, 75] :
                    [-180, -85.0511287798066, 180, 85.0511287798066]),
                tileZoom: properties.projectedTileZoom ?? 2
            }, dimensions);
        }
    });
ProjectedBasemapLayer.layerName = 'ProjectedBasemapLayer';
ProjectedBasemapLayer.defaultProps = {...ProjectedBasemapLayer.defaultProps,
    projectedVisibleBounds: null, projectedTileZoom: 2};

export type {ProjectedBasemapOptions};
