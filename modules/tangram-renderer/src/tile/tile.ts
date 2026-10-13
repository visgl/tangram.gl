// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import log from '../utils/log';
import Utils from '../utils/utils';
import mergeObjects from '../utils/merge';
import Geo from '../utils/geo';
import {TileID} from './tile_id';
import type VBOMesh from '../gl/vbo_mesh';
import {addLayerDebugEntry} from '../styles/style';
import StyleParser from '../styles/style_parser';
import Collision from '../labels/collision';
import WorkerBroker from '../utils/worker_broker';
import Task from '../utils/task';
import Texture from '../gl/texture';
import {getTileSourceRequest, updateTileSourceRequest} from '../sources/tile_source_state';

import {Matrix4} from '@math.gl/core';
import type {TileCoordinate, TileCoordinates, TileSource, TileReference} from './tile_id';
import type {BrokerMethod, BrokerWorker} from '../utils/worker-types';
import type {Meters} from '../utils/geo';
import type UniformBuffer from '../gl/uniform_buffer';
import type {TileDebug, TileBuildStyle, TileStylePayload, TileBuildProgress, WorkerBuildTile, LayerDebugCounts, TileBuildLayer, DecodedTileFeature} from './tile-build-types';
import type {StyleFeature} from '../styles/property-types';

/** Source identity and retention policy consumed by tile ownership. */
interface TileSourcePolicy extends TileSource {
    id: number | string;
    tiled?: boolean;
    preserve_tiles_within_zoom?: number;
    max_zoom?: number;
}

let id = 0; // unique tile id
let build_id = 0; // id tracking order in which tiles were build

export default class Tile {
    /** Constructor-owned source metadata. */
    declare source: TileSourcePolicy;
    /** Host view identity; geometry construction does not inspect it. */
    declare view: unknown;
    /** Actual normalized source coordinates. */
    declare coords: TileCoordinate;
    /** Style detail independent of source zoom. */
    declare style_z: number;
    /** Overzoom conversion factors. */
    declare overzoom: number;
    declare overzoom2: number;
    /** Absolute Mercator tile origin, extent and bounds. */
    declare min: Meters;
    declare max: Meters;
    declare span: Meters;
    declare bounds: {sw: Meters; ne: Meters};
    /** Style-unit conversion factors copied to the worker. */
    declare meters_per_pixel: number;
    declare meters_per_pixel_sq: number;
    declare units_per_pixel: number;
    declare units_per_meter_overzoom: number;
    declare preserve_tiles_within_zoom?: number;
    /** Selected worker and its pool offset; destruction clears the worker reference. */
    declare worker: BrokerWorker | null;
    declare worker_id: number;
    /** Residency, loading and proxy state. */
    declare valid: boolean;
    declare loaded: boolean;
    declare labeled: boolean;
    declare fade_in: boolean;
    declare proxy_for: Tile[] | null;
    declare proxied_as: 'child' | 'parent' | null;
    declare proxy_level: number;
    declare proxy_order_offset: number;
    declare fallback_for?: Map<string, readonly [number, number, number, number]> | null;
    /** A coarse fallback currently replaces this detail tile in the draw membership. */
    declare fallback_pending?: boolean;
    /** Uploaded style names for the in-progress generation. */
    declare new_mesh_styles: string[];
    declare mesh_data?: Record<string, TileStylePayload>;
    /** Last upload order and worker error/debug reply. */
    declare build_id: number;
    declare error: string | null;
    declare debug: TileDebug;
    /** Cached child coordinates, retained for classic compatibility. */
    declare static coord_children: Record<string, Record<string, TileReference[]>>;
    /** Worker-visible tile identity. */
    declare id: number;
    /** Source/style-normalized cache key. */
    declare key: string;
    /** Generation currently submitted to the worker, or null before the first build. */
    declare generation: number | null;
    /** Visibility shared by every host eye. */
    declare visible: boolean;
    /** Whether initial worker processing remains incomplete. */
    declare loading: boolean;
    /** Completion of every mesh batch for the current generation. */
    declare built: boolean;
    /** GPU mesh ownership by style. */
    declare meshes: Record<string, VBOMesh[]>;
    /** Admitted-generation annotations awaiting screen collision. */
    declare pending_label_meshes: Record<string, VBOMesh[]> | null;
    /** Replacement GPU owners kept out of the display until the worker generation drains. */
    terrainStage?: {meshes: Record<string, VBOMesh[]>; labels: Record<string, VBOMesh[]> | null; styles: string[]; done?: boolean};
    /** Upload owners created in one staged batch, including allocations not yet attached to a style. */
    private terrainUploadOwners?: VBOMesh[];
    matrix4 = new Matrix4();

    /**
        Tile
        @constructor
        Required properties:
        coords: object with {x, y, z} properties identifying tile coordinate location
        worker: web worker to handle tile construction
    */
    constructor({ coords, style_z, source, workers, view }: {coords: TileCoordinates; style_z: number; source: TileSourcePolicy; workers: BrokerWorker[]; view: unknown}) {
        this.id = id++;
        this.view = view;
        this.source = source;
        this.generation = null;
        this.valid = true;

        this.visible = false;
        this.proxy_for = null;
        this.proxied_as = null;
        this.proxy_level = 0;
        this.proxy_order_offset = 0;
        this.fade_in = true;
        this.loading = false;
        this.loaded = false;
        this.built = false;
        this.labeled = false;
        this.error = null;
        this.debug = {};

        this.style_z = style_z; // zoom level to be used for styling
        this.coords = TileID.normalizedCoord(coords, this.source);
        this.key = TileID.key(this.coords, this.source, this.style_z)!; // The manager validates the normalized key before constructing a tile.
        this.overzoom = Math.max(this.style_z - this.coords.z, 0); // number of levels of overzooming
        this.overzoom2 = Math.pow(2, this.overzoom);
        this.min = Geo.metersForTile(this.coords);
        this.max = Geo.metersForTile({x: this.coords.x + 1, y: this.coords.y + 1, z: this.coords.z }),
        this.span = { x: (this.max.x - this.min.x), y: -(this.max.y - this.min.y) };
        this.bounds = { sw: { x: this.min.x, y: this.max.y }, ne: { x: this.max.x, y: this.min.y } };

        this.meters_per_pixel = Geo.metersPerPixel(this.style_z);
        this.meters_per_pixel_sq = this.meters_per_pixel * this.meters_per_pixel;
        this.units_per_pixel = Geo.units_per_pixel / this.overzoom2; // adjusted for overzoom
        this.units_per_meter_overzoom = Geo.unitsPerMeter(this.coords.z) * this.overzoom2; // adjusted for overzoom
        this.preserve_tiles_within_zoom = this.source.preserve_tiles_within_zoom; // source-specific tile retention policy

        this.meshes = {}; // renderable VBO meshes keyed by style
        this.new_mesh_styles = []; // meshes that have been built so far in current build generation
        this.pending_label_meshes = null; // meshes that are pending collision (shouldn't be displayed yet)

        this.setWorker(workers);
    }

    // Free resources owned by tile
    freeResources () {
        this.discardTerrainStage();
        for (let m in this.meshes) {
            this.meshes[m].forEach(m => m.destroy());
        }
        this.meshes = {};

        if (this.pending_label_meshes) {
            for (let m in this.pending_label_meshes) {
                this.pending_label_meshes[m].forEach(m => m.destroy());
            }
        }
        this.pending_label_meshes = null;
    }

    destroy() {
        Task.removeForTile(this.id);
        this.workerMessage('self.removeTile', this.key);
        this.freeResources();
        this.worker = null;
        this.valid = false;
    }

    buildAsMessage() {
        return {
            id: this.id,
            key: this.key,
            source: this.source.name,
            coords: this.coords,
            min: this.min,
            max: this.max,
            units_per_pixel: this.units_per_pixel,
            meters_per_pixel: this.meters_per_pixel,
            meters_per_pixel_sq: this.meters_per_pixel_sq,
            units_per_meter_overzoom: this.units_per_meter_overzoom,
            style_z: this.style_z,
            overzoom: this.overzoom,
            overzoom2: this.overzoom2,
            generation: this.generation,
            debug: this.debug
        };
    }

    // Find the appropriate worker thread for this tile
    setWorker (workers: BrokerWorker[]) {
        if (this.source.tiled) {
            // Pin tile to a worker thread based on its coordinates
            this.worker_id = Math.abs(this.coords.x + this.coords.y + this.coords.z) % workers.length;
        }
        else {
            // Pin all tiles from each non-tiled source to a single worker
            // Prevents data for these sources from being loaded more than once
            this.worker_id = Number(this.source.id) % workers.length;
        }

        this.worker = workers[this.worker_id];
    }

    workerMessage (method: BrokerMethod, ...message: unknown[]) {
        return WorkerBroker.postMessage(this.worker!, method, ...message); // Calls precede destroy(), which clears the worker.
    }

    build(generation: number, { fade_in = true } = {}) {
        this.generation = generation;
        this.fade_in = fade_in;
        if (!this.loaded) {
            this.loading = true;
            this.built = false;
            this.labeled = false;
        }
        return this.workerMessage('self.buildTile', { tile: this.buildAsMessage() }).catch(e => { throw e; });
    }

    /**
        Called on worker to cancel loading
        Static method because the worker only has object representations of tile data, there is no
        tile instance created yet.
    */
    static cancel(tile: import('../sources/tile_source_state').TileDataContext & {canceled?: boolean; id?: string | number; key?: string; mesh_data?: Record<string, TileStylePayload>} | null | undefined) {
        if (tile) {
            tile.canceled = true;
            const request = getTileSourceRequest(tile);
            request.cancel?.();
            if (request.requestId) {
                Utils.cancelRequest(request.requestId); // cancel pending tile network request
                updateTileSourceRequest(tile, {requestId: null});
            }

            Tile.abortBuild(tile);
        }
    }

    // Process geometry for tile - called by web worker
    // Returns a set of tile keys that should be sent to the main thread (so that we can minimize data exchange between worker and main thread)
    static buildGeometry (tile: WorkerBuildTile, { scene_id, layers, styles, global }: {scene_id: number | string; layers: Record<string, TileBuildLayer>; styles: Record<string, TileBuildStyle>; global: unknown}) {
        let data = tile.source_data;

        tile.debug.building = +new Date();
        tile.debug.feature_count = 0;
        tile.debug.layers = null;

        Collision.startTile(tile.id, {
            apply_repeat_groups: !Object.values(styles).some(style => style.cpu_projection || style.screen_space_labels)
        });

        // Process each top-level layer
        for (let layer_name in layers) {
            let layer = layers[layer_name];
            // Skip layers with no data source defined
            if (!layer || !layer.config_data) {
                log('warn', `Layer ${layer_name} was defined without a geometry data source and will not be rendered.`);
                continue;
            }

            // Source names don't match
            if (layer.config_data.source !== tile.source) {
                continue;
            }

            // Get data for one or more layers from source
            let source_layers = Tile.getDataForSource(data, layer.config_data, layer_name);

            // Build features in layer
            for (let s=0; s < source_layers.length; s++) {
                let source_layer = source_layers[s];
                let geom = source_layer.geom;
                if (!geom) {
                    continue;
                }

                for (let f = 0; f < geom.features.length; f++) {
                    let feature = geom.features[f];
                    if (!hasFeatureGeometry(feature)) {
                        continue; // skip features w/o geometry (valid GeoJSON)
                    }

                    let context = StyleParser.getFeatureParseContext(feature, tile, global);
                    context.winding = tile.default_winding;
                    context.source = tile.source;        // add data source name
                    context.layer = source_layer.layer;  // add data source layer name

                    // Get draw groups for this feature
                    let draw_groups = layer.buildDrawGroups(context, true);
                    if (!draw_groups) {
                        continue;
                    }

                    // Build draw groups
                    for (let group_name in draw_groups) {
                        let group = draw_groups[group_name];

                        // Add to style
                        let style_name = group!.style || group_name;
                        let style = styles[style_name];

                        if (!style) {
                            log('warn', `Style '${style_name}' not found, skipping layer '${layer_name}':`, group, feature);
                            continue;
                        }

                        group = style.preprocess(group!);
                        if (group == null || group.visible === false) {
                            continue;
                        }

                        context.layers = group.layers;  // add matching draw layers

                        style.addFeature(feature, group, context);
                    }

                    tile.debug.feature_count++;
                }
            }
        }
        tile.debug.building = +new Date() - tile.debug.building;

        // Send styles back to main thread as they finish building, in two groups: collision vs. non-collision
        let tile_styles = this.stylesForTile(tile, styles).map(s => styles[s]);
            Tile.buildStyleGroups(tile, tile_styles, scene_id, style => style.collision ? 'collision' : 'non-collision');
        // Tile.buildStyleGroups(tile, tile_styles, scene_id, style => style.name); // call for each style
        // Tile.buildStyleGroups(tile, tile_styles, scene_id, style => 'styles'); // all styles in single call (previous behavior)
    }

    static stylesForTile (tile: WorkerBuildTile, styles: Record<string, TileBuildStyle>) {
        let tile_styles: string[] = [];
        for (let s in styles) {
            if (styles[s].hasDataForTile(tile)) {
                tile_styles.push(s);
            }
        }
        return tile_styles;
    }

    // Build styles (grouped by the provided function) and send back to main thread as they finish building
    static buildStyleGroups(tile: WorkerBuildTile, styles: TileBuildStyle[], scene_id: number | string, group_by: (style: TileBuildStyle) => string) {
        // Group the styles; each group will be sent to the main thread when the styles in the group finish building.
        const groups = styles.reduce<Record<string, TileBuildStyle[] | null>>((groups, style) => {
            const group = group_by(style);
            groups[group] = groups[group] || [];
            groups[group]!.push(style);
            return groups;
        }, {});

        // If nothing to build, return empty tile to main thread
        if (Object.keys(groups).length === 0) {
            WorkerBroker.postMessage(
                `TileManager_${scene_id}.buildTileStylesCompleted`,
                WorkerBroker.withTransferables({ tile: Tile.slice(tile), progress: { start: true, done: true } })
            );
            Collision.resetTile(tile.id); // clear collision if we're done with the tile
            return;
        }

        // Build each group of styles
        const progress: TileBuildProgress = {};
        for (const group_name in groups) {
            Tile.buildStyleGroup({ group_name, groups, tile, progress, scene_id });
        }
    }

    // Build a single group of styles
    static async buildStyleGroup({ group_name, groups, tile, progress, scene_id }: {group_name: string; groups: Record<string, TileBuildStyle[] | null>; tile: WorkerBuildTile; progress: TileBuildProgress; scene_id: number | string}) {
        const group = groups[group_name]!;
        const mesh_data: Record<string, TileStylePayload> = {};
        try {
            // For each group, build all styles in the group
            await Promise.all(group.map(async (style) => {
                try {
                    const style_data = await style.endData(tile);
                    if (style_data) {
                        mesh_data[style.name] = style_data;
                    }
                } catch (error) {
                    // Drain sibling styles before transferring the failed batch,
                    // including any texture references they have acquired.
                    progress.error = progress.error || ((error && (error as {stack?: string}).stack) || String(error)) as string;
                }
            }));

            // Mark the group as done, and check if all groups have finished
            log('trace', `Finished style group '${group_name}' for tile ${tile.key}`);
            groups[group_name] = null;
            if (Object.keys(groups).every(g => groups[g] == null)) {
                progress.done = true;
            }

            // Send meshes to main thread
            WorkerBroker.postMessage(
                `TileManager_${scene_id}.${progress.error ? 'buildTileError' : 'buildTileStylesCompleted'}`,
                WorkerBroker.withTransferables(progress.error ?
                    { ...Tile.slice(tile), mesh_data, error: progress.error } :
                    { tile: { ...Tile.slice(tile), mesh_data }, progress })
            );
            if (progress.done) {
                Collision.resetTile(tile.id); // clear collision if we're done with the tile
            }
        }
        catch (e) {
            log('error', `Error for style group '${group_name}' for tile ${tile.key}`, (e && (e as {stack?: string}).stack) || e);
            WorkerBroker.postMessage(`TileManager_${scene_id}.buildTileError`,
                WorkerBroker.withTransferables({ ...Tile.slice(tile), mesh_data, error: (e && (e as {stack?: string}).stack) || String(e) }));
        }
    }

    /**
        Retrieves geometry from a tile according to a data source definition
        Returns an array of objects with:
            layer: source layer name
            geom: GeoJSON FeatureCollection
    */
    static getDataForSource (source_data: WorkerBuildTile['source_data'], source_config: TileBuildLayer['config_data'], scene_layer_name: string) {
        var layers: {layer?: string; geom: {features: DecodedTileFeature[]} | undefined}[] = [];

        if (source_config != null && source_data != null && source_data.layers != null) {
            // If source wildcard is specified, combine all source layers
            if (source_config.all_layers === true) {
                // Wildcard takes precedence over explicit source layer(s)
                if (source_config.layer != null) {
                    const msg = `Layer ${scene_layer_name} includes both 'all_layers: true' and an explicit ` +
                        '\'layer\' keyword in its \'data\' block. \'all_layers: true\' takes precedence, \'layer\' ' +
                        'will be ignored.';
                    log({ level: 'warn', once: true }, msg);
                }

                for (const layer in source_data.layers) {
                    layers.push({ layer, geom: source_data.layers![layer] });
                }
            }
            // If no source layer specified, and a default data source layer exists
            else if (!source_config.layer && source_data.layers._default) {
                layers.push({
                    geom: source_data.layers._default
                });
            }
            // If no source layer is specified, and a layer for the scene layer name exists
            else if (!source_config.layer && scene_layer_name) {
                layers.push({
                    layer: scene_layer_name,
                    geom: source_data.layers[scene_layer_name]
                });
            }
            // If a source layer is specified by name, use it
            else if (typeof source_config.layer === 'string') {
                layers.push({
                    layer: source_config.layer,
                    geom: source_data.layers[source_config.layer]
                });
            }
            // If multiple source layers are specified by name, combine them
            else if (Array.isArray(source_config.layer)) {
                source_config.layer.forEach(layer => {
                    layers.push({ layer, geom: source_data.layers![layer] });
                });
            }
        }

        return layers;
    }

    /**
       Called on main thread when a web worker completes processing
       for a single tile.
    */
    /** Begin an isolated mesh generation; the existing display remains owned by this tile. */
    beginTerrainStage(): void {
        this.discardTerrainStage();
        this.terrainStage = {meshes: {}, labels: null, styles: []};
    }

    /** Release only staged replacement buffers after cancellation, removal or failure. */
    discardTerrainStage(): void {
        const stage = this.terrainStage;
        this.terrainStage = undefined;
        if (stage) for (const meshes of [stage.meshes, stage.labels ?? {}]) for (const parts of Object.values(meshes)) for (const mesh of parts) mesh.destroy();
    }

    /** Publish complete draw owners together, with one shared transition origin for every tile. */
    commitTerrainStage(time: number): void {
        const stage = this.terrainStage;
        if (!stage) return;
        this.terrainStage = undefined;
        this.freeResources();
        this.meshes = stage.meshes; this.pending_label_meshes = stage.labels; this.new_mesh_styles = stage.styles;
        if (stage.done) this.built = true;
        for (const meshes of [stage.meshes, stage.labels ?? {}]) for (const parts of Object.values(meshes)) for (const mesh of parts) mesh.terrainVisibleAt = time;
    }

    /** Upload incrementally without replacing any currently admitted terrain draw owners. */
    buildMeshes(styles: Record<string, TileBuildStyle>, progress: TileBuildProgress) {
        const stage = this.terrainStage;
        if (!stage) return this.buildMeshBatch(styles, progress);
        const meshes = this.meshes, labels = this.pending_label_meshes, previousStyles = this.new_mesh_styles;
        this.meshes = stage.meshes; this.pending_label_meshes = stage.labels; this.new_mesh_styles = stage.styles;
        this.terrainUploadOwners = [];
        try {this.buildMeshBatch(styles, progress);}
        catch (error) {
            // The rejected raw batch still owns its transferred texture references.
            // Release new buffers here; TileManager aborts those references exactly once.
            for (const mesh of this.terrainUploadOwners) {mesh.textures = undefined; mesh.destroy();}
            throw error;
        }
        finally {
            this.terrainUploadOwners = undefined;
            stage.meshes = this.meshes; stage.labels = this.pending_label_meshes; stage.styles = this.new_mesh_styles;
            this.meshes = meshes; this.pending_label_meshes = labels; this.new_mesh_styles = previousStyles;
        }
    }

    buildMeshBatch(styles: Record<string, TileBuildStyle>, progress: TileBuildProgress) {
        if (this.error) {
            return;
        }

        this.build_id = build_id++; // record order in which tile was built

        // Debug
        if (progress.start) {
            this.debug.geometry_count = 0;
            this.debug.buffer_size = 0;
        }

        // Create VBOs
        let meshes: Record<string, VBOMesh[]> = {}; // new data to be added to tile
        let mesh_data = this.mesh_data;
        if (mesh_data) {
            for (let s in mesh_data) {
                for (let variant in mesh_data[s].meshes) {
                    let mesh_variant = mesh_data[s].meshes[variant];
                    if (mesh_variant.vertex_data) {
                        if (!styles[s]) {
                            log('warn', `Could not create mesh because style '${s}' not found, for tile ${this.key}, aborting tile`);
                            break;
                        }

                        // first add style-level uniforms, then add any mesh-specific ones
                        let mesh_options = Object.assign({}, mesh_data[s]);
                        mesh_options.uniforms = Object.assign({}, mesh_options.uniforms, mesh_variant.uniforms);
                        mesh_options.variant = mesh_variant.variant;
                        mesh_options.tileZoom = this.coords.z;

                        // for labels, keep buffer data on CPU so they can be modified later
                        if (mesh_variant.labels) {
                            mesh_options.retain = true;
                        }

                        let mesh = styles[s].makeMesh(mesh_variant.vertex_data, mesh_variant.vertex_elements, mesh_options);
                        this.terrainUploadOwners?.push(mesh);
                        mesh.variant = mesh_options.variant;
                        mesh.labels = mesh_variant.labels;
                        mesh.terrainQueryMesh = mesh_variant.terrain_surface;
                        meshes[s] = meshes[s] || [];
                        meshes[s].push(mesh);
                        if (mesh.variant.mesh_order == null) {
                            mesh.variant.mesh_order = meshes[s].length - 1; // assign default variant render order
                        }

                        this.debug.buffer_size! += mesh.buffer_size;
                        this.debug.geometry_count! += mesh.geometry_count;
                    }
                }

                // Sort mesh variants by explicit render order (if present)
                if (meshes[s]) {
                    meshes[s].sort((a, b) => {
                        // Sort variant order ascending if present, then all null values (where order is unspecified)
                        let ao = a.variant.mesh_order, bo = b.variant.mesh_order;
                        return (ao == null ? 1 : (bo == null ? -1 : (ao < bo ? -1 : 1)));
                    });
                }
            }
        }
        delete this.mesh_data;

        // New meshes
        for (let m in meshes) {
            // swap in non-collision meshes right away
            if (!styles[m].collision) {
                if (this.meshes[m]) {
                    this.meshes[m].forEach(m => m.destroy()); // free old meshes
                }

                this.meshes[m] = meshes[m]; // set new mesh
                this.new_mesh_styles.push(m);
            }
            // keep label meshes out of view until collision is complete
            else {
                this.pending_label_meshes = this.pending_label_meshes || {};
                this.pending_label_meshes[m] = meshes[m];
            }
        }

        if (progress.done) {
            // Release un-replaced meshes (existing in previous generation, but weren't built for this one)
            for (let m in this.meshes) {
                if (this.new_mesh_styles.indexOf(m) === -1 && (!this.pending_label_meshes || this.pending_label_meshes[m] == null)) {
                    this.meshes[m].forEach(m => m.destroy());
                    delete this.meshes[m];
                }
            }
            this.new_mesh_styles = [];

            this.debug.geometry_ratio = (this.debug.geometry_count! / this.debug.feature_count!).toFixed(1);
        }
        this.printDebug(progress);
    }

    // How many styles are currently pending label collision
    pendingLabelStyleCount () {
        return this.pending_label_meshes ? Object.keys(this.pending_label_meshes).length : 0;
    }

    // Swap label style meshes after collision is complete
    swapPendingLabels () {
        this.labeled = true; // mark as labeled

        if (this.pending_label_meshes) {
            for (let m in this.pending_label_meshes) {
                if (this.meshes[m]) {
                    this.meshes[m].forEach(m => m.destroy()); // free old meshes
                }

                this.meshes[m] = this.pending_label_meshes[m]; // set new mesh
            }
            this.pending_label_meshes = null;
        }
    }

    /**
        Called on main thread when web worker completes processing, but tile has since been discarded
        Frees resources that would have been transferred to the tile object.
        Static method because the tile object no longer exists (the tile data returned by the worker is passed instead).
    */
    static abortBuild (tile: {id?: string | number; key?: string; mesh_data?: Record<string, TileStylePayload>}) {
        Task.removeForTile(tile.id);
        Collision.abortTile(tile.id);

        // Releases meshes
        if (tile.mesh_data) {
            for (let s in tile.mesh_data) {
                let textures = tile.mesh_data[s].textures;
                if (textures) {
                    textures.forEach(t => {
                        let texture = Texture.textures[t];
                        if (texture) {
                            log('trace', `releasing texture ${t} for tile ${tile.key}`);
                            Texture.release(t); // Worker metadata never owns a GPU release method.
                        }
                    });
                }
            }
        }
    }

    // Set as a proxy tile for another tile
    setProxyFor (tile?: Tile | null) {
        if (tile) {
            this.visible = true;
            this.proxy_for = this.proxy_for || [];
            this.proxy_for.push(tile);
            this.proxy_order_offset = 1; // draw proxies a half-layer back (order is scaled 2x to avoid integer truncation)
            tile.proxied_as = (tile.style_z > this.style_z ? 'child' : 'parent');
            this.proxy_level = Math.abs(tile.style_z - this.style_z); // # of zoom levels proxy is above/below target tile
        }
        else {
            this.proxy_for = null;
            this.proxy_order_offset = 0;
            this.proxy_level = 0;
        }
    }

    isProxy () {
        return this.proxy_for != null;
    }

    // Proxy tiles only need to render a specific style if any of the tiles they are proxying *for*
    // haven't finished loading that style yet. If all proxied tiles *have* data for that style, then it's
    // safe to hide the proxy tile's version.
    shouldProxyForStyle (style: string) {
        return !this.proxy_for || this.proxy_for.some(t => t.meshes[style] == null);
    }

    // Update model matrix and tile uniforms
    setupProgram ({ model, model32 }: {model: Float64Array; model32: Float32Array}, program: {uniform(type: string, name: string, value: number | boolean | number[] | Float32Array): unknown}, uniform_buffer?: UniformBuffer) {
        // Model - transform tile space into world space (meters, absolute mercator position)
        this.matrix4.identity().translate([this.min.x, this.min.y, 0])
            .scale([this.span.x / Geo.tile_scale, this.span.y / Geo.tile_scale, 1])
            .toArray(model);
        model32.set(model);
        const tile_fade_in = this.fade_in && this.proxied_as !== 'child';

        if (uniform_buffer) {
            uniform_buffer.setUniforms({
                u_tile_origin: [this.min.x, this.min.y, this.style_z, this.coords.z],
                u_tile_proxy_order_offset: this.proxy_order_offset,
                u_model: model32,
                u_tile_fade_in: tile_fade_in
            });
        }
        else {
            program.uniform('4fv', 'u_tile_origin', [this.min.x, this.min.y, this.style_z, this.coords.z]);
            program.uniform('1f', 'u_tile_proxy_order_offset', this.proxy_order_offset);
            program.uniform('Matrix4fv', 'u_model', model32);

            // Fade in labels according to proxy status, avoiding "flickering" where
            // labels quickly go from invisible back to visible
            program.uniform('1i', 'u_tile_fade_in', tile_fade_in);
        }
    }

    // Slice a subset of keys out of a tile
    // Includes a minimum set of pre-defined keys for load state, debug. etc.
    // We use this to send a subset of the tile back to the main thread, to minimize unnecessary data transfer
    // (e.g. very large items like feature geometry are not needed on the main thread)
    static slice(tile: Tile, keys?: string[]): Pick<Tile, 'id' | 'key' | 'loading' | 'loaded' | 'generation' | 'error' | 'debug'> & Record<string, unknown>;
    static slice(tile: Pick<WorkerBuildTile, 'id' | 'key' | 'loading' | 'loaded' | 'generation' | 'error' | 'debug'>, keys?: string[]): Pick<WorkerBuildTile, 'id' | 'key' | 'loading' | 'loaded' | 'generation' | 'error' | 'debug'> & Record<string, unknown>;
    static slice (tile: Pick<WorkerBuildTile, 'id' | 'key' | 'loading' | 'loaded' | 'generation' | 'error' | 'debug'> | Tile, keys?: string[]) {
        let keep = [
            'id',
            'key',
            'loading',
            'loaded',
            'generation',
            'error',
            'debug'
        ];
        if (Array.isArray(keys)) {
            keep.push(...keys);
        }

        // Build the tile subset
        var tile_subset = {id: tile.id, key: tile.key, loading: tile.loading, loaded: tile.loaded,
            generation: tile.generation, error: tile.error, debug: tile.debug};
        for (let k=0; k < keep.length; k++) {
            const key = keep[k];
            Reflect.set(tile_subset, key, Reflect.get(tile, key)); // Optional extension keys remain wire-envelope properties.
        }

        return tile_subset;
    }

    merge (other: Pick<WorkerBuildTile, 'mesh_data' | 'debug'> & {loading: boolean; loaded: boolean; generation: number | null; error: string | null}) {
        this.loading = other.loading;
        this.loaded = other.loaded;
        this.generation = other.generation;
        this.error = other.error;
        this.mesh_data = other.mesh_data;
        this.debug = mergeObjects(this.debug, other.debug);
        return this;
    }

    printDebug (progress: TileBuildProgress) {
        const exclude = ['layers'];
        let copy: Record<string, unknown> = {};
        for (let key in this.debug) {
            if (exclude.indexOf(key) === -1) {
                copy[key] = this.debug[key];
            }
        }

        log('debug', `Tile ${progress.done ? '(done)' : ''}: debug for ${this.key}: [  ${JSON.stringify(copy)} ]`);
    }

}

Tile.coord_children = {}; // only allocate children coordinates once per coordinate

/** Preserve the legacy null-geometry guard while narrowing decoded GeoJSON for style evaluation. */
function hasFeatureGeometry(feature: DecodedTileFeature): feature is StyleFeature {
    return feature.geometry != null;
}

// Sum up layer feature/geometry stats from a set of tiles
export function debugSumLayerStats(tiles: readonly Pick<Tile, 'debug'>[]) {
    let list: Record<string, LayerDebugCounts> = {}, tree: Record<string, LayerDebugCounts> = {};

    tiles.filter(tile => tile.debug.layers).forEach(tile => {
        // layer list
        Object.keys(tile.debug.layers!.list).forEach(layer => {
            let counts = tile.debug.layers!.list[layer];
            addLayerDebugEntry(list, layer, counts.features, counts.geoms, counts.styles, counts.base);
        });

        // layer tree
        addDebugLayers(tile.debug.layers!.tree, tree);
    });

    return { list, tree };
}

// build debug stats layer tree
function addDebugLayers (node: Record<string, LayerDebugCounts>, tree: Record<string, LayerDebugCounts>) {
    for (let layer in node) {
        let counts = node[layer];
        addLayerDebugEntry(tree, layer, counts.features, counts.geoms, counts.styles, counts.base);
        if (counts.layers) {
            tree[layer].layers = tree[layer].layers || {};
            addDebugLayers(counts.layers, tree[layer].layers); // process child layers
        }
    }
}
