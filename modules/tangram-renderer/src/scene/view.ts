// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen

// @ts-nocheck

import Geo from '../utils/geo';
import {TileID} from '../tile/tile_id';
import Camera from './camera';
import {WebMercatorVisibilityAdapter} from './visibility_adapter';
import Utils from '../utils/utils';
import subscribeMixin from '../utils/subscribe';
import log from '../utils/log';

export const VIEW_PAN_SNAP_TIME = 0.5;

export default class View {

    constructor (scene, options) {
        subscribeMixin(this);

        this.scene = scene;
        this.visibility_adapter = options.visibilityAdapter || new WebMercatorVisibilityAdapter();
        this.createMatrices();

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
        this.camera_mode = options.cameraMode || (options.externalCamera === true ? 'external' : 'scene');
        this.external_camera = this.camera_mode === 'external';
        this.continuous_zoom = (typeof options.continuousZoom === 'boolean') ? options.continuousZoom : true;
        this.wrap = (options.wrapView === false) ? false : true;
        this.preserve_tiles_within_zoom = 1;

        this.reset();
    }

    // Reset state before scene config is updated
    reset () {
        this.createCamera();
    }

    // Create camera
    createCamera () {
        if (this.external_camera) {
            this.camera = Camera.create('external', this, { type: 'external' });
            return;
        }
        let active_camera = this.getActiveCamera();
        if (active_camera) {
            this.camera = Camera.create(active_camera, this, this.scene.config.cameras[active_camera]);
            this.camera.updateView();
        }
    }

    // Supply camera matrices from an embedding renderer
    setCameraMatrices (matrices) {
        if (!this.camera || this.camera.type !== 'external') {
            throw new Error('View must use cameraMode \'external\' to accept camera matrices');
        }
        this.camera.setMatrices(matrices);
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
            return keys.length && keys[0];
        }
    }

    // Set active camera and recompile - for public API
    setActiveCamera (name) {
        let prev = this.getActiveCamera();
        if (prev === name) {
            return name;
        }

        if (this.scene.config.cameras[name]) {
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
    update () {
        if (this.camera != null && this.ready()) {
            this.camera.update();
        }
        this.pan_snap_timer = ((+new Date()) - this.panning_stop_at) / 1000;
        this.user_input_active = ((+new Date() - this.user_input_at) < this.user_input_timeout);
    }

    // Set logical pixel size of viewport
    setViewportSize (width, height) {
        this.size.css = { width, height };
        this.size.device = {
            width: Math.round(this.size.css.width * Utils.device_pixel_ratio),
            height: Math.round(this.size.css.height * Utils.device_pixel_ratio)
        };
        this.aspect = this.size.css.width / this.size.css.height;
        this.updateBounds();
    }

    // Set the host projection and its geographic visibility metadata.
    setProjection (projection = { type: 'web-mercator' }) {
        if (projectionsEqual(this.projection, projection)) {
            return false;
        }
        this.projection = projection;
        this.updateBounds();
        return true;
    }

    // Set the map view, can be passed an object with lat/lng and/or zoom
    setView ({ lng, lat, zoom } = {}) {
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
            this.updateBounds();
        }
        return changed;
    }

    setZoom (zoom) {
        let last_tile_zoom = this.tile_zoom;
        let tile_zoom = this.baseZoom(zoom);
        if (!this.continuous_zoom) {
            zoom = tile_zoom;
        }

        if (tile_zoom !== last_tile_zoom) {
            this.zoom_direction = tile_zoom > last_tile_zoom ? 1 : -1;
        }

        this.zoom = zoom;
        this.tile_zoom = tile_zoom;

        this.updateBounds(last_tile_zoom);
        this.scene.requestRedraw();
    }

    // Choose the base zoom level to use for a given fractional zoom
    baseZoom (zoom) {
        return Math.floor(zoom);
    }

    setPanning (panning) {
        this.panning = panning;
        if (!this.panning) {
            this.panning_stop_at = (+new Date());
        }
    }

    markUserInput () {
        this.user_input_at = (+new Date());
    }

    ready () {
        // TODO: better concept of "readiness" state?
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
        if (!this.ready()) {
            return;
        }

        const viewBounds = this.visibility_adapter.calculateBounds(this);
        this.tile_zoom = viewBounds.tileZoom;
        if (typeof previousTileZoom === 'number' && viewBounds.tileZoom !== previousTileZoom) {
            this.zoom_direction = viewBounds.tileZoom > previousTileZoom ? 1 : -1;
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

    findVisibleTileCoordinates () {
        if (!this.bounds) {
            return [];
        }

        if (this.projection.type === 'globe') {
            return this.findVisibleGlobeTileCoordinates();
        }

        return this.visibility_adapter.findVisibleTileCoordinates(this);
    }

    findVisibleGlobeTileCoordinates () {
        const [west, south, east, north] = this.projection.visibleBounds;
        const z = this.tile_zoom;
        const tileCount = Math.pow(2, z);
        const northY = latitudeToTileY(north, z);
        const southY = latitudeToTileY(south, z);
        const yStart = Math.max(0, Math.min(northY, southY) - this.buffer);
        const yEnd = Math.min(tileCount - 1, Math.max(northY, southY) + this.buffer);
        const longitudeRanges = splitLongitudeRange(west, east);
        const coordinates = [];
        const seen = new Set();

        for (const [rangeWest, rangeEast] of longitudeRanges) {
            const xStart = longitudeToTileX(rangeWest, z) - this.buffer;
            const xEnd = longitudeToTileX(rangeEast, z) + this.buffer;
            for (let x = xStart; x <= xEnd; x++) {
                const wrappedX = ((x % tileCount) + tileCount) % tileCount;
                for (let y = yStart; y <= yEnd; y++) {
                    const key = `${wrappedX}/${y}/${z}`;
                    if (!seen.has(key)) {
                        seen.add(key);
                        coordinates.push(TileID.coord({ x: wrappedX, y, z }));
                    }
                }
            }
        }
        return coordinates;
    }

    // Remove tiles too far outside of view
    pruneTilesForView () {
        // TODO: will this function ever be called when view isn't ready?
        if (!this.ready()) {
            return;
        }

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
            const zdiff = Math.abs(tile.style_z - this.tile_zoom);
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
            const view_buffer = this.meters_per_pixel * Geo.tile_size; // buffer area to keep tiles surrounding viewport
            const view_tile_min = TileID.coordAtZoom(
                Geo.tileForMeters(
                    [
                        this.center.meters.x - this.size.meters.x/2 - view_buffer,
                        this.center.meters.y + this.size.meters.y/2 + view_buffer
                    ],
                    this.tile_zoom),
                tile.coords.z);
            const view_tile_max = TileID.coordAtZoom(
                Geo.tileForMeters(
                    [
                        this.center.meters.x + this.size.meters.x/2 + view_buffer,
                        this.center.meters.y - this.size.meters.y/2 - view_buffer
                    ],
                    this.tile_zoom),
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
        this.matrices = {};
        this.matrices.model = new Float64Array(16);
        this.matrices.model32 = new Float32Array(16);
        this.matrices.model_view = new Float64Array(16);
        this.matrices.model_view32 = new Float32Array(16);
        this.matrices.normal = new Float64Array(9);
        this.matrices.normal32 = new Float32Array(9);
        this.matrices.inverse_normal32 = new Float32Array(9);
    }

    // Calculate and set model/view and normal matrices for a tile
    setupTile (tile, program) {
        const uniform_buffer = this.scene.uniform_buffers && this.scene.uniform_buffers.TangramTile;

        // Tile-specific state
        // TODO: calc these once per tile (currently being needlessly re-calculated per-tile-per-style)
        tile.setupProgram(this.matrices, program, uniform_buffer);

        // Model-view and normal matrices
        this.camera.setupMatrices(this.matrices, program, uniform_buffer);
        if (uniform_buffer) {
            program.bindUniformBlocks();
        }
    }

    // Set general uniforms that must be updated once per program
    setupProgram (program, uniform_buffers = {}) {
        if (uniform_buffers.TangramView) {
            uniform_buffers.TangramView.setUniforms({
                u_resolution: [this.size.device.width, this.size.device.height],
                u_map_position: [this.center.meters.x, this.center.meters.y, this.zoom],
                u_meters_per_pixel: this.meters_per_pixel,
                u_device_pixel_ratio: Utils.device_pixel_ratio,
                u_view_pan_snap_timer: this.pan_snap_timer,
                u_view_panning: this.panning,
                u_projection_mode: this.projection.type === 'globe' ? 1 : 0
            });
        }
        else {
            program.uniform('2fv', 'u_resolution', [this.size.device.width, this.size.device.height]);
            program.uniform('3fv', 'u_map_position', [this.center.meters.x, this.center.meters.y, this.zoom]);
            program.uniform('1f', 'u_meters_per_pixel', this.meters_per_pixel);
            program.uniform('1f', 'u_device_pixel_ratio', Utils.device_pixel_ratio);
            program.uniform('1f', 'u_view_pan_snap_timer', this.pan_snap_timer);
            program.uniform('1i', 'u_view_panning', this.panning);
            program.uniform('1i', 'u_projection_mode', this.projection.type === 'globe' ? 1 : 0);
        }

        this.camera.setupProgram(program, uniform_buffers.TangramCamera);
    }

    // View requires some animation, such as after panning stops
    isAnimating () {
        return (this.pan_snap_timer <= VIEW_PAN_SNAP_TIME);
    }

}

function projectionsEqual(previous, next) {
    if (previous === next) {
        return true;
    }
    if (!previous || !next || previous.type !== next.type) {
        return false;
    }
    if (next.type !== 'globe') {
        return true;
    }
    const previousBounds = previous.visibleBounds;
    const nextBounds = next.visibleBounds;
    return Array.isArray(previousBounds) && Array.isArray(nextBounds) &&
        previousBounds.length === nextBounds.length &&
        previousBounds.every((value, index) => value === nextBounds[index]);
}

function splitLongitudeRange(west, east) {
    if (east - west >= 360) {
        return [[-180, 180 - Number.EPSILON]];
    }
    const normalizedWest = normalizeLongitude(west);
    const normalizedEast = normalizeLongitude(east);
    return normalizedWest <= normalizedEast
        ? [[normalizedWest, normalizedEast]]
        : [[normalizedWest, 180 - Number.EPSILON], [-180, normalizedEast]];
}

function normalizeLongitude(longitude) {
    return ((longitude + 180) % 360 + 360) % 360 - 180;
}

function longitudeToTileX(longitude, zoom) {
    const tileCount = Math.pow(2, zoom);
    return Math.min(tileCount - 1, Math.max(0,
        Math.floor(((longitude + 180) / 360) * tileCount)));
}

function latitudeToTileY(latitude, zoom) {
    const tileCount = Math.pow(2, zoom);
    const clampedLatitude = Math.max(-85.05112878, Math.min(85.05112878, latitude));
    const radians = clampedLatitude * Math.PI / 180;
    const y = (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2;
    return Math.min(tileCount - 1, Math.max(0, Math.floor(y * tileCount)));
}
