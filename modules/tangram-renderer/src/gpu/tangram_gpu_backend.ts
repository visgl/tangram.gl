// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {
  Buffer,
  BufferLayout,
  Bindings,
  Device,
  ExternalImage,
  RenderPass,
  RenderPipelineParameters,
  PrimitiveTopology,
  Shader,
  Texture,
  UniformValue
} from '@luma.gl/core';

/** Shader languages supported by Tangram's portable GPU backend. */
export type TangramShaderLanguage = 'glsl' | 'wgsl';

/** Options used to allocate a Tangram uniform buffer. */
export type TangramUniformBufferOptions = {
  id: string;
  usage: 'uniform';
  byteLength: number;
};

/** Options used to allocate a Tangram vertex or index buffer. */
export type TangramMeshBufferOptions = {
  id: string;
  usage: 'vertex' | 'index';
  data: ArrayBuffer | ArrayBufferView;
  indexType?: 'uint16' | 'uint32';
};

/** Options used to compile one stage of a Tangram shader program. */
export type TangramShaderOptions = {
  id: string;
  language?: TangramShaderLanguage;
  stage: 'vertex' | 'fragment';
  source: string;
  entryPoint?: string;
};

/** Options used to validate a linked Tangram shader pair. */
export type TangramShaderProgramOptions = {
  id: string;
  vertexShader: Shader;
  fragmentShader: Shader;
};

/** Options used to allocate and initialize a Tangram texture. */
export type TangramTextureOptions = {
  id: string;
  width: number;
  height: number;
  data?: ArrayBuffer | ArrayBufferView | ExternalImage;
  filtering?: 'nearest' | 'linear' | 'mipmap';
  repeat?: boolean;
  flipY?: boolean;
  premultipliedAlpha?: boolean;
};

/** Portable mesh submission passed from Tangram scene traversal to a GPU backend. */
export type TangramMeshDrawOptions = {
  mesh: TangramDrawableMesh;
  program: TangramDrawableProgram;
  renderPass: RenderPass;
  renderState?: RenderPipelineParameters;
  visibleTime: number;
};

/** GPU resources and layout needed to submit one portable mesh. */
export type TangramMeshDrawDescriptor = {
  topology: PrimitiveTopology;
  vertexCount: number;
  indexCount: number;
  vertexBuffer: Buffer;
  indexBuffer: Buffer | null;
  bufferLayout: BufferLayout & {attributes: NonNullable<BufferLayout['attributes']>};
  staticAttributes: {attribute: string; value: readonly number[]}[];
};

/** Scene-owned mesh state consumed by the device backend. */
export type TangramDrawableMesh = {
  id: string | number;
  vertex_layout: object;
  uniforms?: Record<string, unknown>;
  getDrawDescriptor(): TangramMeshDrawDescriptor;
};

/** Mutable uniform block whose contents can be snapshotted per encoded draw. */
export type TangramDrawableUniformBlock = {
  snapshot_per_mesh: boolean;
  data: ArrayBuffer | null;
  byteLength: number;
};

/** Shader and uniform operations required by the device submission path. */
export type TangramDrawableProgram = {
  id: string | number;
  name?: string;
  vertex_shader_resource: Shader;
  fragment_shader_resource: Shader;
  uniform_blocks?: Record<string, TangramDrawableUniformBlock>;
  saveUniforms(uniforms: Record<string, unknown>): void;
  setUniforms(uniforms: Record<string, unknown>, resetTextureUnit: boolean): void;
  restoreUniforms(uniforms: Record<string, unknown>): void;
  uniform(method: string, name: string, value: number): void;
  getBindings(): Bindings;
  getUniformValues(): Record<string, UniformValue>;
};

/** Tangram blend modes accepted by the portable renderer. */
export type TangramBlendMode =
  | false
  | 'opaque'
  | 'overlay'
  | 'inlay'
  | 'translucent'
  | 'add'
  | 'multiply';

/** Normalized Tangram state used to create a luma.gl render pipeline. */
export type TangramRenderStateOptions = {
  depthTest: boolean;
  depthWrite: boolean;
  cullFace: boolean;
  blend: TangramBlendMode;
};

/**
 * Scene integration hooks supplied by a portable Tangram GPU backend.
 *
 * This compatibility shape keeps the current Scene and Style internals isolated
 * while their individual resource wrappers are migrated to the backend contract.
 */
export type TangramGPUSceneOptions = {
  enableUniformBuffers: true;
  deviceShaderCompilation: true;
  shaderLanguage: TangramShaderLanguage;
  uniformBufferFactory: (options: TangramUniformBufferOptions) => Buffer;
  shaderFactory: (options: TangramShaderOptions) => Shader;
  shaderProgramValidator: (options: TangramShaderProgramOptions) => void;
  meshBufferFactory: (options: TangramMeshBufferOptions) => Buffer;
  textureFactory: (options: TangramTextureOptions) => Texture;
  maxTextureSize?: number;
  meshRenderer: TangramGPUBackend;
};

/**
 * Renderer-independent boundary for Tangram GPU resource ownership and drawing.
 *
 * `LumaDeviceRenderer` is the current and only implementation. It owns the
 * resources it creates but does not own the host device or render pass. The
 * interface intentionally contains no deck.gl types.
 */
export interface TangramGPUBackend {
  /** Host-owned luma.gl device used by this backend. */
  readonly device: Device;

  /** Shader language compiled by this backend. */
  readonly shaderLanguage: TangramShaderLanguage;

  /** Maximum supported two-dimensional texture dimension, when known. */
  readonly maxTextureSize?: number;

  /** Returns the compatibility hooks consumed by current Scene internals. */
  getSceneOptions(): TangramGPUSceneOptions;

  /** Allocates a uniform buffer. */
  createUniformBuffer(options: TangramUniformBufferOptions): Buffer;

  /** Allocates a vertex or index buffer. */
  createMeshBuffer(options: TangramMeshBufferOptions): Buffer;

  /** Compiles a shader stage. */
  createShader(options: TangramShaderOptions): Shader;

  /** Validates a linked shader pair. */
  validateShaderProgram(options: TangramShaderProgramOptions): void;

  /** Allocates and initializes a texture. */
  createTexture(options: TangramTextureOptions): Texture;

  /** Submits one mesh to a host-owned render pass. */
  drawMesh(options: TangramMeshDrawOptions): boolean;

  /** Translates Tangram state into luma.gl render-pipeline parameters. */
  getRenderPipelineParameters(options: TangramRenderStateOptions): RenderPipelineParameters;

  /** Releases resources owned by this backend. */
  destroy(): void;
}
