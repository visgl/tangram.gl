// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors


/*jshint worker: true*/

import Utils from '../utils/utils';
import {compileFunctionStrings, functionStringCache, clearFunctionStringCache} from '../utils/functions';
import debugSettings, {mergeDebugSettings} from '../utils/debug_settings';
import log from '../utils/log';
import mergeObjects from '../utils/merge';
import WorkerBroker from '../utils/worker_broker'; // jshint ignore:line
import Tile from '../tile/tile';
import Geo from '../utils/geo';
import DataSource from '../sources/data_source';
import {iterateSourceTiles} from '../sources/tile_source_adapter';
import SharedTileSourceAdapter from '../sources/shared_tile_source_adapter';
import {getFeatureRenderedGeneration} from '../styles/feature_annotations';
import {registerMvtDecoder} from '../procedures/mvt-parser';
import {registerMvtTileProvider} from '../procedures/mvt-tile-provider';
import type {TangramTileSourceMetadata} from '../sources/tile_source_metadata';
import '../sources/sources';
import FeatureSelection from '../selection/selection';
import StyleParser from '../styles/style_parser';
import {StyleManager} from '../styles/style_manager';
import {parseLayers, FilterOptions, layerCache} from '../styles/layer';
import {buildFilter} from '../styles/filter';
import Texture from '../gl/texture';
import VertexElements from '../gl/vertex_elements';
import Label from '../labels/label';
import type {WorkerBuildTile, TileBuildStyle} from '../tile/tile-build-types';
import type {DecodedTileFeature} from '../tile/tile-build-types';
import type {LayerTree} from '../styles/layer';
import type {StyleDefinition} from '../styles/style-mixing-types';
import type {SceneSourceDefinition} from './scene-resource-types';
import type {LogLevel} from '../utils/log';
import type {TerrainDrapingSnapshot} from '../procedures/terrain-draping';
import type {DebugSettings} from '../utils/debug_settings';

/** Configuration serialized by Scene after global/resource normalization. */
interface WorkerSceneConfiguration extends Record<string, unknown> {
    global: Record<string, unknown>;
    sources: Record<string, SceneSourceDefinition>;
    styles: Record<string, StyleDefinition & import('./scene-resource-types').SceneStyleDefinition>;
    layers: Record<string, import('../styles/layer-types').SceneLayerDefinition>;
    textures?: Record<string, import('./scene-resource-types').SceneResourceDefinition>;
}
/** Worker-local ownership installed by init and updateConfig before builds are dispatched. */
interface WorkerSceneState {
    scene_id: number;
    _worker_id: number;
    num_workers: number;
    generation: number;
    introspection: boolean;
    global: Record<string, unknown>;
    sources: Record<string, DataSource>;
    styles: Record<string, import('../styles/style-mixing-types').ManagedStyle>;
    layers: Record<string, LayerTree>;
    tiles: Record<string, WorkerBuildTile>;
    style_manager: StyleManager;
    sharedTileSources: SharedTileSourceAdapter<WorkerBuildTile>;
    last_config_sources: Record<string, SceneSourceDefinition>;
    config_sources: Record<string, SceneSourceDefinition>;
    syncing_textures: Promise<unknown>;
    configuring: Promise<void>;
    finalizeTileSources(): void;
    importExternalScripts(scripts: string[]): void;
    createDataSources(config: Pick<WorkerSceneConfiguration, 'sources'>): void;
    syncTextures(textures?: Record<string, unknown>): Promise<unknown>;
    getTile(key: string): WorkerBuildTile | undefined;
    awaitConfiguration(): Promise<void>;
    loadTileSourceData(tile: WorkerBuildTile): Promise<unknown>;
    removeTile(key: string): void;
}

/** Match the geometry builder's null-geometry admission before evaluating worker queries. */
function hasQueryGeometry(feature: DecodedTileFeature): feature is DecodedTileFeature & {geometry: NonNullable<DecodedTileFeature['geometry']>} {
    return feature.geometry !== null;
}

import {registerMeshProjector, clearMeshProjectorPreparation, getMeshProjectorPreparationStatistics,
    getMeshProjectorWorkStatistics} from '../procedures/mesh-projector';

/** Bootstrap retains the original own-property shape; init installs the declared lazy state. */
class WorkerSceneState {
    declare scene_id: number;
    declare _worker_id: number;
    declare num_workers: number;
    declare generation: number;
    declare introspection: boolean;
    declare global: Record<string, unknown>;
    declare style_manager: StyleManager;
    declare last_config_sources: Record<string, SceneSourceDefinition>;
    declare config_sources: Record<string, SceneSourceDefinition>;
    declare syncing_textures: Promise<unknown>;
    declare configuring: Promise<void>;
    sources: WorkerSceneState['sources'] = {};
    styles: WorkerSceneState['styles'] = {};
    layers: WorkerSceneState['layers'] = {};
    tiles: WorkerSceneState['tiles'] = {};
    sharedTileSources = new SharedTileSourceAdapter<WorkerBuildTile>();
}

const SceneWorker = Object.assign(self, new WorkerSceneState(), {

    FeatureSelection,
    registerMvtDecoder,
    registerMvtTileProvider,
    registerMeshProjector,


    // Initialize worker
    init (this: WorkerSceneState, scene_id: number, worker_id: number, num_workers: number, log_level: LogLevel, device_pixel_ratio: number, has_element_index_unit: boolean, external_scripts: string[], maxConcurrentLoads?: number): number {
        const sharedTileSources = new SharedTileSourceAdapter<WorkerBuildTile>(external_scripts.length === 0, {maxConcurrentLoads});
        this.finalizeTileSources();
        this.sharedTileSources = sharedTileSources;
        this.scene_id = scene_id;
        this._worker_id = worker_id;
        this.num_workers = num_workers;
        log.setLevel(log_level);
        Utils.device_pixel_ratio = device_pixel_ratio;
        VertexElements.setElementIndexUint(has_element_index_unit);
        FeatureSelection.setPrefix(this._worker_id);
        this.style_manager = new StyleManager();
        this.importExternalScripts(external_scripts);
        Label.id_prefix = worker_id;
        Label.id_multiplier = num_workers;
        return worker_id;
    },

    // Import custom external scripts
    importExternalScripts(this: WorkerSceneState, scripts: string[]) {
        if (scripts.length === 0) {
            return;
        }
        log('debug', 'loading custom data source scripts in worker:', scripts);

        // `window` is already shimmed to allow compatibility with some other libraries (e.g. FontFaceObserver)
        // So there's an extra dance here to look for any additional `window` properties added by these script imports,
        // then add them to the worker `self` scope.
        let prev_names = Object.getOwnPropertyNames(window);

        importScripts(...scripts);

        Object.getOwnPropertyNames(window).forEach(prop => {
            if (prev_names.indexOf(prop) === -1) {
                Reflect.set(this, prop, Reflect.get(window, prop)); // new property added to window, also add it to self
            }
        });
    },

    // Starts a config refresh
    updateConfig (this: WorkerSceneState, { config: serializedConfig, generation, introspection, shader_language = 'glsl', projection_target, terrain }: {
        config: string; generation: number; introspection: boolean; shader_language?: 'glsl' | 'wgsl'; projection_target?: string; terrain?: TerrainDrapingSnapshot;
    }, debug: Partial<DebugSettings>) {
        // This is the scene-owned broker envelope, not a provider data parser.
        const config = JSON.parse(serializedConfig) as WorkerSceneConfiguration;
        mergeDebugSettings(debug);

        this.generation = generation;
        this.introspection = introspection;

        // Expand global properties
        this.global = compileFunctionStrings(config.global);

        // Create data sources
        this.createDataSources(config);

        // Expand styles
        config.styles = compileFunctionStrings(config.styles, StyleParser.wrapFunction);
        this.styles = this.style_manager.build(config.styles);
        this.style_manager.initStyles({
            generation: this.generation,
            styles: this.styles,
            sources: this.sources,
            introspection: this.introspection,
            shader_language,
            projection_target,
            terrain,
            config
        });

        // Parse each top-level layer as a separate tree
        this.layers = parseLayers(config.layers, this.style_manager.styles);

        // Sync tetxure info from main thread
        this.syncing_textures = this.syncTextures(config.textures);

        // Return promise for when config refresh finishes
        this.configuring = this.syncing_textures.then(() => {
            log('debug', 'updated config');
        });

        return this.configuring;
    },

    // Create data sources and clear tile cache if necessary
    createDataSources (this: WorkerSceneState, config: Pick<WorkerSceneConfiguration, 'sources'>) {
        // Save and compare previous sources
        this.last_config_sources = this.config_sources || {};
        this.config_sources = mergeObjects({}, config.sources); // deep copy the serialized config for the later existence comparison
        let last_sources = this.sources;
        let changed: string[] = [];

        // Parse new sources
        this.sources = {}; // clear previous sources
        for (let name in config.sources) {
            if (JSON.stringify(this.last_config_sources[name]) === JSON.stringify(config.sources[name])) {
                this.sources[name] = last_sources[name];
                continue;
            }

            // compile any user-defined JS functions
            config.sources[name] = compileFunctionStrings(config.sources[name]);

            let source;
            try {
                source = DataSource.create(Object.assign({}, config.sources[name], {name}), this.sources);
            }
            catch(e) {
                continue;
            }

            if (!source) {
                continue;
            }
            this.sources[name] = source;
            changed.push(name);
        }

        // Removed or failed replacement sources must release old requests as well.
        for (const name in last_sources) {
            if (this.sources[name] !== last_sources[name]) {
                this.sharedTileSources.invalidateSource(last_sources[name]);
                if (changed.indexOf(name) === -1) changed.push(name);
            }
        }
        // Release source leases, selection entries, and build ownership together.
        changed.forEach(source => {
            for (let t in this.tiles) {
                if (this.tiles[t].source === source) {
                    this.removeTile(t);
                }
            }
        });
        for (const name in last_sources) {
            if (this.sources[name] !== last_sources[name]) last_sources[name].dispose?.();
        }
    },

    // Returns a promise that fulfills when config refresh is finished
    awaitConfiguration (this: WorkerSceneState): Promise<void> {
        return this.configuring;
    },

    // Build a tile: load from tile source if building for first time, otherwise rebuild with existing data
    buildTile (this: WorkerSceneState, { tile }: {tile: WorkerBuildTile}): Promise<void> | undefined {
        // Tile cached?
        const cachedTile = this.getTile(tile.key);
        if (cachedTile != null) {
            // Already loading?
            if (cachedTile.loading === true) {
                return;
            }
        }

        // Update tile cache
        tile = this.tiles[tile.key] = Object.assign(this.getTile(tile.key) || {}, tile);

        // Update config (styles, etc.), then build tile
        return this.awaitConfiguration().then(() => {
            // First time building the tile
            if (tile.loaded !== true) {

                tile.loading = true;
                tile.loaded = false;
                tile.error = null;

                this.loadTileSourceData(tile).then(() => {
                    if (this.getTile(tile.key) !== tile) {
                        log('trace', `stop tile build after data source load because tile was removed: ${tile.key}`);
                        return;
                    }

                    // Warn and continue on data source error
                    if (tile.source_data?.error) {
                        log('warn', `tile load error(s) for ${tile.key}: ${tile.source_data.error}`);
                    }

                    tile.loading = false;
                    tile.loaded = true;
                    Tile.buildGeometry(tile, this);
                }).catch((error) => {
                    if (this.getTile(tile.key) !== tile) return;
                    tile.loading = false;
                    tile.loaded = false;
                    tile.error = error.stack;
                    log('error', `tile load error for ${tile.key}: ${tile.error}`);

                    // Send error to main thread
                    WorkerBroker.postMessage(`TileManager_${this.scene_id}.buildTileError`, Tile.slice(tile));
                });
            }
            // Tile already loaded, just rebuild
            else {
                log('trace', `used worker cache for tile ${tile.key}`);

                // Build geometry
                try {
                    Tile.buildGeometry(tile, this);
                }
                catch(error) {
                    // Send error to main thread
                    tile.error = String(error);
                    WorkerBroker.postMessage(`TileManager_${this.scene_id}.buildTileError`, Tile.slice(tile));
                }
            }
        });
    },

    // Load this tile's data source, or copy from an existing tile's data
    loadTileSourceData (this: WorkerSceneState, tile: WorkerBuildTile) {
        return this.sharedTileSources.loadTile(tile, this.sources[tile.source], () => iterateSourceTiles(this.tiles));
    },

    /** Internal diagnostics distinguish decoded acquisition from styled mesh/build residency. */
    getTileSourceStatistics(this: WorkerSceneState) {
        const projectionPreparation = getMeshProjectorPreparationStatistics();
        const projectionWork = getMeshProjectorWorkStatistics();
        return {...this.sharedTileSources.store.getStatistics(), sharingEnabled: this.sharedTileSources.sharingEnabled,
            ...(projectionPreparation ? {projectionPreparation} : {}), ...(projectionWork ? {projectionWork} : {})};
    },

    /** Return current source capabilities; external provider factories are registered only in workers. */
    async getSourceMetadata(this: WorkerSceneState, names: readonly string[], generation: number = this.generation): Promise<Record<string, TangramTileSourceMetadata>> {
        await this.awaitConfiguration();
        if (generation !== this.generation) throw new Error('Worker configuration changed during metadata loading');
        const sources = names.map((name): [string, DataSource] => [name, this.sources[name]]);
        return Object.fromEntries(await Promise.all(sources.map(async ([name, source]) => {
            if (!source) throw new Error(`Source '${name}' is unavailable in this worker`);
            const metadata = await source.getMetadata();
            if (this.sources[name] !== source) throw new Error(`Source '${name}' changed during metadata loading`);
            if (generation !== this.generation) throw new Error('Worker configuration changed during metadata loading');
            return [name, metadata];
        })));
    },

    /** Explicit cleanup for worker reset; native worker termination also releases its isolated heap. */
    finalizeTileSources(this: WorkerSceneState) {
        clearMeshProjectorPreparation();
        for (const key in this.tiles) this.removeTile(key);
        this.sharedTileSources.finalize();
        for (const source of Object.values(this.sources)) source.dispose?.();
        this.sources = {};
        this.config_sources = {};
        this.last_config_sources = {};
    },

    getTile(this: WorkerSceneState, key: string): WorkerBuildTile | undefined {
        return this.tiles[key];
    },

    // Remove tile
    removeTile (this: WorkerSceneState, key: string) {
        var tile = this.tiles[key];

        if (tile != null) {
            this.sharedTileSources.releaseTile(tile);
            // Cancel if loading
            if (tile.loading === true) {
                log('trace', `cancel tile load for ${key}`);
                tile.loading = false;
                Tile.cancel(tile);
            }

            // Remove from cache
            FeatureSelection.clearTile(key);
            delete this.tiles[key];
            log('trace', `remove tile from cache for ${key}`);
        }
    },

    // Query features within visible tiles, with optional filter conditions
    queryFeatures (this: WorkerSceneState, { filter, visible, geometry, tile_keys }: {filter?: unknown; visible?: boolean; geometry?: boolean; tile_keys: string[]}) {
        let features: {type?: string; id?: string | number; properties: Record<string, unknown>; geometry?: import('../utils/geo').Geometry | null}[] = [];
        let tiles = tile_keys
            .map(t => this.tiles[t])
            .filter(t => t && t.loaded);

        // Compile feature filter
        if (filter != null) {
            filter = typeof filter === 'string' && ['{', '['].indexOf(filter[0]) > -1 ? JSON.parse(filter) : filter; // de-serialize if looks like an object
            filter = compileFunctionStrings(filter, StyleParser.wrapFunction);
        }
        const compiledFilter = buildFilter(filter, FilterOptions);

        tiles.forEach(tile => {
            const layers = tile.source_data?.layers;
            for (let layer in layers) {
                let data = layers[layer];

                if (data == null) {
                    return;
                }

                data.features.forEach(feature => {
                    if (!hasQueryGeometry(feature)) return;
                    // Optionally check if feature is visible (e.g. was rendered for current generation)
                    const feature_visible = (getFeatureRenderedGeneration(feature) === this.generation);
                    if ((visible === true && !feature_visible) ||
                        (visible === false && feature_visible)) {
                        return;
                    }

                    // Apply feature filter
                    let context = StyleParser.getFeatureParseContext(feature, tile, this.global);
                    context.source = tile.source;  // add data source name
                    context.layer = layer;         // add data source layer name
                    context.id = feature.id;       // add feature id

                    if (!compiledFilter(context)) {
                        return;
                    }

                    // Info to return with each feature
                    let subset: (typeof features)[number] = {
                        type: feature.type,
                        id: feature.id,
                        properties: Object.assign({}, feature.properties, {
                            $source: context.source,
                            $layer: context.layer,
                            $geometry: context.geometry,
                            $visible: feature_visible
                        })
                    };

                    // Optionally include geometry in response
                    if (geometry === true) {
                        // Transform back to lat lng (copy geometry to avoid local modification)
                        subset.geometry = Geo.copyGeometry(feature.geometry);
                        if (subset.geometry) Geo.tileSpaceToLatlng(subset.geometry, tile.coords.z, tile.min);
                    }

                    features.push(subset);
                });
            }
        });
        return features;
    },

    // Get a feature from the selection map
    getFeatureSelection ({ id, key }: {id?: number; key?: number} = {}) {
        var selection = key === undefined ? undefined : FeatureSelection.map[key];

        return {
            id: id,
            feature: (selection && selection.feature)
        };
    },

    // Resets the feature selection state
    resetFeatureSelection (sources: string[] | null = null) {
        FeatureSelection.reset(sources);
    },

    // Selection map size for this worker
    getFeatureSelectionMapSize () {
        return FeatureSelection.getMapSize();
    },

    // Texture info needs to be synced from main thread, e.g. width/height, which we only know after the texture loads
    syncTextures (tex_config?: Record<string, unknown>) {
        let textures = [];
        if (tex_config) {
            textures.push(...Object.keys(tex_config));
        }

        log('trace', 'sync textures to worker:', textures);
        if (textures.length > 0) {
            return Texture.syncTexturesToWorker(textures);
        }
        return Promise.resolve();
    },

    // Sync device pixel ratio from main thread
    updateDevicePixelRatio (device_pixel_ratio: number) {
        Utils.device_pixel_ratio = device_pixel_ratio;
    },

    clearFunctionStringCache () {
        clearFunctionStringCache();
    },

    // Profiling helpers
    profile (this: WorkerSceneState, name: string) {
        console.profile(`worker ${this._worker_id}: ${name}`); // eslint-disable-line no-console
    },

    profileEnd (this: WorkerSceneState, name: string) {
        console.profileEnd(`worker ${this._worker_id}: ${name}`); // eslint-disable-line no-console
    },

    debug: {
        debugSettings,
        layerCache,
        functionStringCache
    }

});

WorkerBroker.addTarget('self', SceneWorker);

export default SceneWorker;
