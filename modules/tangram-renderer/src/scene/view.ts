// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import Geo from '../utils/geo';
import {TileID} from '../tile/tile_id';
import ExternalCamera from './external_camera';
import type Camera from './camera_base';
import type {CameraView, CameraConfiguration, MatrixSet, Program, UniformBuffer} from './camera_base';
import type HostFrame from './host_frame';
import type {HostCamera, HostProjection} from '../types';
import type {Bounds, Meters, Tile} from '../utils/geo';
import type {TileCoordinate} from '../tile/tile_id';
import type {VisibilityLODAdapter, GlobeVisibilityLODAdapter, VisibilityViewState} from './visibility_adapter';
import type {SubscriptionMethods} from '../utils/subscribe';
import {
    WebMercatorGlobeVisibilityAdapter,
    WebMercatorVisibilityAdapter
} from './visibility_adapter';
import Utils from '../utils/utils';
import subscribeMixin from '../utils/subscribe';
import log from '../utils/log';

export const VIEW_PAN_SNAP_TIME = 0.5;


/** Optional camera construction policy, supplied only by the classic entry. */
export type CameraFactory = (name: string, view: CameraView, config: CameraConfiguration) => Camera;

/** Options owned by the renderer view rather than a specific host library. */
export interface ViewOptions {
    cameraFactory?: CameraFactory;
    cameraMode?: 'external' | 'scene';
    externalCamera?: boolean;
    visibilityAdapter?: VisibilityLODAdapter;
    globeVisibilityAdapter?: GlobeVisibilityLODAdapter;
    continuousZoom?: boolean;
    wrapView?: boolean;
}

interface ViewTile {
    visible: boolean;
    loading: boolean;
    style_z: number;
    preserve_tiles_within_zoom?: number;
    coords: TileCoordinate;
    key: string;
    isProxy(): boolean;
    setupProgram(matrices: MatrixSet, program: ViewProgram, buffer?: UniformBuffer): void;
}

interface ViewProgram extends Program {
    uniform(type: string, name: string, value: number | boolean | number[] | Float32Array | Float64Array): void;
    bindUniformBlocks(): void;
}

/** Scene services used by View; no dependency on the scene implementation. */
export interface ViewScene {
    config: {cameras?: Record<string, CameraConfiguration & {active?: boolean}>} | null;
    uniform_buffers?: Record<string, UniformBuffer>;
    tile_manager: {
        updateTilesForView(): void;
        removeTiles(predicate: (tile: ViewTile) => boolean): void;
    };
    updateConfig(options: {rebuild: boolean; normalize: boolean}): unknown;
    requestRedraw(): void;
}

type ViewCenter = {lng: number; lat: number; meters?: Meters; tile?: Tile};

export default class View {
    declare subscribe: SubscriptionMethods['subscribe'];
    declare unsubscribe: SubscriptionMethods['unsubscribe'];
    declare unsubscribeAll: SubscriptionMethods['unsubscribeAll'];
    declare trigger: SubscriptionMethods['trigger'];
    declare hasSubscribersFor: SubscriptionMethods['hasSubscribersFor'];
    readonly scene: ViewScene;
    readonly visibility_adapter: VisibilityLODAdapter;
    readonly globe_visibility_adapter: GlobeVisibilityLODAdapter;
    private readonly cameraFactory?: CameraFactory;
    private hostFrame: HostFrame | null = null;
    private visibilityKey = '';
    private applyingFrame = false;
    camera?: Camera;
    zoom: number | null;
    /** Integer style zoom retained for source display filters and worker geometry. */
    tile_zoom: number | undefined;
    center: ViewCenter | null;
    bounds: Bounds | null;
    meters_per_pixel: number | null;
    size: {css: {width?: number; height?: number}; device: {width?: number; height?: number}; meters: Partial<Meters>};
    aspect: number | null;
    buffer: number;
    projection: HostProjection;
    camera_mode: 'external' | 'scene';
    external_camera: boolean;
    continuous_zoom: boolean;
    wrap: boolean;
    preserve_tiles_within_zoom: number;
    panning: boolean;
    panning_stop_at: number;
    pan_snap_timer: number;
    zoom_direction: number;
    user_input_at: number;
    user_input_timeout: number;
    user_input_active: boolean;
    matrices: MatrixSet & {model32: Float32Array; model_view: Float64Array; normal: Float64Array} = createViewMatrices();


    constructor (scene: ViewScene, options: ViewOptions = {}) {
        subscribeMixin(this);

        this.scene = scene;
        this.cameraFactory = options.cameraFactory;
        this.visibility_adapter = options.visibilityAdapter || new WebMercatorVisibilityAdapter();
        this.globe_visibility_adapter = options.globeVisibilityAdapter || new WebMercatorGlobeVisibilityAdapter();

        this.zoom = null;
        this.center = null;
        this.bounds = null;
        this.meters_per_pixel = null;

        this.panning = false;
        this.panning_stop_at = 0;
        this.pan_snap_timer = 0;
        this.zoom_direction = 0;

        this.user_input_at = 0;
        this.user_input_timeout = 50;
        this.user_input_active = false;

        // Size of viewport in CSS pixels, device pixels, and mercator meters
        this.size = {
            css: {},
            device: {},
            meters: {}
        };
        this.aspect = null;

        this.buffer = 0;
        this.projection = { type: 'web-mercator' };
        // Host-driven renderers own camera projection. `externalCamera` remains
        // as a compatibility alias while callers migrate to the explicit mode.
        this.camera_mode = options.cameraMode || (options.externalCamera === true || !options.cameraFactory ? 'external' : 'scene');
        this.external_camera = this.camera_mode === 'external';
        this.continuous_zoom = (typeof options.continuousZoom === 'boolean') ? options.continuousZoom : true;
        this.wrap = (options.wrapView === false) ? false : true;
        this.preserve_tiles_within_zoom = 1;

        this.reset();
    }

    /** Installs every host field before making one visibility update. */
    applyHostFrame(frame: HostFrame, resize: () => void, setCamera: () => void): void {
        const key = JSON.stringify({
            anchor: frame.geographicAnchor, projection: frame.projection, buffer: frame.tileBuffer, tileZoom: frame.tileZoom,
            views: frame.renderViews.map(view => ({
                viewport: view.viewport, anchor: view.geographicAnchor, projection: view.projection,
                camera: {view: Array.from(view.camera.view), projection: Array.from(view.camera.projection), position: view.camera.position}
            }))
        });
        const changed = key !== this.visibilityKey;
        this.hostFrame = frame;
        this.applyingFrame = true;
        try {
            this.buffer = frame.tileBuffer;
            this.setProjection(frame.projection);
            resize();
            this.setView({lng: frame.geographicAnchor.longitude, lat: frame.geographicAnchor.latitude, zoom: frame.geographicAnchor.zoom});
            setCamera();
        }
        finally {
            this.applyingFrame = false;
        }
        this.visibilityKey = key;
        if (changed) {
            this.updateBounds();
        }
    }

    private invalidateBounds(previousTileZoom = this.tile_zoom): void {
        if (!this.applyingFrame) {
            this.updateBounds(previousTileZoom);
        }
    }

    private getVisibilityState(): VisibilityViewState | null {
        if (!this.center || this.zoom === null || this.size.css.width === undefined || this.size.css.height === undefined) {
            return null;
        }
        return {
            center: this.center, zoom: this.zoom,
            tile_zoom: this.hostFrame?.tileZoom ?? this.tile_zoom ?? this.baseZoom(this.zoom),
            size: {css: {width: this.size.css.width, height: this.size.css.height}},
            bounds: this.bounds, buffer: this.buffer, wrap: this.wrap
        };
    }

    private getReadyState() {
        if (!this.center?.meters || this.zoom === null || this.meters_per_pixel === null || this.aspect === null ||
            this.size.css.width === undefined || this.size.css.height === undefined ||
            this.size.meters.x === undefined || this.size.meters.y === undefined) {
            throw new Error('View camera state is not ready');
        }
        return {
            centerMeters: this.center.meters, zoom: this.zoom, metersPerPixel: this.meters_per_pixel,
            aspect: this.aspect, width: this.size.css.width, height: this.size.css.height,
            sizeMeters: {x: this.size.meters.x, y: this.size.meters.y}
        };
    }

    private getCameraView(): CameraView {
        const view = this;
        return {
            scene: this.scene,
            setView: state => this.setView(state),
            get size() {
                const state = view.getReadyState();
                return {css: {width: state.width, height: state.height}, meters: state.sizeMeters};
            },
            get aspect() { return view.getReadyState().aspect; },
            get zoom() { return view.getReadyState().zoom; },
            get meters_per_pixel() { return view.getReadyState().metersPerPixel; },
            get center() { return {meters: view.getReadyState().centerMeters}; }
        };
    }

    private findCoordinates(state: VisibilityViewState, projection: HostProjection, position?: ArrayLike<number>): TileCoordinate[] {
        if (projection.type === 'globe') {
            return this.globe_visibility_adapter.findVisibleTileCoordinates({
                tile_zoom: state.tile_zoom, buffer: state.buffer, visibleBounds: projection.visibleBounds,
                ...(projection.maxElevation === undefined ? {} : {maxElevation: projection.maxElevation}),
                cameraPosition: position ? [position[0], position[1], position[2]] : undefined
            });
        }
        if (projection.visibleBounds !== undefined) {
            const bounds = projection.visibleBounds;
            if (bounds === null) return [];
            const southwest = Geo.latLngToMeters([bounds[0], bounds[1]]);
            const northeast = Geo.latLngToMeters([bounds[2], bounds[3]]);
            if (!southwest.every(Number.isFinite) || !northeast.every(Number.isFinite)) {
                throw new Error('HostFrame planar visibleBounds must project to finite meters');
            }
            return this.visibility_adapter.findVisibleTileCoordinates({...state,
                bounds: {sw: {x: southwest[0], y: southwest[1]}, ne: {x: northeast[0], y: northeast[1]}}});
        }
        return this.visibility_adapter.findVisibleTileCoordinates(state);
    }

    // Reset state before scene config is updated
    reset () {
        this.createCamera();
    }

    // Create camera
    createCamera () {
        if (this.external_camera) {
            this.camera = new ExternalCamera('external', this.getCameraView(), { type: 'external' });
            return;
        }
        let active_camera = this.getActiveCamera();
        if (active_camera && this.cameraFactory && this.scene.config?.cameras) {
            this.camera = this.cameraFactory(active_camera, this.getCameraView(), this.scene.config.cameras[active_camera]);
            this.camera.updateView();
        }
    }

    // Supply camera matrices from an embedding renderer
    setCameraMatrices (matrices: HostCamera) {
        if (!this.camera || !(this.camera instanceof ExternalCamera)) {
            throw new Error('View must use cameraMode \'external\' to accept camera matrices');
        }
        if (this.camera.setMatrices(matrices)) {
            this.invalidateBounds();
        }
    }

    // Get active camera - for public API
    getActiveCamera () {
        if (this.scene.config && this.scene.config.cameras) {
            for (let name in this.scene.config.cameras) {
                if (this.scene.config.cameras[name].active) {
                    return name;
                }
            }

            // If no camera set as active, use first one
            let keys = Object.keys(this.scene.config.cameras);
            return keys[0];
        }
    }

    // Set active camera and recompile - for public API
    setActiveCamera (name: string) {
        let prev = this.getActiveCamera();
        if (prev === name) {
            return name;
        }

        if (this.scene.config?.cameras?.[name]) {
            this.scene.config.cameras[name].active = true;

            // Clear previously active camera
            if (prev && this.scene.config.cameras[prev]) {
                delete this.scene.config.cameras[prev].active;
            }
        }

        this.scene.updateConfig({ rebuild: false, normalize: false });
        return this.getActiveCamera();
    }

    // Update method called once per frame
    update (time = Date.now()) {
        if (this.camera != null && this.ready()) {
            this.camera.update();
        }
        this.pan_snap_timer = (time - this.panning_stop_at) / 1000;
        this.user_input_active = ((time - this.user_input_at) < this.user_input_timeout);
    }

    // Set logical pixel size of viewport
    setViewportSize (width: number, height: number) {
        this.size.css = { width, height };
        this.size.device = {
            width: Math.round(width * (Utils.device_pixel_ratio ?? 1)),
            height: Math.round(height * (Utils.device_pixel_ratio ?? 1))
        };
        this.aspect = width / height;
        this.invalidateBounds();
    }

    // Set the host projection and its geographic visibility metadata.
    setProjection (projection: HostProjection = { type: 'web-mercator' }) {
        if (projectionsEqual(this.projection, projection)) {
            return false;
        }
        this.projection = projection;
        this.invalidateBounds();
        return true;
    }

    // Set the map view, can be passed an object with lat/lng and/or zoom
    setView ({ lng, lat, zoom }: {lng?: number; lat?: number; zoom?: number} = {}) {
        var changed = false;

        // Set center
        if (typeof lng === 'number' && typeof lat === 'number') {
            if (!this.center || lng !== this.center.lng || lat !== this.center.lat) {
                changed = true;
                this.center = { lng, lat };
            }
        }

        // Set zoom
        if (typeof zoom === 'number' && zoom !== this.zoom) {
            changed = true;
            this.setZoom(zoom);
        }

        if (changed) {
            this.invalidateBounds();
        }
        return changed;
    }

    setZoom (zoom: number) {
        let last_tile_zoom = this.tile_zoom;
        let tile_zoom = this.baseZoom(zoom);
        if (!this.continuous_zoom) {
            zoom = tile_zoom;
        }

        if (tile_zoom !== last_tile_zoom) {
            this.zoom_direction = typeof last_tile_zoom === 'number' && tile_zoom > last_tile_zoom ? 1 : -1;
        }

        this.zoom = zoom;
        this.tile_zoom = tile_zoom;

        this.invalidateBounds(last_tile_zoom);
        this.scene.requestRedraw();
    }

    // Choose the base zoom level to use for a given fractional zoom
    baseZoom (zoom: number) {
        return Math.floor(zoom);
    }

    setPanning (panning: boolean) {
        this.panning = panning;
        if (!this.panning) {
            this.panning_stop_at = (+new Date());
        }
    }

    markUserInput () {
        this.user_input_at = (+new Date());
    }

    ready () {
        // TODO: better concept of 'readiness' state?
        if (typeof this.size.css.width !== 'number' ||
            typeof this.size.css.height !== 'number' ||
            this.center == null ||
            typeof this.zoom !== 'number') {
            return false;
        }
        return true;
    }

    // Calculate viewport bounds based on current center and zoom
    updateBounds (previousTileZoom = this.tile_zoom) {
        const state = this.getVisibilityState();
        if (!state || !this.center) {
            return;
        }

        const viewBounds = this.visibility_adapter.calculateBounds(state);
        this.tile_zoom = this.hostFrame?.tileZoom === undefined ? viewBounds.tileZoom : this.baseZoom(state.zoom);
        if (typeof previousTileZoom === 'number' && this.tile_zoom !== previousTileZoom) {
            this.zoom_direction = this.tile_zoom > previousTileZoom ? 1 : -1;
        }
        this.meters_per_pixel = viewBounds.metersPerPixel;
        this.size.meters = viewBounds.sizeMeters;
        this.center.meters = viewBounds.centerMeters;
        this.center.tile = viewBounds.centerTile;
        this.bounds = viewBounds.bounds;

        this.scene.tile_manager.updateTilesForView();

        this.trigger('move');
        this.scene.requestRedraw(); // TODO automate via move event?
    }

    findVisibleTileCoordinates (): TileCoordinate[] {
        if (!this.bounds) {
            return [];
        }


        const state = this.getVisibilityState();
        if (!state) {
            return [];
        }
        const hostFrame = this.hostFrame;
        const views = hostFrame?.renderViews;
        if (!views) {
            return this.findCoordinates(state, this.projection, this.camera?.position_meters);
        }
        const coordinates = new Map<string, TileCoordinate>();
        for (const eye of views) {
            const anchor = eye.geographicAnchor ?? hostFrame.geographicAnchor;
            const projection = eye.projection ?? this.projection;
            const eyeState: VisibilityViewState = {
                ...state,
                center: {lng: anchor.longitude, lat: anchor.latitude},
                zoom: anchor.zoom,
                tile_zoom: hostFrame.tileZoom ?? this.baseZoom(anchor.zoom),
                size: {css: eye.viewport},
                camera: projection.type === 'web-mercator' ? eye.camera : undefined
            };
            const bounds = this.visibility_adapter.calculateBounds(eyeState);
            const visible = this.findCoordinates(
                {...eyeState, bounds: bounds.bounds, tile_zoom: bounds.tileZoom},
                projection, eye.camera.position
            );
            for (const coordinate of visible) {
                coordinates.set(coordinate.key ?? `${coordinate.x}/${coordinate.y}/${coordinate.z}`, coordinate);
            }
        }
        return Array.from(coordinates.values());
    }

    // Remove tiles too far outside of view
    pruneTilesForView () {
        // TODO: will this function ever be called when view isn't ready?
        if (!this.ready() || !this.center?.meters || this.meters_per_pixel === null ||
            this.size.meters.x === undefined || this.size.meters.y === undefined || this.tile_zoom === undefined) {
            return;
        }
        const centerMeters = this.center.meters;
        const sizeMeters = {x: this.size.meters.x, y: this.size.meters.y};
        const metersPerPixel = this.meters_per_pixel;
        const tileZoom = this.tile_zoom;

        this.scene.tile_manager.removeTiles(tile => {
            // Ignore visible tiles
            if (tile.visible || tile.isProxy()) {
                return false;
            }

            // Remove tiles outside given zoom that are still loading
            if (tile.loading && tile.style_z !== this.tile_zoom) {
                return true;
            }

            // Discard if too far from current zoom
            const zdiff = Math.abs(tile.style_z - tileZoom);
            const preserve_tiles_within_zoom = (tile.preserve_tiles_within_zoom != null ?
                tile.preserve_tiles_within_zoom : this.preserve_tiles_within_zoom); // optionally tile source specific
            if (zdiff > preserve_tiles_within_zoom) {
                return true;
            }

            if (this.projection.type === 'globe') {
                return true;
            }

            // Discard tiles outside an area surrounding the viewport, handling tiles at different zooms
            // Get min and max tiles for the viewport, at the scale of the tile currently being evaluated
            const view_buffer = metersPerPixel * Geo.tile_size; // buffer area to keep tiles surrounding viewport
            const view_tile_min = TileID.coordAtZoom(
                Geo.tileForMeters(
                    [
                        centerMeters.x - sizeMeters.x/2 - view_buffer,
                        centerMeters.y + sizeMeters.y/2 + view_buffer
                    ],
                    tileZoom),
                tile.coords.z);
            const view_tile_max = TileID.coordAtZoom(
                Geo.tileForMeters(
                    [
                        centerMeters.x + sizeMeters.x/2 + view_buffer,
                        centerMeters.y - sizeMeters.y/2 - view_buffer
                    ],
                    tileZoom),
                tile.coords.z);

            if (tile.coords.x < view_tile_min.x || tile.coords.x > view_tile_max.x ||
                tile.coords.y < view_tile_min.y || tile.coords.y > view_tile_max.y) {
                log('trace', `View: remove tile ${tile.key} (as ${tile.coords.key}) ` +
                    `for being too far out of visible area (${view_tile_min.key}, ${view_tile_max.key})`);
                return true;
            }
            return false;
        });
    }

    // Allocate model-view matrices
    // 64-bit versions are for CPU calcuations
    // 32-bit versions are downsampled and sent to GPU
    createMatrices () {

        this.matrices = createViewMatrices();
    }

    // Calculate and set model/view and normal matrices for a tile
    setupTile (tile: ViewTile, program: ViewProgram) {
        const uniform_buffer = this.scene.uniform_buffers && this.scene.uniform_buffers.TangramTile;

        // Tile-specific state
        // TODO: calc these once per tile (currently being needlessly re-calculated per-tile-per-style)
        tile.setupProgram(this.matrices, program, uniform_buffer);

        // Model-view and normal matrices
        this.camera?.setupMatrices(this.matrices, program, uniform_buffer);
        if (uniform_buffer) {
            program.bindUniformBlocks();
        }
    }

    // Set general uniforms that must be updated once per program
    setupProgram (program: ViewProgram, uniform_buffers: Record<string, UniformBuffer> = {}) {
        const {centerMeters, zoom, metersPerPixel} = this.getReadyState();
        const width = this.size.device.width ?? 0;
        const height = this.size.device.height ?? 0;
        if (uniform_buffers.TangramView) {
            uniform_buffers.TangramView.setUniforms({
                u_resolution: [width, height],
                u_map_position: [centerMeters.x, centerMeters.y, zoom],
                u_meters_per_pixel: metersPerPixel,
                u_device_pixel_ratio: Utils.device_pixel_ratio ?? 1,
                u_view_pan_snap_timer: this.pan_snap_timer,
                u_view_panning: this.panning,
                u_projection_mode: this.projection.type === 'globe' ? 1 : 0
            });
        }
        else {
            program.uniform('2fv', 'u_resolution', [width, height]);
            program.uniform('3fv', 'u_map_position', [centerMeters.x, centerMeters.y, zoom]);
            program.uniform('1f', 'u_meters_per_pixel', metersPerPixel);
            program.uniform('1f', 'u_device_pixel_ratio', Utils.device_pixel_ratio ?? 1);
            program.uniform('1f', 'u_view_pan_snap_timer', this.pan_snap_timer);
            program.uniform('1i', 'u_view_panning', this.panning);
            program.uniform('1i', 'u_projection_mode', this.projection.type === 'globe' ? 1 : 0);
        }

        this.camera?.setupProgram(program, uniform_buffers.TangramCamera);
    }

    // View requires some animation, such as after panning stops
    isAnimating () {
        return (this.pan_snap_timer <= VIEW_PAN_SNAP_TIME);
    }

}

function projectionsEqual(previous: HostProjection, next: HostProjection): boolean {
    if (previous === next) {
        return true;
    }
    if (!previous || !next || previous.type !== next.type) {
        return false;
    }
    const previousBounds = previous.visibleBounds;
    const nextBounds = next.visibleBounds;
    const heightMatches = previous.type !== 'globe' || next.type !== 'globe' ||
        previous.maxElevation === next.maxElevation;
    return heightMatches && (previousBounds === nextBounds || (
        Array.isArray(previousBounds) && Array.isArray(nextBounds) &&
        previousBounds.length === nextBounds.length &&
        previousBounds.every((value, index) => value === nextBounds[index])));
}

/** Allocates the CPU and GPU matrix views used for one tile's transforms. */
function createViewMatrices() {
    return {
        model: new Float64Array(16), model32: new Float32Array(16),
        model_view: new Float64Array(16), model_view32: new Float32Array(16),
        normal: new Float64Array(9), normal32: new Float32Array(9), inverse_normal32: new Float32Array(9)
    };
}
