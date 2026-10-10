// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

// @ts-nocheck

import Tile from './tile';
import {TileID} from './tile_id';
import TilePyramid from './tile_pyramid';
import Geo from '../utils/geo';
import mainThreadLabelCollisionPass from '../labels/main_pass';
import {layoutProjectedAnnotations} from '../labels/projected-pass';
import type HostFrame from '../scene/host_frame';
import log from '../utils/log';
import WorkerBroker from '../utils/worker_broker';
import Task from '../utils/task';
import {getGlobePreloadKey, getGlobeFallbackClipBounds, isGlobeFallbackStyle} from './globe_tile_preload';
import TangramTileset2D from './tangram_tileset_2d';
import type {ResourceTile} from './tile_resource_cache';
import type {TileCoordinate} from './tile_id';
import type {HostTileResourceOptions, TileResourceStatistics} from '../types';

export default class TileManager<TileT extends ResourceTile = Tile> {
    /** Current eye-union logical coordinates. */
    declare visible_coords: Record<string, TileCoordinate>;
    /** Coarse source/style tiles pinned by the current globe preload policy. */
    declare preloaded_keys: Set<string>;
    /** Resident metadata and shared resource policy; renderer work stays in this adapter. */
    declare tileset: TangramTileset2D<TileT>;

    /** Temporary keyed-table compatibility for existing renderer and test adapters. */
    get tiles() { return this.tileset.tileRecords; }
    set tiles(records) { this.tileset.tileRecords = records; }

    /** Worker reply/cancellation bridge into the shared scheduler. */
    get build_queue() { return this.tileset.buildQueue; }

    constructor({ scene }) {
        this.scene = scene;
        this.tileset = new TangramTileset2D();
        this.pyramid = new TilePyramid();
        this.visible_coords = {};
        this.queued_coords = [];
        this.preloaded_keys = new Set();
        this.preload_zoom = undefined;
        this.building_tiles = null;
        this.renderable_tiles = [];
        this.collision = {
            tile_keys: null,
            mesh_set: null,
            zoom: null,
            zoom_steps: 3 // divisions per zoom at which labels are re-collided (e.g. 0, 0.33, 0.66)
        };

        // Provide a hook for this object to be called from worker threads
        this.main_thread_target = ['TileManager', this.scene.id].join('_');
        WorkerBroker.addTarget(this.main_thread_target, this);
    }

    destroy() {
        this.tileset.finalize(tile => tile.destroy());
        this.pyramid = null;
        this.visible_coords = {};
        this.queued_coords = [];
        this.preloaded_keys.clear();
        this.scene = null;
        WorkerBroker.removeTarget(this.main_thread_target);
    }

    get view () {
        return this.scene.view;
    }

    get style_manager () {
        return this.scene.style_manager;
    }

    keepTile(tile) {
        this.tileset.setTile(tile);
        this.pyramid.addTile(tile);
    }

    hasTile(key) {
        return this.tileset.getTile(key) !== undefined;
    }

    forgetTile(key) {
        this.tileset.forgetTile(key, tile => this.pyramid.removeTile(tile));
        this.tileBuildStop(key);
    }

    // Remove a single tile
    removeTile(key) {
        log('trace', `tile unload for ${key}`);

        var tile = this.tiles[key];

        if (tile != null) {
            tile.destroy();
        }

        this.forgetTile(key);
        this.scene.requestRedraw();
    }

    // Run a function on each tile
    forEachTile(func) {
        for (let t in this.tiles) {
            func(this.tiles[t]);
        }
    }

    // Remove tiles that pass a filter condition
    removeTiles(filter) {
        let remove_tiles = [];
        for (let t in this.tiles) {
            let tile = this.tiles[t];
            if (filter(tile)) {
                remove_tiles.push(t);
            }
        }
        for (let r=0; r < remove_tiles.length; r++) {
            let key = remove_tiles[r];
            this.removeTile(key);
        }
    }

    updateTilesForView() {
        this.build_queue.suspend();
        try {
            // Find visible tiles and load new ones
            this.visible_coords = {};
            let tile_coords = this.view.findVisibleTileCoordinates();
            for (let c=0; c < tile_coords.length; c++) {
                const coords = tile_coords[c];
                this.queueCoordinate(coords);
                this.visible_coords[coords.key] = coords;
            }

            this.preloaded_keys.clear();
            const preloaded = this.view.findPreloadedTileCoordinates?.() || [];
            this.preloaded_coords = preloaded;
            this.preload_zoom = preloaded[0]?.z;
            for (const coords of preloaded) {
                for (const source of Object.values(this.scene.sources || {})) {
                    if (!source.builds_geometry_tiles || !source.includesTile(coords, this.view.tile_zoom)) continue;
                    const key = getGlobePreloadKey(coords, source, this.view.tile_zoom, coords.z);
                    if (key) this.preloaded_keys.add(key);
                }
            }

            // Prioritize visible detail before the bounded background preload batch.
            this.loadQueuedCoordinates();
            this.updateTileStates();
        } finally {
            this.build_queue.resume();
        }
    }

    /** Keep only the current source/style generation's global coarse tiles resident. */
    isTilePreloaded(key) {
        return this.preloaded_keys.has(key);
    }

    updateTileStates () {
        this.build_queue.suspend();
        try {
            this.forEachTile(tile => {
                this.updateVisibility(tile);
                this.build_queue.setPriority(tile.key, this.getBuildPriority(tile));
            });

            this.loadQueuedCoordinates();
            this.updateProxyTiles();
            for (const coords of this.preloaded_coords || []) this.loadCoordinate(coords, true);
            this.updateGlobeFallbackTiles();
            this.view.pruneTilesForView();
            this.enforceCacheLimits();
            this.updateRenderableTiles();
            this.style_manager.updateActiveStyles(this.renderable_tiles);
            this.style_manager.updateActiveBlendOrders(this.renderable_tiles);
            return this.updateLabels();
        } finally {
            this.build_queue.resume();
        }
    }

    /** Configure shared limits without starting old queued work before the new eye union is installed. */
    setResourceLimits(options: Readonly<HostTileResourceOptions> | undefined): void {
        this.tileset.setOptions(options);
    }

    /** Visible detail precedes global fallback, which precedes retained off-screen builds. */
    getBuildPriority(tile): number {
        return tile.visible ? 0 : this.isTilePreloaded(tile.key) ? 1 : 2;
    }

    /** Evict only completed unneeded tiles; visible/proxy/preload residency is reported separately. */
    enforceCacheLimits(): void {
        for (const key of this.tileset.getEvictionKeys(key => this.isTilePreloaded(key))) this.removeTile(key);
    }

    /** Detached worker and mesh residency diagnostics, suitable for host UI or tests. */
    getResourceStatistics(): TileResourceStatistics {
        return this.tileset.getStatistics(key => this.isTilePreloaded(key));
    }

    /** Layout annotations before drawing and refresh proxy/style ownership after label swaps. */
    updateProjectedLabels(frame: HostFrame, clockwiseRotation: boolean): void {
        const tiles = this.renderable_tiles.filter(tile => tile.valid && tile.built && !tile.fallback_for);
        const pending = tiles.some(tile => tile.pending_label_meshes !== null);
        if (layoutProjectedAnnotations(tiles, frame, {clockwiseRotation})) {
            if (pending) {
                // Swapped child styles can retire proxies. Relayout before this same frame draws,
                // otherwise an invisible older proxy keeps suppressing the child's annotations.
                this.updateTileStates();
                layoutProjectedAnnotations(this.renderable_tiles.filter(tile => tile.valid && tile.built && !tile.fallback_for),
                    frame, {clockwiseRotation});
            }
            this.style_manager.updateActiveStyles(this.renderable_tiles);
            this.style_manager.updateActiveBlendOrders(this.renderable_tiles);
            this.scene.requestRedraw();
        }
    }

    updateLabels () {
        // Projected candidates need actual screen cameras, not Mercator zoom/boxes.
        // Renderer lays them out synchronously across the complete HostFrame before drawing.
        if (this.view.projection.type === 'projected') return Promise.resolve({});
        if (this.scene.building && !this.scene.building.initial) {
            // log('debug', `Skip label layout due to on-going scene rebuild`);
            return Promise.resolve({});
        }

        // get current visible tiles and sort by key for consistency collision order
        const tiles = this.renderable_tiles
            .filter(t => !t.fallback_for)
            .filter(t => t.valid)
            .filter(t => t.built);

        if (tiles.length === 0) {
            return Promise.resolve({});
        }

        // Evaluate labels in order of tile build, to prevent previously visible labels
        // from disappearing, e.g. due to a newly loaded repeat label nearby
        tiles.sort((a, b) => a.build_id < b.build_id ? -1 : (a.build_id > b.build_id ? 1 : 0));

        // check if tile set has changed (in ways that affect collision)
        // if not, bail so that the existing collision task can carry on
        // if so, carry on and start a new collision task
        if (// 1st: check if same zoom level (rounded to a configurable precision)
            this.collision.zoom === roundPrecision(this.view.zoom, this.collision.zoom_steps) &&
            // 2nd: check if same set of tiles
            this.collision.tile_keys === JSON.stringify(tiles.map(t => t.key)) &&
            // 3rd: check if same set of meshes
            this.collision.mesh_set === meshSetString(tiles)) {
            // log('debug', `Skip label layout due to same tile/meshes (zoom ${this.view.zoom.toFixed(2)}, tiles ${this.collision.tile_keys})`);
            return Promise.resolve({});
        }

        // update collision if not already updating
        if (!this.collision.task) {
            this.collision.zoom = roundPrecision(this.view.zoom, this.collision.zoom_steps);
            this.collision.tile_keys = JSON.stringify(tiles.map(t => t.key));
            this.collision.mesh_set = meshSetString(tiles);
            // log('debug', `Update label collisions (zoom ${this.collision.zoom}, ${this.collision.tile_keys})`);

            // make a new collision task
            this.collision.task = {
                type: 'tileManagerUpdateLabels',
                run: async task => {
                    // Do collision pass, then update view
                    const results = await mainThreadLabelCollisionPass(tiles, this.collision.zoom, this.isLoadingVisibleTiles());
                    this.scene.requestRedraw();

                    // Clear state to allow another collision pass to start
                    this.collision.task = null;
                    Task.finish(task, results);

                    // Check if tiles changed during previous collision pass - will start new pass if so
                    this.updateTileStates();
                },
                immediate: true
            };
            Task.add(this.collision.task);
        }
        // else {
        //     log('debug', `Skip label layout due to on-going layout (zoom ${this.view.zoom.toFixed(2)}, tiles ${this.collision.tile_keys})`);
        // }
        return this.collision.task.promise;
    }

    updateProxyTiles () {
        if (this.preload_zoom !== undefined) {
            this.forEachTile(tile => tile.setProxyFor(null));
            return;
        }
        if (this.view.zoom_direction === 0) {
            return;
        }

        // Clear previous proxies
        this.forEachTile(tile => tile.setProxyFor(null));

        let proxy = false;
        this.forEachTile(tile => {
            if (tile.visible && !tile.labeled) {
                const parent = this.pyramid.getAncestor(tile);
                if (parent) {
                    parent.setProxyFor(tile);
                    proxy = true;
                } else {
                    const descendants = this.pyramid.getDescendants(tile);
                    for (let i=0; i < descendants.length; i++) {
                        descendants[i].setProxyFor(tile);
                        proxy = true;
                    }
                }
            }
        });

        if (!proxy) {
            this.view.zoom_direction = 0;
        }
    }

    updateVisibility(tile) {
        tile.visible = false;
        if (tile.style_z === this.view.tile_zoom) {
            const direct = this.visible_coords[tile.coords.key];
            if (direct && TileID.normalizedCoord(direct, tile.source).key === tile.coords.key) {
                tile.visible = true;
                return;
            }
            // Match the actual source-normalized data level, not any ancestor.
            // A data-only LOD transition retains style_z on both cached levels.
            for (let key in this.visible_coords) {
                if (TileID.normalizedCoord(this.visible_coords[key], tile.source).key === tile.coords.key) {
                    tile.visible = true;
                    break;
                }
            }
        }
    }

    /** Fill missing visible detail, even when rotation does not change the zoom. */
    updateGlobeFallbackTiles() {
        this.forEachTile(tile => { tile.fallback_for = null; tile.fallback_pending = false; });
        if (this.preload_zoom === undefined) return;
        for (const coords of Object.values(this.visible_coords)) {
            for (const source of Object.values(this.scene.sources || {})) {
                const key = TileID.normalizedKey(coords, source, this.view.tile_zoom);
                const detail = this.tiles[key];
                if (!detail || detail.built) continue;
                const fallbackKey = getGlobePreloadKey(detail.coords, source, this.view.tile_zoom, this.preload_zoom);
                const fallback = this.tiles[fallbackKey];
                if (!fallback || fallback === detail || !fallback.built) continue;
                if (!Object.keys(fallback.meshes || {}).some(name => fallback.meshes[name]?.length &&
                    isGlobeFallbackStyle(name, this.scene.styles?.[name]?.base))) continue;
                fallback.visible = true;
                fallback.fallback_for = fallback.fallback_for || new Map();
                fallback.fallback_for.set(detail.key, getGlobeFallbackClipBounds(fallback.coords, detail.coords));
                detail.fallback_pending = true;
            }
        }
    }

    // Remove tiles that aren't visible, and flag remaining visible ones to be updated (for loading, proxy, etc.)
    pruneToVisibleTiles () {
        this.removeTiles(tile => !tile.visible);
    }

    getRenderableTiles () {
        return this.renderable_tiles;
    }

    updateRenderableTiles() {
        this.renderable_tiles = [];
        for (let t in this.tiles) {
            let tile = this.tiles[t];
            if (tile.visible && tile.loaded && !tile.fallback_pending) {
                this.renderable_tiles.push(tile);
            }
        }
        return this.renderable_tiles;
    }

    isLoadingVisibleTiles () {
        return Object.keys(this.tiles).some(k => this.tiles[k].visible && !this.tiles[k].built);
    }

    allVisibleTilesLabeled () {
        return this.renderable_tiles.every(t => t.labeled);
    }

    // Queue a tile for load
    queueCoordinate(coords) {
        this.queued_coords[this.queued_coords.length] = coords;
    }

    // Load all queued tiles
    loadQueuedCoordinates() {
        if (this.queued_coords.length === 0) {
            return;
        }

        // Sort queued tiles from center tile
        this.queued_coords.sort((a, b) => {
            let center = this.view.center.meters;
            let half_span = Geo.metersPerTile(a.z) / 2;

            let ac = Geo.metersForTile(a);
            ac.x += half_span;
            ac.y -= half_span;

            let bc = Geo.metersForTile(b);
            bc.x += half_span;
            bc.y -= half_span;

            let ad = Math.abs(center.x - ac.x) + Math.abs(center.y - ac.y);
            let bd = Math.abs(center.x - bc.x) + Math.abs(center.y - bc.y);

            a.center_dist = ad;
            b.center_dist = bd;

            return (bd > ad ? -1 : (bd === ad ? 0 : 1));
        });
        this.queued_coords.forEach(coords => this.loadCoordinate(coords));
        this.queued_coords = [];
    }

    // Load all tiles to cover a given logical tile coordinate
    loadCoordinate(coords, preload = false) {
        // Skip if not at current scene zoom
        if (!preload && coords.z !== this.view.center.tile.z) {
            return;
        }

        // Determine necessary tiles for each source
        for (let s in this.scene.sources) {
            let source = this.scene.sources[s];
            // Check if data source should build this tile
            if (!source.builds_geometry_tiles || !source.includesTile(coords, this.view.tile_zoom)) {
                continue;
            }

            let key = TileID.normalizedKey(coords, source, this.view.tile_zoom);
            if (preload && !this.preloaded_keys.has(key)) continue;
            if (key && !this.hasTile(key)) {
                log('trace', `load tile ${key}, distance from view center: ${coords.center_dist}`);
                let tile = new Tile({
                    source,
                    coords,
                    workers: this.scene.workers,
                    // Data LOD can be coarser than style zoom in a host frame.
                    style_z: this.view.tile_zoom,
                    view: this.view
                });

                this.keepTile(tile);
                this.buildTile(tile);
            }
        }
    }

    // Start tile build process
    buildTile(tile, options) {
        this.tileBuildStart(tile.key);
        this.updateVisibility(tile);
        const generation = this.scene.generation;
        const token = `${tile.id}/${generation}`;
        this.build_queue.enqueue({key: tile.key, token, priority: this.getBuildPriority(tile),
            start: () => {
                Promise.resolve(tile.build(generation, options)).catch(error => {
                    if (this.tiles[tile.key] === tile && tile.generation === generation) {
                        this.buildTileError({...tile, error});
                    }
                });
            },
            fail: error => this.buildTileError({...tile, error})
        });
    }

    // Called on main thread when a web worker completes processing for a single tile (initial load, or rebuild)
    buildTileStylesCompleted({ tile, progress }) {
        // Removed this tile during load?
        if (this.tiles[tile.key] == null) {
            log('trace', `discarded tile ${tile.key} in TileManager.buildTileStylesCompleted because previously removed`);
            Tile.abortBuild(tile);
            this.updateTileStates();
        }
        // Built with an outdated scene configuration?
        else if (tile.generation !== this.scene.generation) {
            log('trace', `discarded tile ${tile.key} in TileManager.buildTileStylesCompleted because built with ` +
                `scene config gen ${tile.generation}, current ${this.scene.generation}`);
            Tile.abortBuild(tile);
            this.updateTileStates();
        }
        else {
            // Update tile with properties from worker
            if (this.tiles[tile.key]) {
                // Ignore if from a previously discarded tile
                if (tile.id < this.tiles[tile.key].id) {
                    log('trace', `discarded tile ${tile.key} for id ${tile.id} in TileManager.buildTileStylesCompleted because built for discarded tile id`);
                    Tile.abortBuild(tile);
                    return;
                }

                tile = this.tiles[tile.key].merge(tile);
            }

            if (progress.done) {
                tile.built = true;
            }

            this.scene.withWebGLContext(() => tile.buildMeshes(this.scene.styles, progress));
            this.updateTileStates();
            this.scene.requestRedraw();
        }

        if (progress.done) {
            this.tileBuildStop(tile.key, `${tile.id}/${tile.generation}`);
            // A completed off-screen tile becomes evictable only after releasing its build slot.
            this.enforceCacheLimits();
        }
    }

    // Called on main thread when web worker encounters an error building a tile
    buildTileError(tile) {
        const current = this.tiles[tile.key];
        if (!current || current.id !== tile.id || current.generation !== tile.generation ||
            tile.generation !== this.scene.generation) {
            Tile.abortBuild(tile);
            this.tileBuildStop(tile.key, `${tile.id}/${tile.generation}`);
            return;
        }
        log('error', `Error building tile ${tile.key}:`, tile.error);
        // Record the failure before releasing work: the last release may settle
        // the scene rebuild synchronously. Stale generations never reach here.
        this.scene.tileManagerBuildError?.(tile.error);
        const ownedMeshData = current.mesh_data;
        current.destroy();
        this.forgetTile(tile.key);
        // A rejected main-thread build can carry the same batch already owned by
        // its meshes. Destruction released that batch's texture references;
        // abort only independently transferred worker batches a second time.
        Tile.abortBuild(tile.mesh_data === ownedMeshData ? {...tile, mesh_data: undefined} : tile);
    }

    // Track tile build state
    tileBuildStart(key) {
        this.building_tiles = this.building_tiles || {};
        this.building_tiles[key] = true;
        log('trace', `tileBuildStart for ${key}: ${Object.keys(this.building_tiles).length}`);
    }

    tileBuildStop(key, token) {
        if (token !== undefined) this.build_queue.finish(key, token);
        // Done building?
        if (this.building_tiles) {
            log('trace', `tileBuildStop for ${key}: ${Object.keys(this.building_tiles).length}`);
            if (!this.build_queue.has(key)) delete this.building_tiles[key];
            this.checkBuildQueue();
        }
    }

    // Check status of tile building queue and notify scene when we're done
    checkBuildQueue() {
        this.build_queue.pump();
        if (!this.building_tiles || Object.keys(this.building_tiles).length === 0) {
            this.building_tiles = null;
            this.scene.tileManagerBuildDone();
        }
    }

    // Get a debug property across tiles
    getDebugProp(prop, filter) {
        var vals = [];
        for (var t in this.tiles) {
            if (this.tiles[t].debug[prop] != null && (typeof filter !== 'function' || filter(this.tiles[t]) === true)) {
                vals.push(this.tiles[t].debug[prop]);
            }
        }
        return vals;
    }

    // Sum of a debug property across tiles
    getDebugSum(prop, filter) {
        var sum = 0;
        for (var t in this.tiles) {
            if (this.tiles[t].debug[prop] != null && (typeof filter !== 'function' || filter(this.tiles[t]) === true)) {
                sum += this.tiles[t].debug[prop];
            }
        }
        return sum;
    }

    // Average of a debug property across tiles
    getDebugAverage(prop, filter) {
        return this.getDebugSum(prop, filter) / Object.keys(this.tiles).length;
    }

}

// Round a number to given number of decimal divisions
// e.g. roundPrecision(x, 4) rounds a number to increments of 0.25
function roundPrecision (x, d, places = 2) {
    return (Math.floor(x * d) / d).toFixed(places);
}

// Create a string representing the current set of meshes for a given set of tiles,
// based on their created timestamp. Used to determine when tiles should be re-collided.
function meshSetString (tiles) {
    return JSON.stringify(
        Object.entries(tiles).map(([,t]) => {
            return Object.entries(t.meshes).map(([,s]) => {
                return s.map(m => m.created_at);
            });
        })
    );
}
