// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import Scene from './scene';
import HostFrame from './host_frame';
import LumaDeviceRenderer from '../gpu/luma_device_renderer';
import type View from './view';
import type {RendererOptions, RenderOptions, SceneDefinition, SceneListeners, SceneLoadOptions, TileResourceStatistics, TileSourceStatistics} from '../types';
import type {TangramLightMapping} from '../lights/light-definitions';
import type {TangramTileSourceMetadata} from '../sources/tile_source_metadata';
import {validateConcurrentTileLoads} from '../sources/decoded_tile_store';
import {normalizeProjectedBasemapOptions} from '../procedures/mesh-projector';
import {validateProjectionEngine} from '../procedures/projected-coordinate-transform';
import type {ProjectedBasemapOptions} from '../procedures/mesh-projector';
import {normalizeProjectionExecutionOptions} from '../procedures/projection-batch-executor';
import type {ProjectionExecutionStatistics} from '../procedures/projection-batch-executor';
import type {FeatureSelectionResult, FeatureSelectionOptions} from '../types';
import {Matrix4} from '@math.gl/core';
import {pickTerrainAt} from '../selection/terrain_surface';
import type {TerrainSurface, TerrainSurfaceHit} from '../selection/terrain_surface';
import {normalizeTerrainDraping, type TerrainDrapingOptions, type TerrainDrapingSnapshot} from '../procedures/terrain-draping';
import {PROJECTION_CONSTANTS} from './projection_math';
import {DrapedTerrainSurfaceSnapshot, type DrapedTerrainQueryEntry} from '../selection/draped-terrain-surface';


interface FrameOptions {renderViewId?: string}

/** Minimal scene surface needed by the host-driven renderer. */
interface RendererScene {
    /** Immutable worker input, separate from vector source residency. */
    terrain?: TerrainDrapingSnapshot;
    /** GPU-only multiplier; source heights and worker data remain physical. */
    terrainExaggeration: number;
    /** One shared morph timestamp for all eyes and collision in this frame. */
    terrainFrameTime?: number;
    /** Last atomically admitted mesh generation, independent of pending worker configuration. */
    terrainDisplayGeneration?: number;
    /** Schedule a viewport-local feature query for a subsequent render. */
    getFeatureAt(pixel: {x: number; y: number}, options: {radius?: number; renderViewId?: string; width?: number; height?: number}): Promise<FeatureSelectionResult | undefined>;
    /** Switch only selection ownership; shared workers/features remain unchanged. */
    setFeatureSelectionView?(id: string, retainedIds: readonly string[]): void;
    /** Shared source/style tile ownership across every eye. */
    tile_manager: {getResourceStatistics(): TileResourceStatistics; updateProjectedLabels(frame: HostFrame, clockwiseRotation: boolean, terrainSurface?: DrapedTerrainSurfaceSnapshot): void;
        getTerrainDrapingStatistics(terrain?: TerrainDrapingSnapshot): import('../procedures/terrain-draping').TerrainDrapingStatistics;
        getDrapedTerrainQueryEntries(time: number): DrapedTerrainQueryEntry[]} | null;
    view: View;
    config: {animated?: boolean; scene?: {cpu_projection?: unknown}} | null;
    animated: boolean;
    dirty: boolean;
    start_time: number;
    host_animation_time: number | null;
    subscribe(listeners: SceneListeners): unknown;
    load(config: SceneDefinition | null, options: SceneLoadOptions): unknown;
    /** Rebuild styled meshes without replacing source procedures or worker ownership. */
    rebuild(options: {preserveTileCache: boolean; preserveTime?: boolean}): Promise<unknown>;
    /** Retrieves current source and TileJSON provider credits for the host UI. */
    getAttributions(): Promise<string[]>;
    /** Normalized source capabilities, including worker-owned archive metadata. */
    getSourceMetadata(): Promise<Record<string, TangramTileSourceMetadata>>;
    /** Shared built-in load queue diagnostics from each worker, independent of mesh builds. */
    getTileSourceStatistics(): Promise<TileSourceStatistics[]>;
    /** Host-side kernel work, absent for the worker-local implementation. */
    getProjectionEngineStatistics(): ProjectionExecutionStatistics | undefined;
    /** Returns detached lighting descriptors for the currently active eye. */
    getLumaLightDefinitions(): TangramLightMapping[];
    resizeMap(width: number, height: number): void;
    setCameraMatrices(camera: import('../types').HostCamera): void;
    updateScene(options: {renderPass?: import('@luma.gl/core').RenderPass | null}): boolean;
    processTasks(): void;
    requestRedraw(): void;
    destroy(): unknown;
}

/**
 * Embeddable Tangram renderer driven by a host-provided frame.
 *
 * Unlike the standalone Scene path, Renderer does not create an animation loop
 * or derive camera matrices. The host owns frame scheduling and supplies an
 * active render pass together with geographic view and camera state.
 */
export default class Renderer {

    gpuBackend: LumaDeviceRenderer | null;
    device_renderer: LumaDeviceRenderer | null;
    scene: RendererScene;
    /** A destroyed scene no longer owns a tile manager. */
    private get activeTileManager(): NonNullable<RendererScene['tile_manager']> {
        if (!this.scene.tile_manager) throw new Error('Renderer scene tile manager has been destroyed');
        return this.scene.tile_manager;
    }
    host_frame: HostFrame | null;
    active_render_view_id: string | null;
    private animationFrame: unknown = null;
    private readonly submittedViews = new Set<string>();
    /** One cooperative hierarchy warm-up, shared across eyes and cancelled on surface replacement. */
    private terrainQueryPreparation?: {snapshot: DrapedTerrainSurfaceSnapshot; steps: Generator<void, void, void>};
    /** Internal settled surface identity keeps terrain visibility caches warm without changing public frame timestamps. */
    private annotationTerrainSurface?: DrapedTerrainSurfaceSnapshot;
    /** Serialize projection rebuilds so rapid selector changes cannot publish stale meshes last. */
    private projectionUpdate: Promise<void> = Promise.resolve();
    /** Failed worker geometry must be rebuilt even when restoring the prior options. */
    private projectionNeedsRebuild = false;
    /** Terrain updates serialize so worker geometry cannot commit obsolete heights last. */
    private terrainUpdate: Promise<void> = Promise.resolve();
    /** Only the latest queued snapshot is retained while an active worker rebuild drains. */
    private pendingTerrain?: TerrainDrapingSnapshot;
    /** Automatically morph from the last admitted field, not superseded host requests. */
    private pendingTerrainUsesPrevious = false;
    /** Monotonic request identity for superseded queued terrain updates. */
    private terrainRevision = 0;
    /** A failed recovery cannot expose a mixture of incompatible worker generations. */
    private terrainFailed = false;
    /** Old display feature IDs cannot be queried while workers replace their selection tables. */
    private terrainUpdating = false;
    /** Query ownership follows the last submitted draw, not a worker commit before the next frame. */
    private terrainSurfaceSnapshot: DrapedTerrainSurfaceSnapshot | null = null;
    /** Old draw buffers remain live while the worker field is staged, even with explicit previousGrids: []. */
    private terrainDisplayMinimumHeight = 0;
    /** Prevent queued mesh updates from acting on a released scene. */
    private destroyed = false;

    constructor(config: SceneDefinition, options: RendererOptions = {}) {
        validateConcurrentTileLoads(options.maxConcurrentTileLoadsPerWorker);
        validateProjectionEngine(options.projectionEngine);
        normalizeProjectionExecutionOptions(options.projectionEngineExecution);
        this.gpuBackend = options.device ? new LumaDeviceRenderer(options.device) : null;
        // Retain the historical field while integrations migrate to gpuBackend.
        this.device_renderer = this.gpuBackend;
        const device_options = this.gpuBackend ? this.gpuBackend.getSceneOptions() : {};
        this.scene = Scene.create(config, Object.assign({}, options, device_options, {
            device: this.gpuBackend ? this.gpuBackend.device : options.device,
            disableRenderLoop: true,
            cameraMode: 'external' as const
        }));
        this.terrainDisplayMinimumHeight = this.scene.terrain?.minimumHeight ?? 0;
        this.host_frame = null;
        this.active_render_view_id = null;
    }

    static create(config: SceneDefinition, options: RendererOptions = {}): Renderer {
        return new Renderer(config, options);
    }

    subscribe(listeners: SceneListeners): unknown {
        return this.scene.subscribe(listeners);
    }

    load(config: SceneDefinition | null = null, options: SceneLoadOptions = {}): unknown {
        this.terrainSurfaceSnapshot = null;
        this.annotationTerrainSurface = undefined;
        this.terrainQueryPreparation?.steps.return(); this.terrainQueryPreparation = undefined;
        return this.scene.load(config, options);
    }

    /** Rebuild displaced meshes on existing workers without refetching vector source data. */
    setTerrain(options: TerrainDrapingOptions): Promise<void> {
        if (this.destroyed || !this.scene.terrain) return Promise.reject(new Error('Terrain requires a live enabled renderer'));
        this.pendingTerrain = normalizeTerrainDraping(options);
        this.pendingTerrainUsesPrevious = options.previousGrids === undefined;
        const revision = ++this.terrainRevision;
        const update = this.terrainUpdate.then(async () => {
            if (this.destroyed) throw new Error('Cannot update a destroyed renderer');
            if (revision !== this.terrainRevision) return;
            if (!this.scene.terrain) throw new Error('Terrain must be enabled at renderer creation');
            let terrain = this.pendingTerrain;
            if (!terrain) return;
            this.pendingTerrain = undefined;
            const previous = this.scene.terrain;
            terrain = {...terrain, transitionGeneration: previous.transitionGeneration + 1};
            if (this.pendingTerrainUsesPrevious && terrain.grids.length && previous.grids.length) {
                const byteLength = terrain.byteLength + previous.grids.reduce((bytes, grid) => bytes + grid.heights.byteLength + grid.valid.byteLength, 0);
                if (byteLength > terrain.maxGridBytes) throw new Error('Terrain draping current/previous grid-byte budget exceeded');
                if (previous.grids[0].verticalDatum !== terrain.grids[0].verticalDatum) throw new Error('Terrain draping previous datum must match');
                // Only the previous current grids survive this update. Its own older
                // morph field must not permanently constrain future exaggeration.
                const minimumPreviousHeight = previous.grids.reduce((minimum, grid) => {
                    for (let index = 0; index < grid.heights.length; index++) if (grid.valid[index]) minimum = Math.min(minimum, grid.heights[index]);
                    return minimum;
                }, 0);
                terrain = {...terrain, previousGrids: previous.grids, previousGroundMeshResolution: previous.groundMeshResolution,
                    byteLength, minimumHeight: Math.min(terrain.minimumHeight, minimumPreviousHeight)};
            }
            if (terrain.minimumHeight * this.scene.terrainExaggeration <= -PROJECTION_CONSTANTS.earthRadius) throw new Error('Terrain exaggeration would invert the globe radius');
            this.scene.terrain = terrain;
            this.terrainUpdating = true;
            try {
                await this.scene.rebuild({preserveTileCache: true, preserveTime: true});
                this.terrainDisplayMinimumHeight = terrain.minimumHeight;
                this.terrainFailed = false;
                if (!this.destroyed) this.scene.requestRedraw();
            } catch (error) {
                this.scene.terrain = previous;
                this.terrainFailed = true;
                if (!this.destroyed) {
                    try {
                        // Restore worker configuration and partially replaced meshes, not only the host field.
                        await this.scene.rebuild({preserveTileCache: true, preserveTime: true});
                        this.terrainFailed = false;
                        if (!this.destroyed) this.scene.requestRedraw();
                    } catch (recoveryError) {
                        throw new AggregateError([error, recoveryError], 'Terrain update and recovery failed');
                    }
                }
                throw error;
            } finally {
                this.terrainUpdating = false;
            }
        });
        this.terrainUpdate = update.catch(() => {});
        return update;
    }

    /** Change visual relief without new source loads, mesh builds or height samples. */
    setTerrainExaggeration(value: number): void {
        if (this.destroyed || !this.scene.terrain) throw new Error('Terrain requires a live enabled renderer');
        if (!Number.isFinite(value) || value < 0 || value > 1000) throw new Error('Terrain exaggeration must be in [0, 1000]');
        if (Math.min(this.scene.terrain.minimumHeight, this.terrainDisplayMinimumHeight) * value <= -PROJECTION_CONSTANTS.earthRadius) throw new Error('Terrain exaggeration would invert the globe radius');
        if (this.scene.terrainExaggeration !== value) {this.scene.terrainExaggeration = value; this.scene.requestRedraw();}
    }

    /** Inspect resident worker preparation cost without conflating source/GPU/scratch ownership. */
    getTerrainDrapingStatistics(): import('../procedures/terrain-draping').TerrainDrapingStatistics {
        return {...this.activeTileManager.getTerrainDrapingStatistics(this.scene.terrain),
            annotationQueries: this.annotationTerrainSurface?.getStatistics()};
    }

    /** Reproject loaded ground meshes while retaining the workers, decoded tiles and source definitions. */
    setProjectedBasemapProjection(value: ProjectedBasemapOptions): Promise<void> {
        const projection = normalizeProjectedBasemapOptions(value);
        const update = this.projectionUpdate.then(async () => {
            if (this.destroyed) throw new Error('Cannot update a destroyed renderer');
            const settings = this.scene.config?.scene;
            if (!settings?.cpu_projection) throw new Error('Projection updates require a loaded CPU-projected scene');
            const previous = normalizeProjectedBasemapOptions(settings.cpu_projection);
            if (!this.projectionNeedsRebuild && JSON.stringify(previous) === JSON.stringify(projection)) return;
            settings.cpu_projection = projection;
            try {
                await this.scene.rebuild({preserveTileCache: true});
                this.projectionNeedsRebuild = false;
                if (!this.destroyed) this.scene.requestRedraw();
            } catch (error) {
                this.projectionNeedsRebuild = true;
                settings.cpu_projection = previous;
                throw error;
            }
        });
        // A failed update must not poison later corrections.
        this.projectionUpdate = update.catch(() => {});
        return update;
    }

    /** Returns source credits without coupling the renderer to DOM, deck.gl or Leaflet controls. */
    getAttributions(): Promise<string[]> {
        return this.scene.getAttributions();
    }

    /**
     * Query interactive draws in top-origin CSS pixels, optionally routed to a named
     * render view or resolved from full-canvas coordinates in the current HostFrame.
     * The host must continue rendering while this asynchronous GPU/worker query is
     * pending. This does not implement deck.gl picking or terrain intersections.
     */
    getFeatureAt(pixel: {x: number; y: number}, options: FeatureSelectionOptions = {}): Promise<FeatureSelectionResult | undefined> {
        if (this.destroyed) return Promise.reject(new Error('Cannot query a destroyed renderer'));
        if (this.terrainUpdating) return this.terrainUpdate.then(() => this.getFeatureAt(pixel, options));
        if (this.terrainFailed) return Promise.reject(new Error('Terrain generation requires a successful correction'));
        if (![pixel.x, pixel.y, options.radius ?? 0].every(Number.isFinite) || (options.radius ?? 0) < 0) {
            return Promise.reject(new Error('Selection coordinates and non-negative radius must be finite'));
        }
        let resolved;
        try {
            if (!this.host_frame && (options.renderViewId !== undefined || options.coordinateSpace === 'canvas')) {
                throw new Error('View-aware selection requires a HostFrame');
            }
            resolved = this.host_frame?.resolveSelectionPoint(pixel, options, this.active_render_view_id ?? undefined);
        } catch (error) {
            return Promise.reject(error);
        }
        if (resolved === null) return Promise.resolve({feature: null, changed: false, pixel: {...pixel}});
        const pending = this.scene.getFeatureAt(resolved?.pixel ?? {...pixel}, {radius: options.radius,
            ...(resolved ? {renderViewId: resolved.view.id, width: resolved.view.viewport.width, height: resolved.view.viewport.height} : {})});
        this.scene.requestRedraw();
        return resolved ? pending.then(result => result && {...result, pixel: {...pixel}, renderViewId: resolved.view.id}) : pending;
    }

    /** Capture exact admitted ground triangles at the last submitted stereo frame time. */
    getDrapedTerrainSurface(): DrapedTerrainSurfaceSnapshot | null {
        return this.destroyed || this.terrainFailed ? null : this.terrainSurfaceSnapshot;
    }

    /** Query supplied terrain, or the exact admitted draped ground; never substitute a flat surface. */
    getTerrainAt(pixel: {x: number; y: number}, surface?: TerrainSurface, options: FeatureSelectionOptions = {}): TerrainSurfaceHit | null {
        if (this.destroyed) throw new Error('Cannot query a destroyed renderer');
        if (!this.host_frame) throw new Error('Terrain selection requires a HostFrame');
        const resolved = surface ?? this.getDrapedTerrainSurface();
        return resolved ? pickTerrainAt(this.host_frame, pixel, resolved, options, this.active_render_view_id ?? undefined) : null;
    }

    /** Resolve source capabilities without publishing archive handles or changing source policy. */
    getSourceMetadata(): Promise<Record<string, TangramTileSourceMetadata>> {
        return this.scene.getSourceMetadata();
    }

    /** Inspect source procedures without confusing their slots with renderer mesh-build slots. */
    getTileSourceStatistics(): Promise<TileSourceStatistics[]> {
        return this.scene.getTileSourceStatistics();
    }

    /** Inspect cooperative host projection work without conflating it with source/GPU residency. */
    getProjectionEngineStatistics(): ProjectionExecutionStatistics | undefined {
        return this.scene.getProjectionEngineStatistics();
    }

    /** Resolve Tangram lights into luma.gl definitions, retaining non-equivalent Tangram extensions. */
    getLumaLightDefinitions(): TangramLightMapping[] {
        return this.scene.getLumaLightDefinitions();
    }

    /** Current build queue and completed-cache mesh residency; does not include textures or driver memory. */
    getTileResourceStatistics(): TileResourceStatistics {
        return this.activeTileManager.getResourceStatistics();
    }

    /**
     * Applies host-owned viewport, geographic, and camera state.
     */
    setFrame(frame: unknown, {renderViewId}: FrameOptions = {}): HostFrame {
        const host_frame = HostFrame.from(frame);
        if (this.scene.config && Boolean(this.scene.config.scene?.cpu_projection) !== (host_frame.projection.type === 'projected')) {
            throw new Error('CPU-projected scene meshes and HostFrame projection must match');
        }
        const render_view = host_frame.getRenderView(renderViewId);
        const viewport = render_view.viewport;
        const render_view_changed = this.active_render_view_id !== render_view.id;

        this.scene.view.applyHostFrame(host_frame, () => {
            if (this.scene.view.size.css.width !== viewport.width || this.scene.view.size.css.height !== viewport.height) {
                this.scene.resizeMap(viewport.width, viewport.height);
            }
        }, () => {
            // CPU-projected shaders bypass the tile model-view transform. Compose the
            // host view here so rendering, collision and selection use the same camera.
            this.scene.setCameraMatrices(host_frame.projection.type === 'projected' ? {
                ...render_view.camera, view: new Float64Array(new Matrix4()),
                projection: new Float64Array(new Matrix4(Array.from(render_view.camera.projection))
                    .multiplyRight(Array.from(render_view.camera.view)))
            } : render_view.camera);
            this.host_frame = host_frame;
            this.active_render_view_id = render_view.id;
        });
        if (host_frame !== this.animationFrame) {
            this.animationFrame = host_frame;
            this.submittedViews.clear();
            this.scene.host_animation_time = host_frame.animationTime ?? Math.max(0, (Date.now() - this.scene.start_time) / 1000);
        }
        if (render_view_changed) {
            this.scene.dirty = true;
        }
        this.scene.setFeatureSelectionView?.(render_view.id, host_frame.renderViews.map(view => view.id));
        return host_frame;
    }

    /**
     * Updates and draws Tangram into a host-owned render pass.
     */
    render({frame, renderPass = null, renderViewId, force = false}: Omit<RenderOptions, 'frame'> & {frame?: HostFrame | RenderOptions['frame']} = {}): boolean {
        if (this.destroyed || this.terrainFailed) return false;
        if (frame) {
            this.setFrame(frame, { renderViewId });
        }
        else if (renderViewId) {
            if (!this.host_frame) {
                throw new Error('Renderer requires a HostFrame before selecting a render view');
            }
            this.setFrame(this.host_frame, { renderViewId });
        }
        if (this.host_frame && this.active_render_view_id) {
            // Loading/reloading clears scene selection ownership, not the retained host frame.
            this.scene.setFeatureSelectionView?.(this.active_render_view_id,
                this.host_frame.renderViews.map(view => view.id));
        }
        if (force) {
            this.scene.dirty = true;
        }
        // Submitting an eye again starts the next logical frame, even when its previous draw was skipped.
        if (this.active_render_view_id && this.submittedViews.has(this.active_render_view_id)) {
            this.submittedViews.clear();
            if (this.host_frame) {
                this.scene.host_animation_time = this.host_frame.animationTime ?? Math.max(0, (Date.now() - this.scene.start_time) / 1000);
            }
        }
        if (this.host_frame) {
            if (!this.submittedViews.size) {
                this.scene.terrainFrameTime = performance.now();
                this.advanceTerrainQueryPreparation();
            }
            let surface: DrapedTerrainSurfaceSnapshot | undefined;
            if (this.scene.terrain?.occludeAnnotations && this.host_frame.projection.type !== 'projected') {
                const entries = this.activeTileManager.getDrapedTerrainQueryEntries(this.scene.terrainFrameTime ?? performance.now());
                const candidate = new DrapedTerrainSurfaceSnapshot(this.host_frame.projection.type, entries, this.scene.terrainDisplayGeneration ?? 0,
                    this.scene.terrainFrameTime ?? performance.now(), this.scene.terrainExaggeration, this.scene.terrain.maxQueryIndexBytes, this.scene.terrain.maxProjectedQueryBytes);
                if (this.annotationTerrainSurface?.displayKey !== candidate.displayKey) this.annotationTerrainSurface = candidate;
                surface = this.annotationTerrainSurface;
            }
            else this.annotationTerrainSurface = undefined;
            this.activeTileManager.updateProjectedLabels(this.host_frame, this.gpuBackend?.device.type !== 'webgpu', surface);
        }
        const rendered = this.scene.updateScene({ renderPass });
        if (rendered && this.scene.terrain && this.host_frame && this.host_frame.projection.type !== 'projected') {
            const time = this.scene.terrainFrameTime ?? performance.now();
            const entries = this.activeTileManager.getDrapedTerrainQueryEntries(time);
            this.terrainSurfaceSnapshot = new DrapedTerrainSurfaceSnapshot(this.host_frame.projection.type, entries, this.scene.terrainDisplayGeneration ?? 0, time, this.scene.terrainExaggeration, this.scene.terrain.maxQueryIndexBytes, this.scene.terrain.maxProjectedQueryBytes);
        }
        if (this.submittedViews.size === 0) {
            this.scene.processTasks();
        }
        if (this.active_render_view_id) {
            this.submittedViews.add(this.active_render_view_id);
        }
        if (rendered && this.scene.config && this.scene.animated) {
            this.scene.requestRedraw();
        }
        return rendered;
    }

    /** Progress exact settled-query acceleration without charging a second stereo eye another slice. */
    private advanceTerrainQueryPreparation(): void {
        const snapshot = this.annotationTerrainSurface ?? this.terrainSurfaceSnapshot;
        const budget = this.scene.terrain?.queryPreparationBudgetMs ?? 0;
        if (!snapshot || !budget) {
            this.terrainQueryPreparation?.steps.return(); this.terrainQueryPreparation = undefined;
            return;
        }
        if (this.terrainQueryPreparation?.snapshot.displayKey !== snapshot.displayKey) {
            this.terrainQueryPreparation?.steps.return();
            this.terrainQueryPreparation = {snapshot, steps: snapshot.prepareQueryIndexSteps()};
        }
        const preparation = this.terrainQueryPreparation;
        const started = performance.now();
        do {
            if (preparation.steps.next().done) {this.terrainQueryPreparation = undefined; return;}
        } while (performance.now() - started < budget);
        this.scene.requestRedraw();
    }

    destroy() {
        this.annotationTerrainSurface = undefined;
        this.terrainQueryPreparation?.steps.return(); this.terrainQueryPreparation = undefined;
        this.destroyed = true;
        this.pendingTerrain = undefined;
        this.terrainSurfaceSnapshot = null;
        this.terrainRevision++;
        try {
            return this.scene.destroy();
        }
        finally {
            if (this.gpuBackend) {
                this.gpuBackend.destroy();
            }
        }
    }

}
