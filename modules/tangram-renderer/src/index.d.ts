// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {
  HostFrameOptions,
  HostRenderView,
  LegacyHostFrame,
  RendererOptions,
  RenderOptions,
  SceneDataSource,
  SceneDefinition,
  SceneListeners,
  SceneLoadOptions,
  SceneQueryOptions,
  SceneScreenshot,
  SceneFeature,
  SceneUpdateOptions,
  Viewport
} from './types.js';
export type {
  TangramGPUBackend,
  TangramGPUSceneOptions,
  TangramMeshBufferOptions,
  TangramMeshDrawOptions,
  TangramMeshDrawDescriptor,
  TangramDrawableMesh,
  TangramDrawableProgram,
  TangramDrawableUniformBlock,
  TangramRenderStateOptions,
  TangramShaderLanguage,
  TangramShaderOptions,
  TangramShaderProgramOptions,
  TangramTextureOptions,
  TangramUniformBufferOptions
} from './gpu/tangram_gpu_backend.js';

export type {Matrix4, Vector3, SceneDefinition, Viewport, GeographicAnchor, HostProjection, HostCamera, HostRenderView, HostTileLODOptions, HostTileResourceOptions, TileResourceStatistics, TileSourceStatistics, HostFrameOptions, LegacyHostFrame, RendererOptions, SceneLoadOptions, SceneUpdateOptions, SceneDataSource, SceneFeature, SceneQueryOptions, SceneScreenshot, RenderOptions, SceneConfigEvent, SceneErrorEvent, SceneEventMap, SceneListener, SceneListeners, WorkerRequest, WorkerResponse, WorkerBrokerMessage} from './types.js';
export {
  WebMercatorGlobeVisibilityAdapter,
  WebMercatorVisibilityAdapter
} from './scene/visibility_adapter.js';
export type {
  CalculatedViewBounds,
  GlobeVisibilityLODAdapter,
  GlobeVisibilityViewState,
  VisibilityLODAdapter,
  VisibilityViewState
} from './scene/visibility_adapter.js';

import HostFrame from './scene/host_frame';
import LumaDeviceRenderer from './gpu/luma_device_renderer.js';
export {HostFrame};
export {LumaDeviceRenderer};
export {calculatePlanarGroundBounds, calculatePlanarVolumeBounds} from './scene/ground_footprint';
export {convertLumaLight, mapTangramLight} from './lights/light-definitions';
export type {ResolvedTangramLight, TangramLightMapping, TangramLight, TangramAmbientLight,
    TangramDirectionalLight, TangramPointLight, TangramSpotLight, TangramLightExtensions,
    TangramPositionalLightExtensions, TangramLightColor, NormalizedTangramLight} from './lights/light-definitions';
export type {Light as LumaLight} from '@luma.gl/shadertools';
export type {TangramTileSourceMetadata} from './sources/tile_source_metadata';
export type {MeshProjectionStatistics} from './procedures/mesh-projector';
export type {ProjectionExecutionOptions, ProjectionExecutionStatistics} from './procedures/projection-batch-executor.js';

export declare class Scene {
  static create(config: SceneDefinition, options?: RendererOptions): Scene;
  subscribe(listeners: SceneListeners): void;
  unsubscribe(listeners: SceneListeners): void;
  load(config?: SceneDefinition | null, options?: SceneLoadOptions): Promise<unknown>;
  updateConfig(options?: SceneUpdateOptions): Promise<void>;
  /** Deduplicated source/TileJSON credits; HTML must be sanitized by the displaying host. */
  getAttributions(): Promise<string[]>;
  /** Normalized TileJSON/archive capabilities, preserving authored source overrides. */
  getSourceMetadata(): Promise<Record<string, import('./sources/tile_source_metadata').TangramTileSourceMetadata>>;
  /** Detached decoded acquisition diagnostics from each current worker. */
  getTileSourceStatistics(): Promise<import('./types').TileSourceStatistics[]>;
  /** Detached cooperative host execution counters; absent for worker-local kernels. */
  getProjectionEngineStatistics(): import('./procedures/projection-batch-executor.js').ProjectionExecutionStatistics | undefined;
  /** Current-eye luma.gl definitions with exact Tangram-only shading extensions. */
  getLumaLightDefinitions(): import('./lights/light-definitions').TangramLightMapping[];
  setDataSource(name: string, config: SceneDataSource): Promise<unknown> | undefined;
  queryFeatures(
    options?: SceneQueryOptions
  ): Promise<SceneFeature[] | Record<string, SceneFeature[]>>;
  screenshot(options?: {background?: string}): Promise<SceneScreenshot>;
  destroy(): unknown;
}

export declare class ClassicWebGLRenderer {
  /** Reproject loaded meshes without replacing workers; rejects failed builds and permits subsequent recovery. */
  setProjectedBasemapProjection(projection: import('./procedures/mesh-projector').ProjectedBasemapOptions): Promise<void>;
  constructor(config: SceneDefinition, options?: RendererOptions);
  static create(config: SceneDefinition, options?: RendererOptions): ClassicWebGLRenderer;
  readonly scene: Scene;
  readonly gpuBackend: LumaDeviceRenderer | null;
  setFrame(
    frame: HostFrame | HostFrameOptions | LegacyHostFrame,
    options?: {renderViewId?: string}
  ): HostFrame;
  render(options?: RenderOptions): boolean;
  load(config?: SceneDefinition | null, options?: SceneLoadOptions): Promise<unknown>;
  /** Current source/TileJSON credits for the host's attribution UI. */
  getAttributions(): Promise<string[]>;
  /** Current source capabilities without exposing worker/archive ownership. */
  getSourceMetadata(): Promise<Record<string, import('./sources/tile_source_metadata').TangramTileSourceMetadata>>;
  /** Per-worker built-in source-procedure slots; separate from renderer mesh-build accounting. */
  getTileSourceStatistics(): Promise<import('./types').TileSourceStatistics[]>;
  /** Detached cooperative host execution counters; absent for worker-local kernels. */
  getProjectionEngineStatistics(): import('./procedures/projection-batch-executor.js').ProjectionExecutionStatistics | undefined;
  /** Current-eye luma.gl definitions with exact Tangram-only shading extensions. */
  getLumaLightDefinitions(): import('./lights/light-definitions').TangramLightMapping[];
  subscribe(listeners: SceneListeners): void;
  /** Shared worker queue and completed-cache mesh bytes; excludes texture/CPU/driver memory. */
  getTileResourceStatistics(): import('./types.js').TileResourceStatistics;
  destroy(): unknown;
}

export declare const Renderer: typeof ClassicWebGLRenderer;
export declare const debug: Record<string, unknown>;
export declare const version: string;

declare const Tangram: {
  Scene: typeof Scene;
  ClassicWebGLRenderer: typeof ClassicWebGLRenderer;
  Renderer: typeof ClassicWebGLRenderer;
  HostFrame: typeof HostFrame;
  LumaDeviceRenderer: typeof LumaDeviceRenderer;
  debug: typeof debug;
  version: string;
};

export default Tangram;
export type {ProjectionEngine, ProjectionEngineOptions, ProjectionEngineTransform} from './types.js';
