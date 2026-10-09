// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Layer} from '@deck.gl/core';
import {Matrix4} from '@math.gl/core';
import {HostFrame, Renderer, normalizeProjectedBasemapOptions, countProjectedTileCoordinates, getProjectedRoadUnit, validateProjectedLights} from '@vis.gl/tangram-renderer/core';
import type {HostFrameOptions, HostTileResourceOptions, ProjectedBasemapOptions} from '@vis.gl/tangram-renderer/core';
import createTangramLayerClass from '../tangram-layer.js';

export {ProjectedBasemapNavigation, getProjectedGeographicBounds} from './projected-navigation';
export type {ProjectedNavigationViewport, ProjectedBasemapType, ProjectedGeographicBounds,
    ProjectedGeographicPosition, ProjectedFitOptions, ProjectedFitViewState,
    ProjectedCameraCoverage, ProjectedFocusTransition, ProjectedNavigationRequestOptions} from './projected-navigation';
export {selectProjectedTileDetail} from './projected-detail';
export type {ProjectedTileDetailOptions, ProjectedTileDetail} from './projected-detail';

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
    /** Source data detail in [0, 6], deliberately independent of OrthographicView zoom. */
    tileZoom: number;
    /** Styling level in [0, 22], no lower than data detail; defaults to tileZoom. */
    styleZoom?: number;
    /** Optional positive per-source candidate limit checked before any tile allocation. */
    maxTiles?: number;
    /** Shared worker concurrency and completed off-screen mesh cache limits. */
    tileResources?: HostTileResourceOptions;
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
    const styleZoom = options.styleZoom ?? options.tileZoom;
    if (!Number.isSafeInteger(styleZoom) || styleZoom < 0 || styleZoom > 22) {
        throw new Error('Projected styleZoom must be an integer in [0, 22]');
    }
    if (options.maxTiles !== undefined && (!Number.isSafeInteger(options.maxTiles) || options.maxTiles < 1)) {
        throw new Error('Projected maxTiles must be a positive safe integer');
    }
    if (projection.type === 'albers' && (west < -170 || east > -40 || south < 5 || north > 75)) {
        throw new Error('Initial Albers coverage must remain within [-170, 5, -40, 75] degrees');
    }
    const frame: HostFrameOptions = {
        viewport: dimensions,
        projection: {type: 'projected', visibleBounds: options.visibleBounds},
        geographicAnchor: {longitude: (west + east) / 2, latitude: (south + north) / 2, zoom: styleZoom},
        tileZoom: options.tileZoom,
        tileBuffer: 0,
        ...(options.tileResources === undefined ? {} : {tileResources: options.tileResources}),
        renderViews: [{id: 'projected', camera: {view: new Float64Array(new Matrix4()),
            projection: new Float64Array(cameraProjection), position: [0, 0, 1]}}]
    };
    // Validate before any renderer frame or tile state is modified.
    new HostFrame(frame);
    if (options.maxTiles !== undefined) {
        const count = countProjectedTileCoordinates(options.visibleBounds, options.tileZoom);
        if (count > options.maxTiles) {
            throw new Error(`Projected footprint requires ${count} tiles per source, exceeding maxTiles ${options.maxTiles}`);
        }
    }
    return frame;
}

/** Add the isolated projection worker to an inline scene without mutating its sources or style definitions. */
export function createProjectedBasemapScene(scene: Record<string, unknown>, projection: ProjectedBasemapOptions,
    workerUrl: string): Record<string, unknown> {
    const options = normalizeProjectedBasemapOptions(projection);
    validateProjectedLights(scene.lights);
    const url = new URL(workerUrl);
    if (!['http:', 'https:', 'blob:'].includes(url.protocol)) throw new Error('Projection worker requires an HTTP(S) or Blob URL');
    if (scene.import !== undefined) throw new Error('Initial projected basemaps require a self-contained inline scene');
    const styles = readRecord(scene.styles ?? {}, 'styles');
    for (const value of Object.values(styles)) {
        const style = readRecord(value, 'style');
        if (!['polygons', 'raster', 'lines', 'points', 'text'].includes(String(style.base)) || style.mix !== undefined ||
            style.shaders !== undefined || (style.lighting !== undefined && style.lighting !== false &&
                (!['polygons', 'raster'].includes(String(style.base)) || !['vertex', 'fragment'].includes(String(style.lighting))))) {
            throw new Error('Projected styles require ground/annotation bases or vertex/fragment-lit surfaces without mixins or shaders');
        }
        if (style.material !== undefined) {
            const material = readRecord(style.material, 'material');
            if (material.normal !== undefined || (material.specular !== undefined && material.specular !== 0)) {
                throw new Error('Projected lighting supports diffuse materials without normal maps or specular terms');
            }
        }
        if (style.draw !== undefined) validateFlatDraw(readRecord(style.draw, 'style draw defaults'),
            Boolean(options.allowElevation && ['polygons', 'raster'].includes(String(style.base))));
        if (style.base === 'raster' && style.draw !== undefined && readRecord(style.draw, 'raster defaults').interactive === true) {
            throw new Error('Raster imagery does not expose selectable source features');
        }
        if (style.base === 'lines') {
            validateRoadDraw(style, false);
            if (style.draw !== undefined) validateRoadDraw(readRecord(style.draw, 'style draw defaults'), false);
        }
    }
    for (const layer of Object.values(readRecord(scene.layers ?? {}, 'layers'))) {
        validateProjectedDraws(readRecord(layer, 'root layer'), styles, {}, Boolean(options.allowElevation));
    }
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
function validateProjectedDraws(node: Record<string, unknown>, styles: Record<string, unknown>,
    inheritedDraws: Record<string, Record<string, unknown>> = {}, allowElevation = false): void {
    const effectiveDraws = {...inheritedDraws};
    if (node.draw !== undefined) {
        for (const [name, value] of Object.entries(readRecord(node.draw, 'draw'))) {
            const draw = mergeAnnotationDraws(effectiveDraws[name] ?? {}, readRecord(value, 'draw style'));
            effectiveDraws[name] = draw;
            const styleName = String(draw.style ?? name);
            const style = styleName in styles ? readRecord(styles[styleName], 'draw style definition') : {base: styleName};
            if (!['polygons', 'raster', 'lines', 'points', 'text'].includes(String(style.base))) {
                throw new Error('Projected basemaps require supported surface, road or annotation bases');
            }
            validateFlatDraw(draw, allowElevation && ['polygons', 'raster'].includes(String(style.base)));
            if (style.base === 'raster' && draw.interactive === true) throw new Error('Raster imagery does not expose selectable source features');
            if (style.base === 'points' || style.base === 'text') {
                const defaults = style.draw === undefined ? {} : readRecord(style.draw, 'annotation defaults');
                const annotation = mergeAnnotationDraws(defaults, draw);
                if (annotation.collide !== false) throw new Error('Projected annotations require explicit collide: false');
                if (annotation.text !== undefined) {
                    const text = readRecord(annotation.text, 'attached text');
                    if (text.collide !== false) throw new Error('Projected annotations require explicit collide: false');
                    validateFlatDraw(text);
                }
            }
            if (style.base === 'lines') {
                const defaults = style.draw === undefined ? {} : readRecord(style.draw, 'style draw defaults');
                validateRoadDraw({...defaults, ...draw}, true);
            }
        }
    }
    for (const [key, value] of Object.entries(node)) {
        // Match Tangram layer parsing: configuration records are not child layers.
        if (!['filter', 'draw', 'visible', 'enabled', 'data', 'exclusive', 'priority'].includes(key) &&
            value && typeof value === 'object' && !Array.isArray(value)) {
            validateProjectedDraws(readRecord(value, 'layer'), styles, effectiveDraws, allowElevation);
        }
    }
}

/** Preserve nested attached-text settings when applying style defaults or child-layer overrides. */
function mergeAnnotationDraws(defaults: Record<string, unknown>, draw: Record<string, unknown>): Record<string, unknown> {
    const merged = {...defaults, ...draw};
    if (defaults.text && typeof defaults.text === 'object' && !Array.isArray(defaults.text) &&
        draw.text && typeof draw.text === 'object' && !Array.isArray(draw.text)) {
        merged.text = {...readRecord(defaults.text, 'attached text defaults'), ...readRecord(draw.text, 'attached text')};
    }
    return merged;
}

/** Apply height opt-in to layer draws and inherited style defaults; interactive draws opt into selection. */
function validateFlatDraw(draw: Record<string, unknown>, allowElevation = false): void {
    if (!allowElevation && ((draw.extrude !== undefined && draw.extrude !== false) || draw.z !== undefined)) {
        throw new Error('Projected basemaps require flat draws unless allowElevation is enabled');
    }
}

/** Copy validated object records without accepting arrays or prototype properties as configuration. */
function readRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Projected ${label} must be an object`);
    return Object.fromEntries(Object.entries(value));
}

/** Fixed and zoom-stop meter/pixel roads share the builder; reject functions and mixed-unit offsets/outlines. */
function validateRoadDraw(draw: Record<string, unknown>, requireWidth: boolean): void {
    if (draw.outline !== undefined) readRecord(draw.outline, 'road outline');
    if (['next_width', 'next_offset', 'texture'].some(key => draw[key] !== undefined)) {
        throw new Error('Projected roads require static ribbons without dynamic widths or external textures');
    }
    if (draw.width !== undefined || requireWidth) {
        const unit = getProjectedRoadUnit(draw.width);
        if (draw.offset !== undefined && getProjectedRoadUnit(draw.offset, false) !== unit) throw new Error('Projected road offsets must use the width unit');
        if (draw.outline !== undefined) {
            const outline = readRecord(draw.outline, 'road outline');
            validateFlatDraw(outline);
            if (outline.style !== undefined) throw new Error('Projected road outlines must use the parent line style');
            if (getProjectedRoadUnit(outline.width) !== unit) throw new Error('Projected road outlines must use the width unit');
            validateRoadDraw(outline, true);
        }
    }
    if (draw.animated !== undefined && typeof draw.animated !== 'boolean') throw new Error('Projected road animated must be boolean');
    if (draw.dash !== undefined && (!Array.isArray(draw.dash) || draw.dash.length === 0 ||
        !draw.dash.every(value => typeof value === 'number' && Number.isFinite(value) && value > 0))) {
        throw new Error('Projected road dash must contain positive finite lengths');
    }
}

/** Opt-in deck.gl basemap layer; the ordinary package root still uses its existing view adapters. */
const BaseProjectedBasemapLayer = createTangramLayerClass({Layer, ClassicWebGLRenderer: Renderer,
    Renderer: undefined}, {
        getFrame(viewport: ProjectedViewport, properties: {scene: unknown; projectedVisibleBounds?: ProjectedViewOptions['visibleBounds'];
            projectedTileZoom?: number; projectedProjection?: ProjectedBasemapOptions;
            projectedStyleZoom?: number | null; projectedMaxTiles?: number | null;
            tileResources?: HostTileResourceOptions | null}, dimensions: {width: number; height: number}) {
            const scene = readRecord(properties.scene, 'scene');
            const settings = readRecord(scene.scene, 'scene settings');
            const projection = normalizeProjectedBasemapOptions(properties.projectedProjection ?? settings.cpu_projection);
            return getProjectedViewFrame(viewport, {
                projection,
                visibleBounds: properties.projectedVisibleBounds ?? (projection.type === 'albers' ? [-170, 5, -40, 75] :
                    [-180, -85.0511287798066, 180, 85.0511287798066]),
                tileZoom: properties.projectedTileZoom ?? 2,
                ...(properties.projectedStyleZoom == null ? {} : {styleZoom: properties.projectedStyleZoom}),
                ...(properties.projectedMaxTiles == null ? {} : {maxTiles: properties.projectedMaxTiles}),
                ...(properties.tileResources == null ? {} : {tileResources: properties.tileResources})
            }, dimensions);
        }
    });

/** Opt-in projection changes rebuild meshes on the existing renderer instead of reloading the scene. */
export class ProjectedBasemapLayer extends BaseProjectedBasemapLayer {
    /**
     * Query interactive Tangram geometry asynchronously in viewport-local CSS pixels.
     * This is not deck.gl's synchronous picking API. The host must keep rendering
     * until the selection pass and worker lookup finish; the layer requests a redraw.
     */
    getFeatureAt(pixel: {x: number; y: number}, options: {radius?: number} = {}): Promise<import('@vis.gl/tangram-renderer/core').FeatureSelectionResult | undefined> {
        const record = this.state.tangramRecord;
        if (!record || record.disposed || record.loadFailed) return Promise.resolve(undefined);
        const pending = record.renderer.getFeatureAt(pixel, options);
        record.owner.setNeedsRedraw();
        return pending;
    }
    /** deck.gl's stable layer identity for state transfer between property updates. */
    static layerName = 'ProjectedBasemapLayer';
    /** Optional projection override and completion notification, independent of source scene identity. */
    static defaultProps = {...BaseProjectedBasemapLayer.defaultProps,
        projectedVisibleBounds: null, projectedTileZoom: 2, projectedProjection: null,
        projectedStyleZoom: null, projectedMaxTiles: null,
        onProjectionChange: {type: 'function', value: () => {}}};

    /** Keep the ordinary scene lifecycle, then queue an opt-in projection-only update after loading. */
    updateState(parameters: {props: {projectedProjection?: ProjectedBasemapOptions}}): void {
        super.updateState(parameters);
        const record = this.state.tangramRecord;
        if (!record) return;
        const settings = readRecord(readRecord(record.sceneSource, 'scene').scene, 'scene settings');
        const projection = normalizeProjectedBasemapOptions(parameters.props.projectedProjection ?? settings.cpu_projection);
        const key = JSON.stringify(projection);
        if (record.projectedProjectionKey === key) return;
        record.projectedProjectionKey = key;
        Promise.resolve(record.loadPromise).then(async () => {
            if (record.disposed || record.loadFailed || record.projectedProjectionKey !== key) return;
            await record.renderer.setProjectedBasemapProjection(projection);
            if (!record.disposed && record.projectedProjectionKey === key) {
                record.owner.props.onProjectionChange(projection);
                record.owner.setNeedsRedraw();
            }
        }).catch(error => {
            if (!record.disposed && record.projectedProjectionKey === key) {
                record.projectedProjectionKey = null;
                record.owner._reportSceneError(record, error);
            }
        });
    }
}

export type {ProjectedBasemapOptions};
