// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {Buffer, Device, RenderPass, Shader, Texture} from '@luma.gl/core';
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
import type {
  TangramGPUBackend,
  TangramGPUSceneOptions,
  TangramMeshBufferOptions,
  TangramMeshDrawOptions,
  TangramRenderStateOptions,
  TangramShaderLanguage,
  TangramShaderOptions,
  TangramShaderProgramOptions,
  TangramTextureOptions,
  TangramUniformBufferOptions
} from './gpu/tangram_gpu_backend.js';

export type * from './types.js';
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

export declare class HostFrame {
  constructor(options: HostFrameOptions);
  static from(frame: HostFrame | HostFrameOptions | LegacyHostFrame): HostFrame;
  static fromLegacy(frame: LegacyHostFrame): HostFrame;
  readonly viewport: Required<Viewport>;
  readonly geographicAnchor: Required<HostFrameOptions['geographicAnchor']>;
  readonly projection: NonNullable<HostFrameOptions['projection']>;
  readonly renderViews: readonly HostRenderView[];
  readonly activeRenderViewId: string;
  readonly tileBuffer: number;
  getRenderView(renderViewId?: string): HostRenderView;
}

export declare class Scene {
  static create(config: SceneDefinition, options?: RendererOptions): Scene;
  subscribe(listeners: SceneListeners): void;
  unsubscribe(listeners: SceneListeners): void;
  load(config?: SceneDefinition | null, options?: SceneLoadOptions): Promise<unknown>;
  updateConfig(options?: SceneUpdateOptions): Promise<void>;
  setDataSource(name: string, config: SceneDataSource): Promise<unknown> | undefined;
  queryFeatures(
    options?: SceneQueryOptions
  ): Promise<SceneFeature[] | Record<string, SceneFeature[]>>;
  screenshot(options?: {background?: string}): Promise<SceneScreenshot>;
  destroy(): unknown;
}

export declare class ClassicWebGLRenderer {
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
  subscribe(listeners: SceneListeners): void;
  destroy(): unknown;
}

export declare class LumaDeviceRenderer implements TangramGPUBackend {
  constructor(device: Device);
  readonly device: Device;
  readonly shaderLanguage: TangramShaderLanguage;
  readonly maxTextureSize?: number;
  getSceneOptions(): TangramGPUSceneOptions;
  createUniformBuffer(options: TangramUniformBufferOptions): Buffer;
  createMeshBuffer(options: TangramMeshBufferOptions): Buffer;
  createShader(options: TangramShaderOptions): Shader;
  validateShaderProgram(options: TangramShaderProgramOptions): void;
  createTexture(options: TangramTextureOptions): Texture;
  drawMesh(options: TangramMeshDrawOptions): boolean;
  getRenderPipelineParameters(options: TangramRenderStateOptions): import('@luma.gl/core').RenderPipelineParameters;
  destroy(): void;
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
