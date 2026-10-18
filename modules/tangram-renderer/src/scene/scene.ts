// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors


import log from '../utils/log';
import Utils from '../utils/utils';
import debugSettings from '../utils/debug_settings';
import * as URLs from '../utils/urls';
import WorkerBroker from '../utils/worker_broker';
import Task from '../utils/task';
import subscribeMixin from '../utils/subscribe';
import sliceObject from '../utils/slice';
import Context from '../gl/context';
import Texture from '../gl/texture';
import ShaderProgram from '../gl/shader_program';
import UniformBuffer from '../gl/uniform_buffer';
import VertexArrayObject from '../gl/vao';
import {StyleManager} from '../styles/style_manager';
import {Style} from '../styles/style';
import StyleParser from '../styles/style_parser';
import SceneLoader from './scene_loader';
import View from './view';
import Light from '../lights/light';
import {normalizeSceneLights} from '../lights/light-definitions';
import {PORTABLE_LIGHT_UNIFORMS, getPortableLightUniforms} from '../lights/lighting-uniforms';
import TileManager from '../tile/tile_manager';
import {isGlobeFallbackStyle} from '../tile/globe_tile_preload';
import DataSource from '../sources/data_source';
import '../sources/sources';
import FeatureSelection from '../selection/selection';
import RenderStateManager from '../gl/render_state';
import TextCanvas from '../styles/text/text_canvas';
import FontManager from '../styles/text/font_manager';
import MediaCapture from '../utils/media_capture';
import setupSceneDebug from './scene_debug';
import {getWorkerURL} from './worker_url';
import type {ViewScene} from './view';
import type {ViewOptions} from './view';
import type {SubscriptionMethods} from '../utils/subscribe';
import type {RendererOptions} from '../types';
import type {TangramGPUSceneOptions} from '../gpu/tangram_gpu_backend';
import type {UniformBufferOptions} from '../gl/uniform_buffer';
import type {SceneBundle} from './scene_bundle';
import type {FinalizedSceneDefinition, SceneTextureNodes} from './scene-resource-types';
import type {LogLevel} from '../utils/log';
import type {Device, RenderPipelineParameters} from '@luma.gl/core';

/** Scene-owned compatibility options, independent of authored scene configuration. */
export interface SceneOptions extends RendererOptions, ViewOptions, Partial<TangramGPUSceneOptions> {
    /** Optional parent for a scene-owned classic canvas. */
    container?: HTMLElement;
    /** Callback before each owned-loop update. */
    preUpdate?: () => void;
    /** Callback after each owned-loop update. */
    postUpdate?: () => void;
    /** Leave frame scheduling to the host. */
    disableRenderLoop?: boolean;
    /** Retain the classic vertex-binding compatibility path. */
    disableVertexArrayObjects?: boolean;
    /** Attributes for a newly allocated classic context. */
    webGLContextOptions?: WebGLContextAttributes;
    /** Caller-owned classic context; never destroyed by this scene. */
    webGLContext?: WebGLRenderingContext;
    /** Host state guard around classic GL operations. */
    webGLContextScope?: <Result>(callback: () => Result) => Result;
    /** Logging threshold applied during scene construction. */
    logLevel?: LogLevel;
}
/** Normalized scene registries after URL and global resolution; custom values remain unknown. */
type SceneRuntimeConfiguration = FinalizedSceneDefinition & {
    sources: Record<string, import('./scene-resource-types').SceneSourceDefinition>;
    textures: Record<string, import('../gl/texture').TextureOptions>;
    cameras: NonNullable<NonNullable<ViewScene['config']>['cameras']>;
    styles: Record<string, import('../styles/style-mixing-types').StyleDefinition>;
    lights: Record<string, import('../lights/light').LightConfig>;
    layers: Record<string, {enabled?: boolean; data?: {source: string; layer?: unknown}; [name: string]: unknown}>;
    scene: {animated?: boolean; cpu_projection?: unknown; lighting?: unknown; scripts?: Record<string, string> | string[]; background?: {color?: unknown}; [name: string]: unknown};
}
/** Rebuild policy captured when a concurrent request is queued. */
interface RebuildOptions {
    initial?: boolean;
    new_generation?: boolean;
    sources?: string[] | null;
    serialize_funcs?: boolean;
    profile?: boolean;
    fade_in?: boolean;
    preserveTileCache?: boolean;
    preserveTime?: boolean;
}
/** Promise ownership for the active generation and its queued replacement. */
interface SceneBuildState {
    resolve(value: boolean | void): void;
    reject(error: unknown): void;
    initial: boolean;
    error?: Error;
    queued?: {resolve(value: void | boolean): void; reject(error: unknown): void; options: RebuildOptions};
}
import type {SceneListeners, SceneDefinition, SceneLoadOptions, TileSourceStatistics, FeatureSelectionResult} from '../types';
import {validateConcurrentTileLoads} from '../sources/decoded_tile_store';
import type {RenderPass} from '@luma.gl/core';
import type {TangramTileSourceMetadata} from '../sources/tile_source_metadata';
import {normalizeTerrainDraping} from '../procedures/terrain-draping';
import {HostProjectionEngineAdapter, validateProjectionEngine} from '../procedures/projected-coordinate-transform';
import {normalizeProjectionExecutionOptions} from '../procedures/projection-batch-executor';

// Load scene definition: pass an object directly, or a URL as string to load remotely
export default class Scene {
    /** Next scene identity used by broker targets. */
    declare static id: number;
    /** Next globally unique style/source generation. */
    declare static generation: number;
    /** Active initialization promise, cleared after settling. */
    declare initializing: Promise<void> | null;
    /** Requested worker-pool size. */
    declare num_workers: number;
    /** Optional caller-supplied worker bundle URL. */
    declare worker_url: string | undefined;
    /** Authored URL or object retained for reloads. */
    declare config_source: SceneDefinition | null;
    /** Root resolver for normalized scene resource paths. */
    declare config_bundle: SceneBundle | null;
    /** Most recent successfully loaded authored input. */
    declare last_valid_config_source: SceneDefinition | null;
    /** Reload options belonging to the last valid input. */
    declare last_valid_options: SceneLoadOptions | undefined;
    /** Compatibility reload state retained after a failed load. */
    declare last_valid_base_path: SceneLoadOptions | undefined;
    /** Active geometry generation and its optional queued replacement. */
    declare building: SceneBuildState | null;
    /** Whether this scene owns an automatic animation loop. */
    declare render_loop: boolean;
    /** Whether the owned animation loop has been started. */
    declare render_loop_active: boolean;
    /** Deferred stop request consumed by the animation loop. */
    declare render_loop_stop: boolean;
    /** Number of submitted render passes. */
    declare render_count: number;
    /** Previous frame's count used to detect redraw changes. */
    declare last_render_count: number;
    /** Whether this frame changed the submitted geometry count. */
    declare render_count_changed: boolean;
    /** Monotonic scene frame counter. */
    declare frame: number;
    /** Last frame with a completed color render. */
    declare last_main_render: number;
    /** Screenshot/video task owner shared by render callbacks. */
    declare media_capture: MediaCapture;
    /** Most recently fetched worker selection-map size. */
    declare selection_feature_count: number;
    /** Shared in-flight selection-map count request. */
    declare fetching_selection_map: Promise<number> | null;
    /** Previous scene's texture names awaiting ownership release. */
    declare prev_textures: string[] | null;
    /** Whether all eligible features receive selection IDs. */
    declare introspection: boolean;
    /** Lifecycle timestamps used by loading diagnostics. */
    declare times: Record<string, number | null>;
    /** Current shader time in seconds, including host overrides. */
    declare animation_time: number;
    /** Classic DOM canvas parent, absent for host-owned canvases. */
    declare container: HTMLElement | null | undefined;
    /** Classic or host canvas, cleared during destruction. */
    declare canvas: HTMLCanvasElement | OffscreenCanvas | null;
    /** Attributes used only when allocating a classic WebGL context. */
    declare contextOptions: WebGLContextAttributes | undefined;
    /** Caller-owned classic context, if supplied. */
    declare external_gl: WebGLRenderingContext | null;
    /** Active classic context; portable rendering can leave it absent. */
    declare gl: WebGLRenderingContext | null;
    /** Caller-owned luma device used by portable drawing and readback. */
    declare device: Device | null;
    /** Selected source language for the active backend. */
    declare shader_language: 'glsl' | 'wgsl';
    /** Whether drawing is delegated to the device backend. */
    declare portable_rendering: boolean;
    /** Opaque scene resource identity, not a raw GPU owner. */
    declare resource_context: object | null;
    /** Whether the current resource context is configured. */
    declare resources_initialized: boolean;
    /** Whether scene teardown must release its canvas/context. */
    declare owns_gl: boolean;
    /** Optional host callback that brackets classic context access. */
    declare webgl_context_scope: SceneOptions['webGLContextScope'];
    /** Host notification used instead of an owned render loop. */
    declare redraw_callback: (() => void) | undefined;
    /** Whether classic shader state uses uniform blocks. */
    declare enable_uniform_buffers: boolean;
    /** Whether shader allocation is delegated to the device factory. */
    declare device_shader_compilation: boolean;
    /** Scene-owned uniform blocks shared by tile draws. */
    declare uniform_buffers: Record<string, UniformBuffer>;
    /** Initialized light instances, cleared during scene teardown. */
    declare lights: Record<string, Light> | null;
    /** Cached authored background and its last computed RGBA value. */
    declare background: {color?: import('../styles/property-types').PropertyCache; computed_color?: number[]} | null;
    /** Nested configuration-update lock count. */
    declare updating: number;
    /** Most recent generation whose geometry work drained. */
    declare last_complete_generation: number | null;
    /** Selected logging threshold for this scene. */
    declare log_level: LogLevel;
    /** Whether the current view has finished loading and building. */
    declare view_complete: boolean;
    /** Deduplicated scripts shared by scene and source configuration. */
    declare external_scripts: string[] | undefined;
    /** Round-robin worker index for new tile builds. */
    declare next_worker: number;
    /** Authored root directory used when reloading edited scenes. */
    declare base_path: string | undefined;
    /** Deprecated alias of the root resource directory. */
    declare config_path: string | undefined;
    /** Related-object subscriptions released during teardown. */
    declare listeners: Record<string, import('../utils/subscribe').EventListeners> | null;
    /** Classic cached GL render-state owner. */
    declare render_states: RenderStateManager | undefined;
    /** Portable pipeline policy captured for the current pass. */
    declare mesh_render_state: RenderPipelineParameters | null;
    /** Profiling callbacks installed by the scene debug adapter. */
    declare debug: {profile(name: string): void; profileEnd(name: string): void};
    /** Scene event dispatcher installed by the subscription mixin. */
    declare trigger: SubscriptionMethods['trigger'];
    /** Subscription lookup used before emitting expensive diagnostics. */
    declare hasSubscribersFor: SubscriptionMethods['hasSubscribersFor'];
    /** Subscription teardown installed by the shared event mixin. */
    declare unsubscribeAll: SubscriptionMethods['unsubscribeAll'];
    /** Caller allocation hook for scene-owned uniform blocks. */
    declare uniform_buffer_factory: TangramGPUSceneOptions['uniformBufferFactory'] | undefined;
    /** Caller allocation hook for owned shader resources. */
    declare shader_factory: TangramGPUSceneOptions['shaderFactory'] | undefined;
    /** Optional backend shader validation hook. */
    declare shader_program_validator: TangramGPUSceneOptions['shaderProgramValidator'] | undefined;
    /** Caller allocation hook for owned mesh buffers. */
    declare mesh_buffer_factory: TangramGPUSceneOptions['meshBufferFactory'] | undefined;
    /** Backend draw dispatcher; the scene does not own it. */
    declare mesh_renderer: TangramGPUSceneOptions['meshRenderer'] | undefined;
    /** Caller allocation hook for scene texture resources. */
    declare texture_factory: TangramGPUSceneOptions['textureFactory'] | undefined;
    /** Backend texture limit used by glyph atlas packing. */
    declare max_texture_size: number | undefined;
    /** Numeric broker identity assigned before the manager is constructed. */
    declare readonly id: number;
    /** Source/style generation consumed by serialized tile callbacks. */
    declare generation: number;
    /** Worker pool is absent before initialization and released during teardown. */
    declare workers: import('../utils/worker-types').BrokerWorker[] | null | undefined;
    /** Main-thread upload styles are not available before scene configuration loads. */
    declare styles: Record<string, import('../styles/style-mixing-types').ManagedStyle> | null;
    /** Detached optional worker terrain input; never a deck view or a provider handle. */
    declare terrain: import('../procedures/terrain-draping').TerrainDrapingSnapshot | undefined;
    /** Borrowed main-thread admission pool, never serialized into worker configuration. */
    declare terrainResourceBudget: import('../map-logic/terrain-resource-budget').TerrainResourceBudget | undefined;
    /** Main/worker input copies and internal query-capacity reservation, independent of mesh owners. */
    private terrainInputLease?: import('../map-logic/terrain-resource-budget').TerrainResourceLease;
    /** Replacement inputs cannot spend the still-admitted generation's reservation. */
    private terrainStagedInputLease?: import('../map-logic/terrain-resource-budget').TerrainResourceLease;
    /** Input identity already admitted for the current workers/query capacities. */
    private terrainInputSnapshot?: import('../procedures/terrain-draping').TerrainDrapingSnapshot;
    /** Input identity whose replacement resources are still staged. */
    private terrainStagedInputSnapshot?: import('../procedures/terrain-draping').TerrainDrapingSnapshot;
    /** Visual multiplier independent of source heights and cache keys. */
    declare terrainExaggeration: number;
    /** Monotonic timestamp shared by color, collision and every submitted eye. */
    declare terrainFrameTime: number | undefined;
    /** Terrain-only worker rebuilds stage mesh owners until every batch has completed. */
    declare terrainTransaction: boolean | undefined;
    /** Last terrain draw generation admitted after complete worker replacement. */
    declare terrainDisplayGeneration: number | undefined;
    /** Whether scene resources and workers are ready for queries/draws. */
    declare initialized: boolean;
    /** Active selection owner; loading clears this while a Renderer may retain its frame. */
    declare selection_view_id: string | null;
    /** Scene-local style activation and blend-order ownership. */
    declare style_manager: StyleManager;
    /** Active eye's independently owned selection target. */
    declare selection: FeatureSelection | null;
    /** Retained readback contexts; source feature maps remain shared in workers. */
    declare selection_views: Map<string, {selection: FeatureSelection; lastRender: number; pending: boolean}>;
    /** Current eye's pipeline-readiness lock, saved when another eye becomes active. */
    declare selection_render_pending: boolean;
    /** Last completed selection frame for the active eye. */
    declare last_selection_render: number;
    declare subscribe: (listeners: SceneListeners) => void;
    declare view: View;
    /** Tile worker and mesh ownership for the active scene. */
    declare tile_manager: TileManager | null;
    declare config: SceneRuntimeConfiguration | null;
    /** Current source instances, recreated when scene configuration changes. */
    declare sources: Record<string, DataSource>;
    declare dirty: boolean;
    declare start_time: number;
    declare host_animation_time: number | null;
    /** Shared source-procedure limit applies independently to each worker, not to mesh builds. */
    readonly maxConcurrentTileLoadsPerWorker: number | undefined;
    /** Scene-local broker endpoint; only this string crosses into workers. */
    private readonly projectionTarget: string | undefined;
    /** Scene owns compiled transforms, not the caller's reusable engine. */
    private readonly projectionAdapter: HostProjectionEngineAdapter | undefined;

    /** Configuration-dependent operations run after scene loading; teardown/reload keep the optional field truthful. */
    private get liveConfig(): SceneRuntimeConfiguration {
        if (!this.config) throw new Error('Scene configuration is not loaded');
        return this.config;
    }
    /** Draw operations on the classic path require a live context, unlike device-only submission. */
    private get activeGL(): WebGLRenderingContext {
        if (!this.gl) throw new Error('Scene has no active WebGL context');
        return this.gl;
    }
    /** Worker calls follow initialization and must not cross the destroyed pool boundary. */
    private get activeWorkers(): import('../utils/worker-types').BrokerWorker[] {
        if (!this.workers) throw new Error('Scene worker pool is not initialized');
        return this.workers;
    }
    /** Styles are initialized before the main draw path and retired when a scene is destroyed. */
    private get liveStyles(): Record<string, import('../styles/style-mixing-types').ManagedStyle> {
        if (!this.styles) throw new Error('Scene styles are not initialized');
        return this.styles;
    }
    /** Tile ownership is unavailable after teardown rather than a permanently live façade. */
    private get activeTileManager(): TileManager {
        if (!this.tile_manager) throw new Error('Scene tile manager has been destroyed');
        return this.tile_manager;
    }
    /** Rendering and query code use a concrete active-eye target after readiness checks. */
    private get activeSelection(): FeatureSelection {
        if (!this.selection) throw new Error('Scene feature selection is not initialized');
        return this.selection;
    }

    constructor(config_source: SceneDefinition | null, options: SceneOptions = {}) {
        options = options || {};
        this.terrain = options.terrain ? normalizeTerrainDraping(options.terrain) : undefined;
        this.terrainResourceBudget = options.terrainResourceBudget;
        this.terrainInputLease = this.terrainResourceBudget?.reserve('retained', 0) ?? undefined;
        this.terrainExaggeration = 1;
        validateProjectionEngine(options.projectionEngine);
        normalizeProjectionExecutionOptions(options.projectionEngineExecution);
        this.maxConcurrentTileLoadsPerWorker = validateConcurrentTileLoads(options.maxConcurrentTileLoadsPerWorker);
        subscribeMixin(this);

        this.id = Scene.id++;
        this.initialized = false;
        this.initializing = null; // will be a promise that resolves when scene is loaded
        this.sources = {};

        this.view = new View(this, options);
        this.tile_manager = new TileManager({ scene: this });
        this.num_workers = options.numWorkers || 2;
        this.worker_url = options.workerURL;
        if (options.disableVertexArrayObjects === true) {
            VertexArrayObject.disabled = true;
        }

        Utils.use_high_density_display = options.highDensityDisplay !== undefined ? options.highDensityDisplay : true;
        Utils.updateDevicePixelRatio();

        this.config = null;
        this.config_source = config_source;
        this.config_bundle = null;
        this.last_valid_config_source = null;

        this.styles = null;
        this.style_manager = new StyleManager();

        this.building = null;                           // tracks current scene building state (tiles being built, etc.)
        this.dirty = true;                              // request a redraw

        if (options.preUpdate){
            // optional pre-render loop hook
            this.subscribe({'pre_update': options.preUpdate});
        }

        if (options.postUpdate){
            // optional post-render loop hook
            this.subscribe({'post_update': options.postUpdate});
        }

        this.render_loop = !options.disableRenderLoop;  // disable render loop - app will have to manually call Scene.render() per frame
        this.render_loop_active = false;
        this.render_loop_stop = false;
        this.render_count = 0;
        this.last_render_count = 0;
        this.render_count_changed = false;
        this.frame = 0;
        this.last_main_render = -1;         // frame counter for last main render pass
        this.last_selection_render = -1;    // frame counter for last selection render pass
        this.selection_render_pending = false; // unfinished pipeline draws invalidate the selection target
        this.media_capture = new MediaCapture();
        this.selection = null;
        this.selection_views = new Map();
        this.selection_view_id = null;
        this.selection_feature_count = 0;
        this.fetching_selection_map = null;
        this.prev_textures = null; // textures from previously loaded scene (used for cleanup)
        this.introspection = (options.introspection === true) ? true : false;
        this.times = {}; // internal time logs (mostly for dev/profiling)
        this.resetTime();
        this.host_animation_time = null;
        this.animation_time = 0;

        this.container = options.container;
        this.canvas = options.canvas || null;
        this.contextOptions = options.webGLContextOptions;
        this.external_gl = options.webGLContext || null;
        this.gl = null;
        this.device = options.device || null;
        this.shader_language = options.shaderLanguage || 'glsl';
        this.portable_rendering = Boolean(this.device && this.shader_language !== 'glsl');
        this.resource_context = this.portable_rendering ? this.device : null;
        this.resources_initialized = false;
        this.owns_gl = !this.external_gl && !this.portable_rendering;
        this.webgl_context_scope = options.webGLContextScope;
        this.redraw_callback = options.requestRedraw;
        this.enable_uniform_buffers = options.enableUniformBuffers === true;
        this.device_shader_compilation = options.deviceShaderCompilation === true;
        this.uniform_buffer_factory = options.uniformBufferFactory;
        this.shader_factory = options.shaderFactory;
        this.shader_program_validator = options.shaderProgramValidator;
        this.mesh_buffer_factory = options.meshBufferFactory;
        this.mesh_renderer = options.meshRenderer;
        this.texture_factory = options.textureFactory;
        this.max_texture_size = options.maxTextureSize;
        this.uniform_buffers = {};

        this.lights = null;
        this.background = null;

        this.createListeners();
        this.updating = 0;
        this.generation = Scene.generation; // an id that is incremented each time the scene config is invalidated
        this.last_complete_generation = Scene.generation; // last generation id with a complete view
        setupSceneDebug(this);

        this.log_level = options.logLevel || 'warn';
        log.setLevel(this.log_level);
        log.reset?.();
        if (options.projectionEngine) {
            const adapter = this.projectionAdapter = new HostProjectionEngineAdapter(options.projectionEngine, options.projectionEngineExecution);
            this.projectionTarget = `ProjectionEngine_${this.id}`;
            WorkerBroker.addTarget(this.projectionTarget, {
                projectPositions: async (...parameters: Parameters<HostProjectionEngineAdapter['projectPositions']>) => WorkerBroker.withTransferables(
                    await adapter.projectPositions(...parameters))
            });
        }
    }

    static create (config: SceneDefinition | null, options: SceneOptions = {}) {
        return new Scene(config, options);
    }

    // Supply camera matrices from an embedding renderer
    setCameraMatrices (matrices: Parameters<View['setCameraMatrices']>[0]) {
        this.view.setCameraMatrices(matrices);
    }

    // Load scene (or reload existing scene if no new source specified)
    // Options:
    //   `base_path`: base URL against which scene resources should be resolved (useful for Play) (default nulll)
    //   `blocking`: should rendering block on scene load completion (default true)
    load (config_source: SceneDefinition | null = null, options: SceneLoadOptions = {}): Promise<void> {
        if (this.initializing) {
            return this.initializing;
        }
        log.reset?.();

        this.updating++;
        this.initialized = false;
        this.view_complete = false; // track if a view complete event has been triggered yet
        this.times.frame = null; // clear first frame time
        this.times.build = null; // clear first scene build time

        // Backwards compatibilty for passing `base_path` string as second argument
        // (since transitioned to using options argument to accept more parameters)
        options = (typeof options === 'string') ? { base_path: options } : options;

        // Should rendering block on load (not desirable for initial load, often desired for live style-switching)
        options.blocking = (options.blocking !== undefined) ? options.blocking : true;

        if (this.render_loop !== false) {
            this.setupRenderLoop();
        }

        // Load scene definition (sources, styles, etc.), then create styles & workers
        this.createCanvas();
        this.prev_textures = this.config && Object.keys(this.liveConfig.textures); // save textures from last scene
        this.initializing = this.loadScene(config_source, options)
            .then(async ({ texture_nodes }) => {
                await this.createWorkers();

                // Clean up resources from prior scene
                this.destroyFeatureSelection();
                WorkerBroker.postMessage(this.activeWorkers, 'self.clearFunctionStringCache');

                // Scene loaded from a JS object, or modified by a `load` event, may contain compiled JS functions
                // which need to be serialized, while one loaded only from a URL does not.
                const serialize_funcs = ((typeof this.config_source === 'object') || this.hasSubscribersFor('load'));

                const updating = this.updateConfig({
                    texture_nodes,
                    serialize_funcs,
                    normalize: false,
                    loading: true,
                    fade_in: true });

                if (options.blocking === true) {
                    await updating;
                }

                this.freePreviousTextures();
                this.updating--;
                this.initializing = null;
                this.initialized = true;
                this.last_valid_config_source = this.config_source;
                this.last_valid_options = { base_path: options.base_path, file_type: options.file_type };

                this.requestRedraw();
            }).catch(error => {
                this.initializing = null;
                this.updating = 0;

                // Report and revert to last valid config if available
                let type, message;
                if (error.name === 'YAMLException') {
                    type = 'yaml';
                    message = 'Error parsing scene YAML';
                }
                else {
                // TODO: more error types
                    message = 'Error initializing scene';
                }
                this.trigger('error', { type, message, error, url: this.config_source });

                message = `Scene.load() failed to load ${JSON.stringify(this.config_source)}: ${error.message}`;
                if (this.last_valid_config_source) {
                    log('warn', message, error);
                    log('info', 'Scene.load() reverting to last valid configuration');
                    return this.load(this.last_valid_config_source, this.last_valid_base_path);
                }
                log('error', message, error);
                throw error;
            });

        return this.initializing;
    }

    destroy() {
        return this.withWebGLContext(() => this.destroyScene());
    }

    destroyScene() {
        this.projectionAdapter?.dispose();
        if (this.projectionTarget) WorkerBroker.removeTarget(this.projectionTarget);
        this.initialized = false;
        this.render_loop_stop = true; // schedule render loop to stop

        this.destroyListeners();
        this.destroyFeatureSelection();

        if (this.owns_gl && this.canvas && 'parentNode' in this.canvas && this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }
        this.canvas = null;
        this.container = null;

        const resource_context = this.portable_rendering ? this.resource_context : this.gl;
        if (resource_context) {
            Texture.destroy(resource_context);
            Texture.clearResourceFactory(resource_context);
            this.style_manager.destroy(resource_context);
            this.styles = {};
            this.destroyUniformBuffers();

            ShaderProgram.reset();

            if (this.owns_gl) {
                // Force context loss only when Tangram created and owns it
                let ext = this.activeGL.getExtension('WEBGL_lose_context');
                if (ext) {
                    ext.loseContext();
                }
            }

            this.gl = null;
        }
        this.resources_initialized = false;

        for (const source of Object.values(this.sources)) source.dispose?.();
        this.sources = {};

        this.destroyWorkers();
        this.activeTileManager.destroy();
        this.terrainInputLease?.release();
        this.terrainStagedInputLease?.release();
        this.terrain = undefined; this.terrainInputSnapshot = undefined; this.terrainStagedInputSnapshot = undefined;
        this.terrainResourceBudget = undefined;
        this.tile_manager = null;
        log.reset?.();
    }

    createCanvas() {
        if (this.gl || (this.portable_rendering && this.resources_initialized)) {
            return;
        }

        return this.withWebGLContext(() => this.createCanvasContext());
    }

    createCanvasContext() {
        if (this.portable_rendering) {
            if (!this.resource_context) throw new Error('Scene has no portable resource context');
            Texture.setResourceFactory(this.resource_context, this.texture_factory);
            this.media_capture.setCanvas(this.canvas, null);
            this.createUniformBuffers();
            this.resources_initialized = true;
            return;
        }
        else if (this.external_gl) {
            this.gl = Context.configure(this.external_gl, this.webgl_context_scope);
            this.canvas = this.activeGL.canvas;
        }
        else {
            this.container = this.container || document.body;
            this.canvas = document.createElement('canvas');
            this.canvas.style.position = 'absolute';
            this.canvas.style.top = '0';
            this.canvas.style.left = '0';

            // Force tangram canvas underneath all leaflet layers, and set background to transparent
            this.container.style.backgroundColor = 'transparent';
            this.container.appendChild(this.canvas);

            try {
                this.gl = Context.getContext(this.canvas, Object.assign({
                    alpha: true, premultipliedAlpha: true,
                    stencil: true,
                    device_pixel_ratio: Utils.device_pixel_ratio,
                    powerPreference: 'high-performance'
                }, this.contextOptions));
            }
            catch(e) {
                throw new Error(
                    'Couldn\'t create WebGL context. ' +
                    'Your browser may not support WebGL, or it\'s turned off? ' +
                    'Visit http://webglreport.com/ for more info.'
                );
            }
        }

        if (this.owns_gl) {
            if (!this.container) throw new Error('Scene canvas has no container');
            this.resizeMap(this.container.clientWidth, this.container.clientHeight);
        }
        Texture.setResourceFactory(this.gl, this.texture_factory);
        VertexArrayObject.init(this.gl);
        this.render_states = new RenderStateManager(this.gl);
        this.media_capture.setCanvas(this.canvas, this.gl);
        this.createUniformBuffers();
    }

    createUniformBuffers() {
        if (!this.enable_uniform_buffers ||
            (!UniformBuffer.isSupported(this.gl) && !this.uniform_buffer_factory)) {
            return;
        }
        this.uniform_buffers.TangramView = this.createUniformBuffer({
            name: 'TangramView',
            binding: 0,
            uniforms: {
                u_resolution: 'vec2',
                u_time: 'float',
                u_map_position: 'vec3',
                u_meters_per_pixel: 'float',
                u_device_pixel_ratio: 'float',
                u_view_pan_snap_timer: 'float',
                u_view_panning: 'bool',
                u_projection_mode: 'int'
            }
        });
        this.uniform_buffers.TangramCamera = this.createUniformBuffer({
            name: 'TangramCamera',
            binding: 1,
            uniforms: {
                u_projection: 'mat4',
                u_eye: 'vec3',
                u_vanishing_point: 'vec2'
            }
        });
        this.uniform_buffers.TangramTile = this.createUniformBuffer({
            name: 'TangramTile',
            binding: 2,
            snapshotPerMesh: true,
            uniforms: {
                u_tile_origin: 'vec4',
                u_tile_proxy_order_offset: 'float',
                u_tile_clip_bounds: 'vec4',
                u_model: 'mat4',
                u_modelView: 'mat4',
                u_normalMatrix: 'mat3',
                u_inverseNormalMatrix: 'mat3',
                u_tile_fade_in: 'bool',
                ...(this.terrain ? {u_terrain_blend: 'float', u_terrain_exaggeration: 'float'} : {})
            }
        });
    }

    createUniformBuffer(options: UniformBufferOptions) {
        const gl = this.gl;
        return new UniformBuffer(this.portable_rendering || !UniformBuffer.isSupported(gl) ? null : gl, Object.assign({}, options, {
            bufferFactory: this.uniform_buffer_factory
        }));
    }

    destroyUniformBuffers() {
        for (const uniform_buffer of Object.values(this.uniform_buffers)) {
            uniform_buffer.destroy();
        }
        this.uniform_buffers = {};
    }

    // Update list of any custom scripts (either at scene-level or data-source-level)
    updateExternalScripts () {
        let prev_scripts = [...(this.external_scripts||[])]; // save list of previously loaded scripts
        let scripts = [];

        // scene-level scripts
        if (this.liveConfig.scene.scripts) {
            for (let f in this.liveConfig.scene.scripts) {
                    const script = Reflect.get(this.liveConfig.scene.scripts, f);
                    if (scripts.indexOf(script) === -1) {
                        scripts.push(script);
                }
            }
        }

        // data-source-level scripts
        for (let s in this.liveConfig.sources) {
            let source = this.liveConfig.sources[s];
            if (source.scripts) {
                for (let f in source.scripts) {
                    const script = Reflect.get(source.scripts, f);
                    if (scripts.indexOf(script) === -1) {
                        scripts.push(script);
                    }
                }
            }
        }

        this.external_scripts = scripts;

        // Scripts changed?
        return !(this.external_scripts.length === prev_scripts.length &&
            this.external_scripts.every((v, i) => v === prev_scripts[i]));
    }

    // Web workers handle heavy duty tile construction: networking, geometry processing, etc.
    createWorkers() {
        // Reset old workers (if any) if we need to re-instantiate with new external scripts
        if (this.updateExternalScripts()) {
            this.destroyWorkers();
        }

        if (!this.workers) {
            return this.makeWorkers();
        }
        return Promise.resolve();
    }

    // Instantiate workers from URL, init event handlers
    makeWorkers() {
        // Let VertexElements know if 32 bit indices for element arrays are available
        let has_element_index_uint = this.portable_rendering ||
            (this.activeGL.getExtension('OES_element_index_uint') ? true : false);

        let queue = [];
        this.workers = [];
        for (let id=0; id < this.num_workers; id++) {
            let url = this.worker_url || getWorkerURL();
            if (!url) {
                const fallbackValue: unknown = Reflect.get(Tangram, 'workerURL');
                url = typeof fallbackValue === 'string' ? fallbackValue : undefined;
            }
            if (!url) throw new Error('Scene has no worker URL');
            let worker = new Worker(url); // eslint-disable-line no-undef
            this.workers[id] = worker;

            WorkerBroker.addWorker(worker);

            log('debug', `Scene.makeWorkers: initializing worker ${id}`);
            let _id = id;
            queue.push(WorkerBroker.postMessage(worker, 'self.init', this.id, id, this.num_workers, this.log_level, Utils.device_pixel_ratio, has_element_index_uint, this.external_scripts, this.maxConcurrentTileLoadsPerWorker).then(
                (id) => {
                    log('debug', `Scene.makeWorkers: initialized worker ${id}`);
                    return id;
                },
                (error) => {
                    log('error', `Scene.makeWorkers: failed to initialize worker ${_id}:`, error);
                    return Promise.reject(error);
                })
            );
        }

        this.next_worker = 0;
        return Promise.all(queue).then(() => {
            log.setWorkers?.(this.workers ?? null);
        });
    }

    destroyWorkers() {
        this.destroyFeatureSelection(); // selections retain worker references and must be recreated
        if (Array.isArray(this.workers)) {
            log.setWorkers?.(null);
            this.workers.forEach((worker) => {
                if ('terminate' in worker && typeof worker.terminate === 'function') worker.terminate();
            });
            this.workers = null;
        }
    }

    // Scene is ready for rendering
    ready() {
        if (!this.view.ready() || Object.keys(this.sources).length === 0) {
            return false;
        }
        return true;
    }

    // Resize the map when device pixel ratio changes, e.g. when switching between displays
    updateDevicePixelRatio () {
        if (Utils.updateDevicePixelRatio()) {
            WorkerBroker.postMessage(this.activeWorkers, 'self.updateDevicePixelRatio', Utils.device_pixel_ratio)
                .then(() => this.rebuild())
                .then(() => {const {width, height} = this.view.size.css; if (width !== undefined && height !== undefined) this.resizeMap(width, height);});
        }
    }

    resizeMap(width: number, height: number) {
        if (width === 0 && height === 0) {
            return;
        }

        this.dirty = true;
        this.view.setViewportSize(width, height);
        if (this.gl && this.owns_gl) {
            Context.resize(this.gl, width, height, Utils.device_pixel_ratio);
        }
    }

    withWebGLContext<Result>(callback: () => Result): Result {
        return this.webgl_context_scope ? this.webgl_context_scope(callback) : callback();
    }

    resetWebGLState() {
        ShaderProgram.resetCurrent();
        Texture.resetBindings();
        if (this.render_states) {
            this.render_states.invalidate();
        }
    }

    // Request scene be redrawn at next animation loop
    requestRedraw() {
        this.dirty = true;
        if (this.render_loop === false && this.redraw_callback) {
            this.redraw_callback();
        }
    }

    // Redraw scene immediately - don't wait for animation loop
    // Use sparingly, but for cases where you need the closest possible sync with other UI elements,
    // such as other, non-WebGL map layers (e.g. Leaflet raster layers, markers, etc.)
    immediateRedraw() {
        this.dirty = true;
        this.update();
    }

    renderLoop () {
        this.render_loop_active = true; // only let the render loop instantiate once

        // Update and render the scene
        this.update();

        this.processTasks();

        // Request the next frame if not scheduled to stop
        if (!this.render_loop_stop) {
            window.requestAnimationFrame(this.renderLoop.bind(this));
        }
        else {
            this.render_loop_stop = false;
            this.render_loop_active = false;
        }
    }

    // Advance background work normally serviced by Tangram's animation loop.
    // Host-driven renderers must call this once per frame so tile labels and
    // other incremental work can complete without a standalone render loop.
    processTasks () {
        Task.setState({ user_moving_view: this.view.user_input_active });
        Task.processAll();
        // Host loops may stop when no mesh is currently visible. Cooperative
        // label work must still receive its next bounded slice to finish a stage.
        if (Task.queue.length) this.requestRedraw();
    }

    // Setup the render loop
    setupRenderLoop() {
        if (!this.render_loop_active) {
            setTimeout(() => { this.renderLoop(); }, 0); // delay start by one tick
        }
    }

    update({ force = false, renderPass = null }: {force?: boolean; renderPass?: RenderPass | null} = {}) {
        return this.withWebGLContext(() => {
            if (force) {
                this.dirty = true;
            }
            if (this.external_gl) {
                this.resetWebGLState();
            }
            return this.updateScene({ renderPass });
        });
    }

    updateScene({ renderPass = null }: {renderPass?: RenderPass | null} = {}) {
        // Capture time once per draw; hosts freeze it across all eyes of a logical frame.
        this.animation_time = this.host_animation_time ?? ((Date.now() - this.start_time) / 1000);
        // Determine which passes (if any) to render
        let main = this.dirty;
        let selection = this.selection ? this.activeSelection.hasPendingRequests() : false;
        var will_render = !(
            (main === false && selection === false) ||
            this.initialized === false ||
            this.updating > 0 ||
            this.ready() === false
        );

        // Pre-render loop hook
        this.trigger('pre_update', will_render);

        // Update view (needs to update user input timer even if no render will occur)
        this.view.update(this.host_animation_time === null ? undefined : this.start_time + this.host_animation_time * 1000);

        // Bail if no need to render
        if (!will_render) {
            return false;
        }
        this.dirty = false; // subclasses can set this back to true when animation is needed

        // Render the scene
        this.updateDevicePixelRatio();
        this.render({ main, selection, renderPass });
        this.updateViewComplete(); // fires event when rendered tile set or style changes
        this.media_capture.completeScreenshot(); // completes screenshot capture if requested

        // Post-render loop hook
        this.trigger('post_update', will_render);

        // Redraw every frame if animating
        if (this.animated === true || this.view.isAnimating()) {
            this.dirty = true;
        }

        this.frame++;
        log('trace', 'Scene.render()');
        return true;
    }

    // Accepts flags indicating which render passes should be made
    render({ main, selection, renderPass = null }: {main: boolean; selection: boolean; renderPass?: RenderPass | null}) {
        var gl = this.gl;

        this.updateBackground();
        const lights = this.lights ?? {};
        Object.keys(lights).forEach(i => lights[i].update());

        // Render main pass
        this.render_count_changed = false;
        if (main) {
            this.render_count = this.renderPass('program', { renderPass });
            this.last_main_render = this.frame;

            // Update feature selection map if necessary
            if (this.render_count !== this.last_render_count) {
                this.render_count_changed = true;
                this.logFirstFrame();

                this.getFeatureSelectionMapSize().then(size => {
                    this.selection_feature_count = size;
                    log('info', `Scene: rendered ${this.render_count} primitives (${size} features in selection map)`);
                });
            }
            this.last_render_count = this.render_count;
        }

        // Render selection pass (if needed)
        if (selection) {
            // Permit retrying an unfinished pass; delayed readback remains locked
            // between frames until every selection pipeline is ready.
            this.selection_render_pending = false;
            if (this.view.panning || this.view.user_input_active) {
                this.activeSelection.clearPendingRequests();
                return;
            }

            // Only re-render if selection buffer is out of date (relative to main render buffer)
            // and not locked (e.g. no tiles are actively building)
            if (!this.activeSelection.locked && this.last_selection_render < this.last_main_render) {
                if (this.activeSelection.framebuffer) {
                    // An external host pass may still be open. Use a separate
                    // encoder, and submit selection before its asynchronous copy.
                    const device = this.device;
                    if (!device) throw new Error('Scene selection framebuffer has no device');
                    let encoder = device.type === 'webgpu' ? device.createCommandEncoder({id: 'tangram-selection'}) : null;
                    let selection_pass = null;
                    try {
                        // Host eye scissors use full-canvas origins; selection targets
                        // are view-local, including the attachment clear at pass creation.
                        const {width, height} = this.activeSelection.fbo_size;
                        selection_pass = (encoder ?? device).beginRenderPass({
                            framebuffer: this.activeSelection.framebuffer,
                            parameters: {viewport: [0, 0, width, height], scissorRect: [0, 0, width, height]},
                            clearColor: FeatureSelection.defaultColor,
                            clearDepth: 1
                        });
                        this.renderPass('selection_program', {
                            allow_blend: false,
                            renderPass: selection_pass
                        });
                    }
                    finally {
                        try {
                            selection_pass?.end();
                            if (encoder && selection_pass) {
                                const commands = encoder.finish();
                                encoder = null; // finish releases the encoder; submit releases the commands.
                                device.submit(commands);
                            }
                        } finally {
                            encoder?.destroy();
                        }
                    }
                }
                else {
                    this.activeSelection.bind();          // switch to FBO
                    this.renderPass(
                        'selection_program',        // render w/alternate program
                        { allow_blend: false });
                }

                // Device render passes own state restoration; only classic rendering binds raw targets.
                if (!this.activeSelection.framebuffer) {
                    const context = this.activeGL, color = this.background?.computed_color;
                    if (!this.canvas || !color) throw new Error('Scene selection has no canvas/background');
                    context.bindFramebuffer(context.FRAMEBUFFER, null);
                    context.viewport(0, 0, this.canvas.width, this.canvas.height);
                    context.clearColor(color[0], color[1], color[2], color[3]);
                }
                if (this.selection_render_pending) return true;
                this.last_selection_render = this.frame;
            }

            this.activeSelection.read(); // process any pending results from selection buffer
        }

        return true;
    }

    // Render all active styles, grouped by blend/depth type (opaque, overlay, etc.) and by program (style)
    // Called both for main render pass, and for secondary passes like selection buffer
    renderPass(program_key: 'program' | 'selection_program' = 'program', { allow_blend, renderPass = null }: {allow_blend?: boolean; renderPass?: RenderPass | null} = {}) {
        // optionally force alpha off (e.g. for selection pass)
        allow_blend = (allow_blend == null) ? true : allow_blend;

        if (this.portable_rendering) {
            return this.renderPortablePass(program_key, { allow_blend, renderPass });
        }

        this.clearFrame();

        let count = 0; // how many primitives were rendered
        let last_blend; // blend mode active in last render pass
        let last_annotation_depth;

        // Get sorted list of current blend orders, with accompanying list of styles to render for each
        const blend_orders = this.style_manager.getActiveBlendOrders();
        if (program_key === 'selection_program' && this.terrain?.occludeAnnotations) this.renderSelectionDepthPrepass(blend_orders, renderPass);
        for (const { blend_order, styles } of blend_orders) {
            // Render each style
            for (let s=0; s < styles.length; s++) {
                let style = this.liveStyles[styles[s]];
                if (style == null) {
                    continue;
                }

                // Only update render state when blend mode changes
                const annotation_depth = this.terrain?.occludeAnnotations && ['points', 'text'].includes(style.baseStyle?.());
                if (style.blend !== last_blend || annotation_depth !== last_annotation_depth) {
                    let state = Object.assign({},
                        Style.render_states[style.blend],       // render state for blend mode
                        { blend: (allow_blend && style.blend) } // enable/disable blending (e.g. no blend for selection)
                    );
                    if (annotation_depth) {state.depth_test = true; state.depth_write = false;}
                    this.setRenderState(state);
                    if (annotation_depth && this.mesh_render_state) this.mesh_render_state.depthCompare = 'less-equal';
                    if (this.terrain?.occludeAnnotations) this.activeGL.depthFunc(annotation_depth ? this.activeGL.LEQUAL : this.activeGL.LESS);
                }

                const blend = allow_blend && style.blend;
                if (blend === 'translucent') {
                    const translucentRenderState = this.mesh_render_state;
                    try {
                        // Depth pre-pass for translucency
                        this.activeGL.colorMask(false, false, false, false);
                        // Resource-backed WebGL draws reapply luma pipeline parameters;
                        // raw GL changes alone cannot control their depth/color passes.
                        this.mesh_render_state = {...translucentRenderState, colorMask: 0};
                        this.renderStyle(style.name, program_key, blend_order, null, renderPass);

                        this.activeGL.colorMask(true, true, true, true);
                        this.activeGL.depthFunc(this.activeGL.EQUAL);
                        this.mesh_render_state = {...translucentRenderState, colorMask: 15, depthCompare: 'equal'};

                        // Stencil buffer mask prevents overlap/flicker from compounding alpha of overlapping polys
                        this.activeGL.enable(this.activeGL.STENCIL_TEST);
                        this.activeGL.clearStencil(0);
                        this.activeGL.clear(this.activeGL.STENCIL_BUFFER_BIT);
                        this.activeGL.stencilFunc(this.activeGL.EQUAL, this.activeGL.ZERO, 0xFF);
                        this.activeGL.stencilOp(this.activeGL.KEEP, this.activeGL.KEEP, this.activeGL.INCR);

                        // Main render pass
                        count += this.renderStyle(style.name, program_key, blend_order, null, renderPass);
                    } finally {
                        // Disable translucency-specific settings, also after a failed draw.
                        this.mesh_render_state = translucentRenderState;
                        this.activeGL.colorMask(true, true, true, true);
                        this.activeGL.disable(this.activeGL.STENCIL_TEST);
                        this.activeGL.depthFunc(this.activeGL.LESS);
                    }
                }
                else if (blend !== 'opaque' && style.stencil_proxy_tiles === true) {
                    // Mask proxy tiles to with stencil buffer to avoid overlap/flicker from compounding alpha
                    // Find unique levels of proxy tiles to render for this style
                    const proxy_levels = this.activeTileManager.getRenderableTiles()
                        .filter(t => t.meshes[style.name]) // must have meshes for this style
                        .map(t => t.proxy_level) // get the proxy depth
                        .reduce<number[]>((levels, level) => { // count unique proxy depths
                            levels.indexOf(level) > -1 || levels.push(level);
                            return levels;
                        }, [])
                        .sort(); // sort by lower depth first

                    if (proxy_levels.length > 1) {
                        // When there are multiple "levels" of tiles to render (e.g. non-proxy and one or more proxy
                        // tile levels, or multiple proxy tile levels but no non-proxy tiles, etc.):
                        // Render each proxy tile level to stencil buffer, masking each level such that it will not
                        // render over any pixel rendered by a previous proxy tile level.
                        this.activeGL.enable(this.activeGL.STENCIL_TEST);
                        this.activeGL.clearStencil(0);
                        this.activeGL.clear(this.activeGL.STENCIL_BUFFER_BIT);
                        this.activeGL.stencilOp(this.activeGL.KEEP, this.activeGL.KEEP, this.activeGL.REPLACE);

                        for (let i = 0; i < proxy_levels.length; i++) {
                            // stencil test passes either for zero (not-yet-rendered),
                            // or for other pixels at this proxy level (but not previous proxy levels)
                            this.activeGL.stencilFunc(this.activeGL.GEQUAL, proxy_levels.length - i, 0xFF);
                            count += this.renderStyle(style.name, program_key, blend_order, proxy_levels[i], renderPass);
                        }
                        this.activeGL.disable(this.activeGL.STENCIL_TEST);
                    }
                    else {
                        // No special render handling needed when there are no proxy tiles,
                        // or if there is ONLY a single proxy tile level (e.g. with no non-proxy tiles)
                        count += this.renderStyle(style.name, program_key, blend_order, null, renderPass);
                    }
                }
                else {
                    // Regular render pass (no special blend handling, or selection buffer pass)
                    count += this.renderStyle(style.name, program_key, blend_order, null, renderPass);
                }

                last_blend = style.blend;
                last_annotation_depth = annotation_depth;
            }
        }

        return count;
    }

    // Render styles through luma pipelines without mutating a raw WebGL state machine.
    renderPortablePass(program_key: 'program' | 'selection_program', { allow_blend, renderPass }: {allow_blend: boolean; renderPass: RenderPass | null}) {
        let count = 0;
        let last_blend;
        let last_annotation_depth;
        const blend_orders = this.style_manager.getActiveBlendOrders();
        if (program_key === 'selection_program' && this.terrain?.occludeAnnotations) this.renderSelectionDepthPrepass(blend_orders, renderPass);
        for (const { blend_order, styles } of blend_orders) {
            for (const style_name of styles) {
                const style = this.liveStyles[style_name];
                if (!style) {
                    continue;
                }
                const annotation_depth = this.terrain?.occludeAnnotations && ['points', 'text'].includes(style.baseStyle?.());
                if (style.blend !== last_blend || annotation_depth !== last_annotation_depth) {
                    this.setRenderState(Object.assign({}, Style.render_states[style.blend], {
                        blend: allow_blend && style.blend,
                        ...(annotation_depth ? {depth_test: true, depth_write: false} : {})
                    }));
                    if (annotation_depth && this.mesh_render_state) this.mesh_render_state.depthCompare = 'less-equal';
                    last_blend = style.blend;
                    last_annotation_depth = annotation_depth;
                }
                count += this.renderStyle(style.name, program_key, blend_order, null, renderPass);
            }
        }
        return count;
    }

    /** Whether a non-selectable style contributes color depth but cannot write feature IDs. */
    isTerrainSelectionOccluder(style: {selection?: boolean; baseStyle?(): string; blend: import('../styles/style-runtime-types').StyleState['blend']} | undefined): boolean {
        return Boolean(this.terrain?.occludeAnnotations && style && !style.selection &&
            ['raster', 'polygons', 'lines'].includes(style.baseStyle?.() ?? '') && Style.render_states[style.blend]?.depth_write !== false);
    }

    /** Populate non-selectable scene depth before any IDs; pending pipelines keep selection locked for retry. */
    renderSelectionDepthPrepass(blend_orders: {blend_order?: number; styles: string[]}[], renderPass: import('@luma.gl/core').RenderPass | null): void {
        const occluders = blend_orders.flatMap(({blend_order, styles}) => styles
            .filter(name => this.isTerrainSelectionOccluder(this.liveStyles[name])).map(name => ({name, blend_order})));
        if (!occluders.length) return;
        const previous = this.mesh_render_state;
        try {
            this.setRenderState({depth_test: true, depth_write: true, cull_face: true, blend: false});
            this.mesh_render_state = {...this.mesh_render_state, colorMask: 0, depthWriteEnabled: true, depthCompare: 'less'};
            if (!this.portable_rendering) {
                this.activeGL.colorMask(false, false, false, false); this.activeGL.depthFunc(this.activeGL.LESS);
            }
            for (const {name, blend_order} of occluders) this.renderStyle(name, 'program', blend_order, null, renderPass, true);
        } finally {
            this.mesh_render_state = previous;
            if (!this.portable_rendering) this.activeGL.colorMask(true, true, true, true);
        }
    }

    renderStyle(style_name: string, program_key: 'program' | 'selection_program', blend_order: number | undefined, proxy_level: number | null = null, renderPass: RenderPass | null = null, selectionDepthPass = false) {
        let style = this.liveStyles[style_name];
        // Already submitted before any IDs. Repeating it later cannot erase covered IDs.
        if (program_key === 'selection_program' && this.terrain?.occludeAnnotations && this.isTerrainSelectionOccluder(style)) return 0;
        let first_for_style = true; // TODO: allow this state to be passed in (for multilpe blend orders, stencil tests, etc)
        let render_count = 0;
        let program: ShaderProgram | undefined;

        // Render tile GL geometries
        let renderable_tiles = this.activeTileManager.getRenderableTiles();

        // For each tile, only include meshes for the blend order currently being rendered
        // Each draw groups a tile, its meshes and optional missing-detail clip bounds.
        let tile_meshes = renderable_tiles
            .filter(t => typeof proxy_level !== 'number' || t.proxy_level === proxy_level) // optional filter by proxy level
            .flatMap((t): [import('../tile/tile').default, import('../gl/vbo_mesh').default[], readonly [number, number, number, number] | undefined][] => {
                if (t.meshes[style_name]) {
                    const meshes = t.meshes[style_name].filter(m => m.variant.blend_order === blend_order);
                    if (t.fallback_for) {
                        // Do not duplicate labels or report placeholder feature picks.
                        if (program_key === 'selection_program' ||
                            !isGlobeFallbackStyle(style.name, style.base)) return [];
                        return Array.from(t.fallback_for.values(), clip => [t, meshes, clip]);
                    }
                    return [[t, meshes, undefined]];
                }
                return [];
            });

        // Mesh variants must be rendered in requested order across tiles, to prevent labels that cross
        // tile boundaries from rendering over adjacent tile features meant to be underneath
        let max_mesh_order =
            Math.max(...tile_meshes.map(([, meshes]) => {
                return Math.max(...meshes.map(m => Number(m.variant.mesh_order)));
            }));

        // One pass per mesh variant order (loop goes to max value +1 because 0 is a valid order value)
        for (let mo=0; mo < max_mesh_order + 1; mo++) {
            // Loop over tiles, with meshes pre-filtered by current blend order
            for (let [tile, meshes, clip] of tile_meshes) {
                let first_for_tile = true;

                // Skip proxy tiles if new tiles have finished loading this style
                if (!tile.shouldProxyForStyle(style_name)) {
                    // log('trace', `Scene.renderStyle(): Skip proxy tile for style '${style_name}' `, tile, tile.proxy_for);
                    continue;
                }

                // Filter meshes further by current variant order
                const order_meshes = meshes.filter(m => m.variant.mesh_order === mo);
                if (order_meshes.length === 0) {
                    continue;
                }

                // Style-specific state
                // Only setup style if rendering for first time this frame
                // (lazy init, not all styles will be used in all screen views; some styles might be defined but never used)
                if (first_for_style === true) {
                    first_for_style = false;
                    program = this.setupStyle(style, program_key);
                    if (!program) {
                        // no program found, e.g. happens when rendering selection pass, but style doesn't support selection
                        return 0;
                    }
                }

                // Render each mesh (for current variant order)
                if (!program) throw new Error('Scene mesh program is not ready');
                const activeProgram = program;
                order_meshes.forEach(mesh => {
                    // Tile-specific state
                    if (first_for_tile === true) {
                        first_for_tile = false;
                        this.view.setupTile(tile, activeProgram, clip ?? (mesh.variant.terrainGroundClip ? [0, -4096, 4096, 0] : undefined));
                    }

                    // Render this mesh variant
                    if (mesh.variant.terrain) {
                        const now = this.terrainFrameTime ?? performance.now();
                        const origin = this.activeTileManager.getTerrainTransitionOrigin(mesh, now);
                        const duration = mesh.variant.terrainTransitionDuration ?? this.terrain?.transitionDuration ?? 0;
                        const blend = duration ? Math.max(0, Math.min(1, (now - origin) / duration)) : 1;
                        mesh.terrainBlend = blend;
                        const uniforms = {u_terrain_blend: blend, u_terrain_exaggeration: this.terrainExaggeration};
                        if (this.uniform_buffers.TangramTile) this.uniform_buffers.TangramTile.setUniforms(uniforms);
                        else {activeProgram.uniform('1f', 'u_terrain_blend', blend); activeProgram.uniform('1f', 'u_terrain_exaggeration', this.terrainExaggeration);}
                        if (blend < 1) this.requestRedraw();
                    }
                    if (style.render(mesh, {
                        projection: this.view.projection.type,
                        renderPass: renderPass ?? undefined,
                        meshRenderer: this.mesh_renderer,
                        renderState: this.mesh_render_state ?? undefined
                    })) {
                        if (program_key === 'selection_program' || selectionDepthPass) this.selection_render_pending = true;
                        this.requestRedraw();
                    }
                    render_count += mesh.geometry_count;
                });
            }
        }

        return render_count;
    }

    setupStyle(style: import('../styles/style-mixing-types').ManagedStyle, program_key: 'program' | 'selection_program') {
        // Get shader program from style, lazily compiling if necessary
        let program: ShaderProgram | undefined;
        try {
            program = style.getProgram(program_key);
            if (!program) {
                return;
            }
        }
        catch(error) {
            this.trigger('warning', {
                type: 'styles',
                message: `Error compiling style ${style.name}`,
                style,
                shader_errors: style.program && style.program.shader_errors
            });
            return;
        }

        program.use();
        style.setup();

        const time = this.animated ? this.animation_time : 0;
        if (this.uniform_buffers.TangramView) {
            this.uniform_buffers.TangramView.setUniform('u_time', time);
            this.view.setupProgram(program, this.uniform_buffers);
            if (this.uniform_buffers.TangramLighting) {
                this.uniform_buffers.TangramLighting.setUniforms(getPortableLightUniforms(this.getLumaLightDefinitions()));
            }
            program.bindUniformBlocks();
        }
        else {
            program.uniform('1f', 'u_time', time);
            this.view.setupProgram(program);
        }

        for (let i in this.lights) {
            this.lights[i].setupProgram(program);
        }

        return program;
    }

    clearFrame() {
        if (!this.initialized) {
            return;
        }
        if (this.portable_rendering) {
            return;
        }
        if (!this.render_states) throw new Error('Scene render state is not initialized');
        this.render_states.depth_write.set({ depth_write: true });
        this.activeGL.clear(this.activeGL.COLOR_BUFFER_BIT | this.activeGL.DEPTH_BUFFER_BIT | this.activeGL.STENCIL_BUFFER_BIT);
    }

    setRenderState({ depth_test, depth_write, cull_face, blend }: {depth_test?: boolean; depth_write?: boolean; cull_face?: boolean; blend?: import('../gpu/tangram_gpu_backend').TangramBlendMode} = {}) {
        if (!this.initialized) {
            return;
        }

        // Defaults
        // TODO: when we abstract out support for multiple render passes, these can be per-pass config options
        let render_states = this.render_states;
        const defaults = this.portable_rendering ? {
            depth_test: true,
            depth_write: true,
            culling: true,
            blending: false as const
        } : this.getRenderStateDefaults();
        depth_test = (depth_test === false) ? false : defaults.depth_test;      // default true
        depth_write = (depth_write === false) ? false : defaults.depth_write;   // default true
        cull_face = (cull_face === false) ? false : defaults.culling;           // default true
        blend = (blend != null) ? blend : defaults.blending;                    // default false
        this.mesh_render_state = this.mesh_renderer ?
            this.mesh_renderer.getRenderPipelineParameters({
                depthTest: depth_test,
                depthWrite: depth_write,
                cullFace: cull_face,
                blend
            }) : null;

        if (this.portable_rendering) {
            return;
        }

        // Reset frame state
        if (!render_states) throw new Error('Scene render state is not initialized');
        let gl = this.activeGL;

        render_states.depth_test.set({ depth_test });
        render_states.depth_write.set({ depth_write });
        render_states.culling.set({ cull: cull_face, face: render_states.defaults.culling_face });

        // Blending of alpha channel is modified to account for WebGL alpha behavior, see:
        // http://webglfundamentals.org/webgl/lessons/webgl-and-alpha.html
        // http://stackoverflow.com/a/11533416
        if (blend) {
            // Opaque: all source, no destination
            if (blend === 'opaque') {
                render_states.blending.set({
                    blend: false
                });
            }
            // Traditional alpha blending
            else if (blend === 'overlay' || blend === 'inlay' || blend === 'translucent') {
                render_states.blending.set({
                    blend: true,
                    src: gl.SRC_ALPHA, dst: gl.ONE_MINUS_SRC_ALPHA,
                    src_alpha: gl.ONE, dst_alpha: gl.ONE_MINUS_SRC_ALPHA
                });
            }
            // Additive blending
            else if (blend === 'add') {
                render_states.blending.set({
                    blend: true,
                    src: gl.ONE, dst: gl.ONE
                });
            }
            // Multiplicative blending
            else if (blend === 'multiply') {
                render_states.blending.set({
                    blend: true,
                    src: gl.ZERO, dst: gl.SRC_COLOR
                });
            }
        }
        else {
            render_states.blending.set({ blend: false });
        }
    }

    // Request feature selection at given pixel. Runs async and returns results via a promise.
    /** Classic render-state defaults are absent on device-only scenes. */
    private getRenderStateDefaults(): RenderStateManager['defaults'] {
        if (!this.render_states) throw new Error('Scene render state is not initialized');
        return this.render_states.defaults;
    }

    getFeatureAt(pixel: {x: number; y: number}, { radius, renderViewId, width, height }:
        {radius?: number; renderViewId?: string; width?: number; height?: number} = {}): Promise<FeatureSelectionResult | undefined> {
        if (!this.initialized) {
            log('debug', 'Scene.getFeatureAt() called before scene was initialized');
            return Promise.resolve(undefined);
        }

        // skip selection if no interactive features
        if (this.selection_feature_count === 0) {
            return Promise.resolve(undefined);
        }
        width ??= this.view.size.css.width;
        height ??= this.view.size.css.height;
        if (width === undefined || height === undefined) return Promise.resolve(undefined);

        // only instantiate feature selection on-demand
        if (renderViewId === undefined && !this.selection) {
            this.resetFeatureSelection();
        }
        const selection = renderViewId === undefined ? this.activeSelection : this.getFeatureSelectionView(renderViewId).selection;

        // Scale point and radius to [0..1] range
        let point = {
            x: pixel.x / width,
            y: pixel.y / height
        };

        let selectionRadius: {x: number; y: number} | null;
        if (radius !== undefined && radius > 0) {
            selectionRadius  = {
                x: radius / width,
                y: radius / height
            };
        }
        else {
            selectionRadius = null;
        }

        return selection.getFeatureAt(point, { radius: selectionRadius }).
            then(selection => Object.assign(selection, { pixel })).
            catch(error => Promise.resolve({ error }));
    }

    // Query features within visible tiles, with optional filter conditions
    async queryFeatures({ filter, unique = true, group_by = null, visible = null, geometry = false }: import('../types').SceneQueryOptions = {}): Promise<import('../types').SceneFeature[] | Record<string, import('../types').SceneFeature[]>> {
        if (!this.initialized) {
            return [];
        }

        filter = Utils.serializeWithFunctions(filter);

        // Optional uniqueify criteria
        // Valid values: true, false/null, single property name, or array of property names
        unique = (typeof unique === 'string') ? [unique] : unique;
        const uniqueify_on_id = (unique === true || (Array.isArray(unique) && unique.indexOf('$id') > -1));
        const uniqueify = unique && ((obj: import('../types').SceneFeature) => {
            const properties = Array.isArray(unique) ? sliceObject(obj.properties, unique) : obj.properties;
            const id = uniqueify_on_id ? obj.id : null;
            if (geometry) {
                // when `geometry` flag is set, we need to uniqueify based on *both* feature properties and geometry
                return JSON.stringify({ geometry: obj.geometry, properties, id });
            }
            return JSON.stringify({ properties, id });
        });

        // Optional grouping criteria
        // Valid values: false/null, single property name, or array of property names
        const groupProperties = group_by;
        const group = groupProperties && ((obj: Record<string, unknown>) => {
            return typeof groupProperties === 'string' ? obj[groupProperties] : JSON.stringify(sliceObject(obj, groupProperties));
        });

        const tile_keys = this.activeTileManager.getRenderableTiles().map(t => t.key);
        const results = await WorkerBroker.postMessage<import('../types').SceneFeature[]>(this.activeWorkers, 'self.queryFeatures', { filter, visible, geometry, tile_keys });
        const features: import('../types').SceneFeature[] = [];
        const keys: Record<string, boolean> = {};
        const groups: Record<string, import('../types').SceneFeature[]> = {};

        results.forEach(r => r.forEach(feature => {
            if (uniqueify) {
                const str = uniqueify(feature);
                if (keys[str]) {
                    return;
                }
                keys[str] = true;
            }

            if (group) {
                const str = String(group(feature.properties));
                groups[str] = groups[str] || [];
                groups[str].push(feature);
            }
            else {
                features.push(feature);
            }
        }));
        return group ? groups : features; // returned grouped results, or all results
    }

    // Rebuild all tiles, without re-parsing the config or re-compiling styles
    // sync: boolean of whether to sync the config object to the worker
    // sources: optional array of data sources to selectively rebuild (by default all our rebuilt)
    rebuild({ initial = false, new_generation = true, sources = null, serialize_funcs, profile = false, fade_in = false, preserveTileCache = false, preserveTime = false }: RebuildOptions = {}) {
        return new Promise<boolean | void>((resolve, reject) => {
            // Skip rebuild if already in progress
            if (this.building) {
                // Queue up to one rebuild call at a time, only save last request
                if (this.building.queued) {
                    // notify previous request that it did not complete
                    log('debug', 'Scene.rebuild: request superceded by a newer call');
                    this.building.queued.resolve(false); // false flag indicates rebuild request was superceded
                }

                // Save queued request
                let options = { initial, new_generation, sources, serialize_funcs, profile, fade_in, preserveTileCache, preserveTime };
                this.building.queued = { resolve, reject, options };
                log('trace', 'Scene.rebuild(): queuing request');
                return;
            }

            // Admission can reject before creating a build/stage. Otherwise a
            // synchronous budget error would leave recovery queued behind a
            // build that never started and can never settle.
            if (this.terrain && preserveTileCache && preserveTime) this.reserveTerrainInputs(true);

            // Track tile build state
            this.building = { resolve, reject, initial };
            this.terrainTransaction = Boolean(this.terrain && preserveTileCache && preserveTime);
            if (this.terrainTransaction) this.activeTileManager.forEachTile(tile => tile.beginTerrainStage());

            // Profiling
            if (profile) {
                this.debug.profile('Scene.rebuild');
            }

            // Increment generation to ensure style/tile building stay in sync
            // (skipped if calling function already incremented)
            if (new_generation) {
                this.generation = ++Scene.generation;
                for (let style in this.styles) {
                    this.liveStyles[style].setGeneration(this.generation);
                }
            }

            if (this.terrainTransaction) {
                const selections = new Set(Array.from(this.selection_views.values(), state => state.selection));
                if (this.selection) selections.add(this.selection);
                for (const selection of selections) selection.invalidateReadback();
                this.last_selection_render = -1;
                for (const state of this.selection_views.values()) state.lastRender = -1;
            }

            // Update config (in case JS objects were manipulated directly)
            this.syncConfigToWorker({ serialize_funcs });
            this.resetWorkerFeatureSelection(sources);
            if (!preserveTime) this.resetTime();

            // Rebuild visible tiles
            if (!preserveTileCache) this.activeTileManager.pruneToVisibleTiles();
            this.activeTileManager.forEachTile(tile => {
                if (!sources || sources.indexOf(tile.source.name) > -1) {
                    this.activeTileManager.buildTile(tile, { fade_in });
                }
            });
            this.activeTileManager.updateTilesForView(); // picks up additional tiles for any new/changed data sources
            this.activeTileManager.checkBuildQueue();    // resolve immediately if no tiles to build
        }).then(() => {
            // Profiling
            if (profile) {
                this.debug.profileEnd('Scene.rebuild');
            }
        });
    }

    /** Record the first current-generation failure; settle only after work drains. */
    tileManagerBuildError(error: unknown) {
        if (this.building && !this.building.error) {
            this.building.error = error instanceof Error ? error : new Error(String(error));
        }
    }

    // Tile manager finished building tiles
    // TODO move to tile manager
    tileManagerBuildDone() {
        TextCanvas.pruneTextCache();

        if (this.building) {
            log('info', 'Scene: build geometry finished');
            if (this.terrainTransaction) {
                const time = performance.now();
                const build = this.building;
                if (this.terrainStagedInputLease) {
                    if (build.error) this.terrainStagedInputLease.release();
                    else {
                        this.terrainInputLease?.release(); this.terrainInputLease = this.terrainStagedInputLease;
                        this.terrainInputSnapshot = this.terrainStagedInputSnapshot;
                    }
                    this.terrainStagedInputLease = undefined; this.terrainStagedInputSnapshot = undefined;
                }
                if (!build.error && this.terrain) this.activeTileManager.startTerrainTransition(this.terrain.transitionGeneration, time);
                this.activeTileManager.forEachTile(tile => {if (build.error) tile.discardTerrainStage(); else tile.commitTerrainStage(time);});
                if (!this.building.error) this.terrainDisplayGeneration = this.generation;
                this.terrainTransaction = false;
                this.activeTileManager.publishTerrainDisplay();
                this.requestRedraw();
            }
            if (this.building.error) {
                this.building.reject(this.building.error);
            } else {
                this.logFirstBuild();
                this.building.resolve(true);
            }

            // Another rebuild queued?
            var queued = this.building.queued;
            this.building = null;
            if (queued) {
                log('debug', 'Scene: starting queued rebuild() request');
                this.rebuild(queued.options).then(queued.resolve, queued.reject);
            }
            else {
                this.activeTileManager.updateLabels(); // refresh label if nothing to rebuild
            }
        }
    }

    /**
       Load (or reload) the scene config
       @return {Promise}
    */
    async loadScene(config_source: SceneDefinition | null = null, { base_path, file_type }: SceneLoadOptions = {}) {
        this.config_source = config_source || this.config_source;

        if (typeof this.config_source === 'string') {
            this.base_path = URLs.pathForURL(base_path || this.config_source);
        }
        else {
            this.base_path = URLs.pathForURL(base_path);
        }

        // backwards compatibility for accessing base path under previous name
        // TODO: schedule for deprecation
        this.config_path = this.base_path;

        const { config, bundle, texture_nodes } = await SceneLoader.loadScene(
            this.config_source ?? {},
            { path: this.base_path, type: file_type, cameraMode: this.view.camera_mode });

        // Finalized registries are consumed by owners that validate each
        // authored source, style, camera, and light value before use.
        this.config = config as SceneRuntimeConfiguration;
        this.config_bundle = bundle;
        return { texture_nodes }; // pass along texture nodes for resolution after global property subtistution
    }

    // Add source to a scene, arguments `name` and `config` need to be provided:
    //  - If the name doesn't match a sources it will create it
    //  - the `config` obj follow the YAML scene spec, ex: ```{type: 'TopoJSON', url: "//tile.mapzen.com/mapzen/vector/v1/all/{z}/{x}/{y}.topojson"]}```
    //    that looks like:
    //
    //      scene.setDataSource("osm", {type: 'TopoJSON', url: "//tile.mapzen.com/mapzen/vector/v1/all/{z}/{x}/{y}.topojson" });
    //
    //  - also can be pass a ```data``` obj: ```{type: 'GeoJSON', data: JSObj ]}```
    //
    //      var geojson_data = {};
    //      ...
    //      scene.setDataSource("dynamic_data", {type: 'GeoJSON', data: geojson_data });
    //
    setDataSource (name: string, config: import('./scene-resource-types').SceneSourceDefinition) {
        if (!name || !config || !config.type || (!config.url && !config.tilejson && !config.data)) {
            log('error', 'No name provided or not a valid config:', name, config);
            return;
        }

        let load = (this.liveConfig.sources[name] == null);
        let source = this.liveConfig.sources[name] = Object.assign({}, config);

        // Convert raw data into blob URL
        if (source.data && typeof source.data === 'object') {
            const url = URLs.createObjectURL(new Blob([JSON.stringify(source.data)], { type: 'application/json' }));
            if (typeof url !== 'string') throw new Error('Could not create a data source URL');
            source.url = url;
            delete source.data;
        }

        if (load) {
            return this.updateConfig({ rebuild: { sources: [name] } });
        } else {
            // Source-only updates keep the lightweight rebuild path, but must
            // replace main-thread instances and notify attribution subscribers.
            this.createDataSources();
            this.trigger('update', {config: this.config});
            return this.rebuild({ sources: [name] });
        }
    }

    // (Re-)create all data sources. Re-layout view and rebuild tiles when either:
    // 1) all tiles if `rebuild_all` parameter is specified (used when loading a new scene)
    // 2) the data source has changed in a way that affects tile layout (e.g. tile size, max_zoom, etc.)
    createDataSources(rebuild_all = false) {
        const reset: string[] = []; // sources to reset
        const prev_source_names = Object.keys(this.sources);
        let source_id = 0;

        for (var name in this.liveConfig.sources) {
            const source = this.liveConfig.sources[name];
            const prev_source = this.sources[name];

            try {
                const config = { ...source, name, id: source_id++ };
                const created = DataSource.create(config, this.sources);
                if (!created) {
                    throw {};
                }
                this.sources[name] = created;
            }
            catch(e) {
                delete this.sources[name];
                const message = `Could not create data source: ${e instanceof Error ? e.message : (e && typeof e === 'object' ? Reflect.get(e, 'message') : undefined)}`;
                log('warn', `Scene: ${message}`, source);
                this.trigger('warning', { type: 'sources', source, message });
            }

            // Data source changed in a way that affects tile layout?
            // If so, we'll re-calculate the tiles in view for this source and rebuild them
            if (rebuild_all || DataSource.tileLayoutChanged(this.sources[name], prev_source)) {
                reset.push(name);
            }
            if (this.sources[name] !== prev_source) prev_source?.dispose?.();
        }

        // Sources that were removed
        prev_source_names.forEach(s => {
            if (!this.liveConfig.sources[s]) {
                this.sources[s]?.dispose?.();
                delete this.sources[s]; // TODO: remove from workers too?
                reset.push(s);
            }
        });

        // Remove tiles from sources that have changed
        if (reset.length > 0) {
            this.activeTileManager.removeTiles(tile => {
                return (reset.indexOf(tile.source.name) > -1);
            });
        }

        // Mark sources that will generate geometry tiles (any that are referenced in scene layers)
        for (let ln in this.liveConfig.layers) {
            let layer = this.liveConfig.layers[ln];
            if (layer.enabled !== false && layer.data && this.sources[layer.data.source]) {
                this.sources[layer.data.source].builds_geometry_tiles = true;
            }
        }
    }

    // Load all textures in the scene definition
    loadTextures() {
        const resource_context = this.portable_rendering ? this.resource_context : this.gl;
        return Texture.createFromObject(resource_context, this.liveConfig.textures)
            .then(() => Texture.createDefault(resource_context)); // create a 'default' texture for placeholders
    }

    // Free textures from previously loaded scene
    freePreviousTextures() {
        if (!this.prev_textures) {
            return;
        }

        this.prev_textures.forEach(t => {
            // free textures that aren't in the new scene, but are still in the global texture set
            const texture = Texture.textures[t];
            if (!this.liveConfig.textures[t] && texture instanceof Texture) {
                texture.destroy();
            }
        });
        this.prev_textures = null;
    }

    // Called (currently manually) after styles are updated in stylesheet
    updateStyles() {
        if (!this.initialized && !this.initializing) {
            throw new Error('Scene.updateStyles() called before scene was initialized');
        }

        // (Re)build styles from config
        this.styles = this.style_manager.build(this.liveConfig.styles);
        this.style_manager.initStyles(this);

        // Optionally set GL context (used when initializing or re-initializing GL resources)
        for (let style in this.styles) {
            this.liveStyles[style].setGL(this.portable_rendering ? null : this.gl, this.uniform_buffers, {
                resourceContext: (this.portable_rendering ? this.resource_context : this.gl) ?? undefined,
                shaderFactory: this.shader_factory,
                shaderProgramValidator: this.shader_program_validator,
                shaderLanguage: this.shader_language,
                portableLighting: Boolean(this.uniform_buffers.TangramLighting),
                portableLightCount: Object.keys(this.lights ?? {}).length,
                deviceShaderCompilation: this.device_shader_compilation,
                uniformBlockFactory: options => this.createUniformBuffer(options),
                meshBufferFactory: this.mesh_buffer_factory,
                textureFactory: this.texture_factory,
                deferUniformBlocks: Boolean(this.mesh_renderer),
                deferTextureBindings: Boolean(this.mesh_renderer),
                deferUniformUpdates: Boolean(this.mesh_renderer),
                maxTextureSize: this.max_texture_size
            });
        }

        this.dirty = true;
    }

    // Is scene currently animating?
    get animated () {
        // Disable animation is scene flag requests it, otherwise enable animation if any animated styles are in view
        return (this.liveConfig.scene.animated === false ?
            false :
            this.style_manager.getActiveStyles().some(s => this.liveStyles[s].animated));
    }

    // Get active camera - for public API
    getActiveCamera() {
        return this.view.getActiveCamera();
    }

    // Set active camera - for public API
    setActiveCamera(name: string) {
        return this.view.setActiveCamera(name);
    }

    // Create lighting
    createLights() {
        this.lights = {};
        this.uniform_buffers = this.uniform_buffers || {};
        if (Array.isArray(this.liveConfig.lights) && this.liveConfig.lights.length === 0) {
            this.liveConfig.scene = {...this.liveConfig.scene, lighting: 'configured'};
        }
        this.liveConfig.lights = normalizeSceneLights(this.liveConfig.lights) as SceneRuntimeConfiguration['lights'];

        if (debugSettings.wireframe) {
            Light.enabled = false; // disable lighting for wireframe mode
        }

        for (let i in this.liveConfig.lights) {
            if (!this.liveConfig.lights[i] || typeof this.liveConfig.lights[i] !== 'object') {
                continue;
            }
            let light = this.liveConfig.lights[i];
            const visible = (light.visible ?? light.luma?.visible) !== false;
            light.name = i.replace('-', '_'); // light names are injected in shaders, can't have hyphens
            if (visible) {
                const created = Light.create(this.view, light);
                if (created) this.lights[light.name] = created;
            }
        }
        // CPU-projected surfaces explicitly opt into diffuse lighting. Named
        // Tangram lights must use the same bounded WGSL path as native lights;
        // otherwise only WebGL consumes the authored light contributions.
        const projectedLighting = this.liveConfig.scene?.cpu_projection !== undefined &&
            Object.values(this.liveConfig.styles || {}).some(style =>
                style && typeof style.lighting === 'string' && ['vertex', 'fragment'].includes(style.lighting));
        const configured = this.shader_language === 'wgsl' && (projectedLighting || this.liveConfig.scene?.lighting === 'configured' ||
            Object.values(this.liveConfig.lights).some(light => light && typeof light === 'object' && 'luma' in light));
        if (configured) {
            getPortableLightUniforms(this.getLumaLightDefinitions()); // Reject resource overflow before compiling styles.
            if (!this.uniform_buffers.TangramLighting) {
                this.uniform_buffers.TangramLighting = this.createUniformBuffer({
                    name: 'TangramLighting', binding: 6, snapshotPerMesh: true,
                    uniforms: PORTABLE_LIGHT_UNIFORMS
                });
            }
        } else if (this.uniform_buffers.TangramLighting) {
            this.uniform_buffers.TangramLighting.destroy();
            delete this.uniform_buffers.TangramLighting;
        }
        Light.inject(this.lights);
    }

    /** Snapshot current light definitions after unit conversion and active-eye camera application. */
    getLumaLightDefinitions() {
        return Object.values(this.lights || {}).map(light => light.toLumaLight());
    }

    // Set background color from scene config
    setBackground() {
        const bg = this.liveConfig.scene.background;

        this.background = {};
        if (bg && bg.color) {
            this.background.color = StyleParser.createColorPropertyCache(bg.color);
        }
        if (!this.background.color) {
            this.background.color = StyleParser.createColorPropertyCache([0, 0, 0, 0]); // default background TODO: vary w/scene alpha
        }
    }

    // Update background color each frame as needed (e.g. may be zoom-interpolated)
    updateBackground () {
        const background = this.background;
        if (!background?.color) return;
        const last_color = background.computed_color;
        const color = background.computed_color = StyleParser.evalCachedColorProperty(background.color, { zoom: this.view.tile_zoom });
        if (!color) return;

        // update GL/canvas if color has changed
        if (!last_color || color.some((v, i) => last_color[i] !== v)) {
            // if background is fully opaque, set canvas background to match
            if (this.owns_gl && this.canvas && 'style' in this.canvas) {
                if (color[3] === 1) {
                    this.canvas.style.backgroundColor =
                        `rgba(${color.map(c => Math.floor(c * 255)).join(', ')})`;
                }
                else {
                    this.canvas.style.backgroundColor = 'transparent';
                }
            }

            if (!this.portable_rendering) {
                this.activeGL.clearColor(color[0], color[1], color[2], color[3]);
            }
        }
    }

    // Turn introspection mode on/off
    setIntrospection (val: boolean) {
        if (val !== this.introspection) {
            this.introspection = (val != null) ? val : false;
            this.updating++;
            return this.updateConfig({ normalize: false }).then(() => this.updating--);
        }
        return Promise.resolve();
    }

    /**
     * Returns deduplicated credits for all current sources, including TileJSON providers.
     * Hosts must display these credits and sanitize HTML before DOM insertion.
     * Metadata loading is cached by each source; failures reject instead of silently dropping credits.
     */
    async getAttributions(): Promise<string[]> {
        const metadata = await this.getSourceMetadata();
        return [...new Set(Object.values(metadata).flatMap(source => source.attributions ?? []))];
    }

    /** Resolve unified source capabilities; archive providers remain isolated in their worker. */
    async getSourceMetadata(): Promise<Record<string, TangramTileSourceMetadata>> {
        const sources = {...this.sources};
        const providerNames = Object.keys(sources).filter(name => sources[name].tile_provider);
        const metadata = Object.fromEntries(await Promise.all(Object.entries(sources)
            .filter(([name]) => !providerNames.includes(name))
            .map(async ([name, source]) => [name, await source.getMetadata()])));
        if (providerNames.length > 0) {
            if (!this.workers?.length) throw new Error('Provider metadata requires an initialized scene worker');
            const generation = this.generation;
            Object.assign(metadata, await WorkerBroker.postMessage(this.workers[0], 'self.getSourceMetadata', providerNames, generation));
            if (generation !== this.generation) throw new Error('Scene changed during metadata loading');
        }
        if (Object.keys(sources).length !== Object.keys(this.sources).length ||
            Object.keys(sources).some(name => sources[name] !== this.sources[name])) {
            throw new Error('Sources changed during metadata loading');
        }
        return metadata;
    }

    /** Detached host-kernel execution work; absent when using worker-local projection kernels. */
    getProjectionEngineStatistics(): import('../procedures/projection-batch-executor').ProjectionExecutionStatistics | undefined {
        return this.projectionAdapter?.getStatistics();
    }

    /** Return detached per-worker load diagnostics; worker-pool replacement invalidates a snapshot. */
    async getTileSourceStatistics(): Promise<TileSourceStatistics[]> {
        const workers = this.workers?.slice() ?? [];
        if (workers.length === 0) return [];
        const statistics = await WorkerBroker.postMessage<Omit<TileSourceStatistics, 'workerId'>>(workers, 'self.getTileSourceStatistics');
        const currentWorkers = this.workers;
        if (workers.length !== currentWorkers?.length || workers.some((worker, index) => worker !== currentWorkers?.[index])) {
            throw new Error('Workers changed during tile-source statistics loading');
        }
        return statistics.map((value, workerId) => ({...value, workerId}));
    }

    // Update scene config, and optionally rebuild geometry
    // rebuild can be boolean, or an object containing rebuild options to passthrough
    updateConfig({ loading = false, rebuild = true, serialize_funcs, texture_nodes = {}, normalize = true, fade_in = false }: {loading?: boolean; rebuild?: boolean | RebuildOptions; serialize_funcs?: boolean; texture_nodes?: SceneTextureNodes; normalize?: boolean; fade_in?: boolean} = {}) {
        this.generation = ++Scene.generation;
        this.updating++;

        // Apply globals, finalize textures and other resource paths if needed
        this.config = SceneLoader.applyGlobalProperties(this.liveConfig);
        const bundle = this.config_bundle;
        if (!bundle) throw new Error('Scene configuration has no resource bundle');
        if (normalize) {
            // normalize whole scene if requested - usually when user is making run-time updates to scene
            SceneLoader.normalize(this.liveConfig, bundle, texture_nodes);
        }
        SceneLoader.hoistTextureNodes(this.liveConfig, bundle, texture_nodes);

        this.trigger(loading ? 'load' : 'update', { config: this.config });

        this.withWebGLContext(() => {
            this.style_manager.init();
            this.view.reset();
            this.createLights();
            this.createDataSources(loading);
            this.loadTextures();
            this.setBackground();
            FontManager.loadFonts(this.liveConfig.fonts);

            // TODO: detect changes to styles? already (currently) need to recompile anyway when camera or lights change
            this.updateStyles();
        });

        // Optionally rebuild geometry
        let done = rebuild ?
            this.rebuild(Object.assign({ initial: loading, new_generation: false, serialize_funcs, fade_in }, typeof rebuild === 'object' && rebuild)) :
            this.syncConfigToWorker({ serialize_funcs }); // rebuild() also syncs config

        // Finish by updating bounds and re-rendering
        this.updating--;
        this.view.updateBounds();
        this.requestRedraw();

        return done.then(() => {
            this.last_render_count = 0; // force re-evaluation of selection map
            this.requestRedraw();
        });
    }

    // Serialize config and send to worker
    syncConfigToWorker({ serialize_funcs = true } = {}) {
        this.reserveTerrainInputs(this.terrainTransaction === true);
        // Shader specialization only needs the enabled flag on the main thread,
        // but its retained style objects must not pin the initial DEM forever.
        if (this.terrain) for (const style of Object.values(this.styles || {})) style.terrain = this.terrain;
        // Tell workers we're about to rebuild (so they can update styles, etc.)
        let config_serialized =
            serialize_funcs ? Utils.serializeWithFunctions(this.config) : JSON.stringify(this.config);
        return WorkerBroker.postMessage(this.activeWorkers, 'self.updateConfig', {
            config: config_serialized,
            generation: this.generation,
            introspection: this.introspection,
            projection_target: this.projectionTarget,
            terrain: this.terrain,
            shader_language: this.shader_language
        }, debugSettings);
    }

    /** Reserve worker-input copies and lazy query capacities before cloning a new field. */
    private reserveTerrainInputs(staged: boolean): void {
        const terrain = this.terrain, budget = this.terrainResourceBudget;
        if (!terrain || !budget || terrain === this.terrainInputSnapshot || terrain === this.terrainStagedInputSnapshot) return;
        // Renderer retains a submitted picking snapshot and a settled annotation
        // snapshot. Reserve both capacities even when they happen to share data.
        const bytes = terrain.byteLength * ((this.workers?.length ?? 0) + 1) + 2 * (terrain.maxQueryIndexBytes + terrain.maxProjectedQueryBytes);
        const lease = budget.reserve('retained', bytes);
        if (!lease) throw new Error('Terrain shared input/query capacity budget exceeded');
        if (staged) {
            this.terrainStagedInputLease?.release(); this.terrainStagedInputLease = lease;
            this.terrainStagedInputSnapshot = terrain;
        } else {
            this.terrainInputLease?.release(); this.terrainInputLease = lease; this.terrainInputSnapshot = terrain;
        }
    }

    // Listen to related objects
    createListeners () {
        this.listeners = {};

        this.listeners.view = {
            move: () => this.trigger('move')
        };
        this.view.subscribe(this.listeners.view);

        this.listeners.texture = {
            update: () => this.dirty = true,
            warning: (data: unknown) => this.trigger('warning', Object.assign({ type: 'textures' }, data))
        };
        Texture.subscribe(this.listeners.texture);

        this.listeners.scene_loader = {
            error: (data: unknown) => this.trigger('error', Object.assign({ type: 'scene' }, data))
        };
        SceneLoader.subscribe(this.listeners.scene_loader);
    }

    destroyListeners () {
        this.unsubscribeAll();
        if (!this.listeners) return;
        this.view.unsubscribe(this.listeners.view);
        Texture.unsubscribe(this.listeners.texture);
        SceneLoader.unsubscribe(this.listeners.scene_loader);
        this.listeners = null;
    }

    destroyFeatureSelection() {
        for (const state of this.selection_views?.values() ?? []) state.selection.destroy();
        this.selection_views?.clear();
        this.selection_view_id = null;
        if (this.selection) {
            this.activeSelection.destroy();
        }
        this.selection = null;
    }

    resetFeatureSelection() {
        this.destroyFeatureSelection();
        this.selection = this.createFeatureSelection(() => Boolean(this.building || this.selection_render_pending));
        this.last_render_count = 0; // force re-evaluation of selection map
    }

    /** Allocate one readback target/queue per eye, never a separate source feature map. */
    getFeatureSelectionView(id: string): {selection: FeatureSelection; lastRender: number; pending: boolean} {
        let state = this.selection_views.get(id);
        if (!state) {
            const selection = this.createFeatureSelection(() => Boolean(this.building || (this.selection === state?.selection ? this.selection_render_pending : state?.pending)));
            state = {selection, lastRender: -1, pending: false};
            this.selection_views.set(id, state);
            if (this.selection_view_id === id) {
                // A host may render again without calling setFrame after its query.
                this.selection = state.selection;
                this.last_selection_render = state.lastRender;
                this.selection_render_pending = state.pending;
            }
        }
        return state;
    }

    /** Choose the validated classic/device constructor without an unchecked overload cast. */
    private createFeatureSelection(lock: () => boolean): FeatureSelection {
        return this.device ? new FeatureSelection(this.gl, this.activeWorkers, lock, this.device) : new FeatureSelection(this.activeGL, this.activeWorkers, lock);
    }

    /** Select an eye's target before drawing; invalidate removed views and preserve in-flight reads. */
    setFeatureSelectionView(id: string, retainedIds: readonly string[]) {
        if (this.selection_view_id === null && this.selection) this.activeSelection.destroy();
        const previous = this.selection_view_id === null ? undefined : this.selection_views.get(this.selection_view_id);
        if (previous) {
            previous.lastRender = this.last_selection_render;
            previous.pending = this.selection_render_pending;
        }
        for (const [key, state] of this.selection_views) {
            if (!retainedIds.includes(key)) {
                state.selection.destroy();
                this.selection_views.delete(key);
            }
        }
        const state = this.selection_views.get(id);
        this.selection_view_id = id;
        this.selection = state?.selection ?? null;
        this.last_selection_render = state?.lastRender ?? -1;
        this.selection_render_pending = state?.pending ?? false;
    }

    resetWorkerFeatureSelection(sources: string[] | null = null) {
        if (this.workers) {
            WorkerBroker.postMessage(this.activeWorkers, 'self.resetFeatureSelection', sources);
        }
    }

    // Gets the current feature selection map size across all workers. Returns a promise.
    getFeatureSelectionMapSize() {
        // Only allow one fetch process to run at a time
        if (this.fetching_selection_map == null) {
            this.fetching_selection_map = WorkerBroker.postMessage<number>(this.activeWorkers, 'self.getFeatureSelectionMapSize')
                .then(sizes => {
                    this.fetching_selection_map = null;
                    return sizes.reduce((a, b) => a + b);
                });
        }
        return this.fetching_selection_map;
    }

    // Reset internal clock, mostly useful for consistent experience when changing styles/debugging
    resetTime() {
        this.start_time = +new Date();
    }

    // Fires event when rendered tile set or style changes
    updateViewComplete () {
        if ((this.render_count_changed || this.generation !== this.last_complete_generation) &&
            !this.building &&
            !this.activeTileManager.isLoadingVisibleTiles() &&
            this.activeTileManager.allVisibleTilesLabeled()) {
            this.activeTileManager.updateLabels();
            this.last_complete_generation = this.generation;
            this.trigger('view_complete', { first: (this.view_complete !== true) });
            this.view_complete = true;
        }
    }

    resetViewComplete () {
        this.last_complete_generation = null;
    }

    // Take a screenshot
    // Asynchronous because we have to wait for next render to capture buffer
    // Returns a promise
    screenshot ({ background = 'white' } = {}) {
        this.requestRedraw();
        return this.media_capture.screenshot({background});
    }

    startVideoCapture () {
        this.requestRedraw();
        return this.media_capture.startVideoCapture();
    }

    stopVideoCapture () {
        return this.media_capture.stopVideoCapture();
    }

    // Log first frame rendered (with any geometry)
    logFirstFrame() {
        if (this.last_render_count === 0 && !this.times.first_frame) {
            this.times.first_frame = (+new Date()) - this.start_time;
            log('debug', `Scene: initial frame time: ${this.times.first_frame}`);
        }
    }

    // Log completion of first scene build
    logFirstBuild() {
        if (this.times.first_build == null) {
            this.times.first_build = (+new Date()) - this.start_time;
            log('debug', `Scene: initial build time: ${this.times.first_build}`);
        }
    }

}

Scene.id = 0;         // unique id for a scene instance
Scene.generation = 0; // id that is incremented each time a scene config is re-parsed
