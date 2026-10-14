// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type DataSource from '../sources/data_source';
import type Material from '../lights/material';
import type ShaderProgram from '../gl/shader_program';
import type VertexLayout from '../gl/vertex_layout';
import type VertexData from '../gl/vertex_data';
import type UniformBuffer from '../gl/uniform_buffer';
import type {UniformBufferOptions} from '../gl/uniform_buffer';
import type {MeshOptions, MeshElementData} from '../gl/mesh-types';
import type {TangramGPUSceneOptions} from '../gpu/tangram_gpu_backend';
import type {TileMeshVariant, TileMeshPayload, LayerDebugCounts, WorkerBuildTile} from '../tile/tile-build-types';
import type {PropertyCache, PropertyContext, StyleFeature} from './property-types';
import type {GeometryMeshVariant} from './geometry-style-types';
import type {SceneDefinition} from '../scene/scene-resource-types';
import type {TerrainDrapingSnapshot} from '../procedures/terrain-draping';
import type {ProjectedBasemapOptions} from '../procedures/mesh-projector';
import type VBOMesh from '../gl/vbo_mesh';
import type {MeshRenderOptions} from '../gl/mesh-types';
import type {VertexAttribute} from '../gl/vertex-types';

/** Worker geometry channels used by the base dispatcher and concrete styles. */
export type BuildGeometry = import('./text/text-types').TextGeometry;
/** Source-normalized feature with geometry available to the style dispatcher. */
export interface BuildFeature extends StyleFeature {geometry: BuildGeometry;}
/** Evaluator state includes tile ownership and matching authored layers. */
export interface BuildContext extends PropertyContext {tile: StyleFinalizeTile & Pick<WorkerBuildTile, 'generation'> & {debug?: WorkerBuildTile['debug']}; layers?: string[];}
/** Finalization requires tile address only when a projection or raster consumes it. */
export type StyleFinalizeTile = Pick<WorkerBuildTile, 'id'> & Partial<Pick<WorkerBuildTile, 'coords' | 'min' | 'max' | 'style_z' | 'overzoom2' | 'rasters' | 'source' | 'key' | 'canceled'>>;
/** Mutable draw group at the cache boundary; extension values remain unresolved. */
export interface BuildDraw {
    layers?: string[];
    group?: string;
    order?: unknown;
    blend_order?: number;
    preprocessed?: boolean;
    interactive?: unknown;
    attributes?: Record<string, unknown>;
}
/** Shared scratch values populated incrementally by concrete feature parsers. */
export interface BuildFeatureStyle {
    order?: unknown;
    interactive?: unknown;
    selection_color?: number[];
    attributes?: Record<string, unknown>;
}
/** Authored material channels before the base lifecycle creates a Material owner. */
export interface AuthoredStyleMaterial {
    emission?: unknown;
    ambient?: unknown;
    diffuse?: unknown;
    specular?: number | number[] | {amount?: number | number[]};
    normal?: unknown;
}
/** A mesh is mutable while accumulating geometry, then owns transferable bytes. */
export interface BuildMesh<Buffer extends VertexData | Uint8Array = VertexData> extends Omit<TileMeshPayload, 'vertex_data' | 'variant'> {
    vertex_data: Buffer;
    variant: GeometryMeshVariant & TileMeshVariant;
}
/** Per-tile style output shared by collision, raster loading, and serialization. */
export interface BuildTileData<Buffer extends VertexData | Uint8Array = VertexData> extends MeshOptions {
    meshes: Record<string, BuildMesh<Buffer>>;
    uniforms: Record<string, unknown>;
    textures: string[];
}
/** Configuration provided to inherited style initialization in either thread. */
export interface StyleInitOptions {
    generation?: number;
    styles?: Record<string, import('./style-mixing-types').ManagedStyle> | null;
    sources?: Record<string, DataSource>;
    introspection?: boolean;
    shader_language?: 'glsl' | 'wgsl';
    config?: SceneDefinition | null;
    projection_target?: string;
    terrain?: TerrainDrapingSnapshot;
}
/** Renderer hooks passed to the base resource lifecycle. */
export interface StyleGLOptions extends Omit<Partial<TangramGPUSceneOptions>, 'enableUniformBuffers' | 'deviceShaderCompilation'> {
    enableUniformBuffers?: boolean;
    deviceShaderCompilation?: boolean;
    resourceContext?: object;
    uniformBlockFactory?: (options: UniformBufferOptions) => UniformBuffer;
    deferUniformBlocks?: boolean;
    deferTextureBindings?: boolean;
    deferUniformUpdates?: boolean;
    portableLightCount?: number;
    portableLighting?: boolean;
}
/** Shader customization after style-manager mixin normalization. */
export interface RuntimeStyleShaders {
    defines?: Record<string, unknown>;
    uniforms?: Record<string, unknown>;
    attributes?: Record<string, {type?: string; varying?: boolean}>;
    blocks?: Record<string, string[] | null>;
    block_scopes?: Record<string, (string | null)[] | null>;
    extensions?: string | string[];
}
/** State written by initialization and released by the inherited lifecycle. */
export interface StyleState {
    name: string;
    base?: string;
    generation: number | undefined;
    styles: Record<string, import('./style-mixing-types').ManagedStyle> | null | undefined;
    sources: Record<string, DataSource>;
    shader_language: 'glsl' | 'wgsl';
    projection_target?: string;
    terrain?: TerrainDrapingSnapshot;
    cpu_projection?: ProjectedBasemapOptions;
    screen_space_labels: boolean;
    defines: Record<string, unknown>;
    shaders: RuntimeStyleShaders;
    introspection: boolean;
    selection: boolean;
    compile_setup: boolean;
    program: ShaderProgram | null;
    selection_program: ShaderProgram | null;
    feature_style: BuildFeatureStyle;
    vertex_template: number[];
    tile_data: Record<string | number, BuildTileData | null>;
    stencil_proxy_tiles: boolean;
    variants: Record<string | number, GeometryMeshVariant & TileMeshVariant>;
    vertex_layouts: Record<string | number, VertexLayout>;
    blend: 'opaque' | 'translucent' | 'add' | 'multiply' | 'inlay' | 'overlay';
    blend_order?: number;
    material: Material | AuthoredStyleMaterial;
    lighting?: string | boolean;
    raster?: string | boolean;
    draw?: Record<string, unknown>;
    initialized: boolean;
    main_thread_target: string;
    gl: WebGLRenderingContext | null;
    resource_context: object | null;
    uniform_blocks: Record<string, UniformBuffer> | null;
    uniform_block_factory: StyleGLOptions['uniformBlockFactory'] | null;
    shader_factory?: TangramGPUSceneOptions['shaderFactory'];
    shader_program_validator?: TangramGPUSceneOptions['shaderProgramValidator'];
    mesh_buffer_factory?: TangramGPUSceneOptions['meshBufferFactory'];
    texture_factory?: TangramGPUSceneOptions['textureFactory'];
    device_shader_compilation: boolean;
    defer_uniform_blocks: boolean;
    defer_texture_bindings: boolean;
    defer_uniform_updates: boolean;
    max_texture_size: number;
    portable_material_buffer: UniformBuffer | null;
    portable_lighting_mode?: 'vertex' | 'fragment' | false;
    portable_light_count?: number;
    vertex_shader_src: string;
    fragment_shader_src: string;
    getWGSLShaderSource?(selection?: boolean): string;
}
/** Concrete styles inherit these checked methods, retaining prototype ownership. */
export type StyleRuntime = StyleState & StyleMethods;
/** Checked inherited operations; concrete geometry hooks may return no value on the abstract base. */
export interface StyleMethods {
    init(options?: StyleInitOptions): void;
    destroy(): void;
    reset(): void;
    baseStyle(): string;
    setGeneration(generation: number | undefined): void;
    startData(tile: Pick<WorkerBuildTile, 'id'>): void;
    endData(tile: StyleFinalizeTile): Promise<BuildTileData<Uint8Array> | null>;
    hasDataForTile(tile: Pick<WorkerBuildTile, 'id'>): boolean;
    getTileMesh(tile: Pick<WorkerBuildTile, 'id'>, variant: GeometryMeshVariant & TileMeshVariant): BuildMesh;
    vertexLayoutForMeshVariant(variant: GeometryMeshVariant & TileMeshVariant): VertexLayout | undefined;
    meshVariantTypeForDraw(draw: BuildDraw): (GeometryMeshVariant & TileMeshVariant) | undefined;
    addFeature(feature: BuildFeature, draw: BuildDraw, context: BuildContext): void;
    buildGeometry(geometry: BuildGeometry, style: BuildFeatureStyle, context: BuildContext): number | undefined;
    parseFeature(feature: BuildFeature, draw: BuildDraw, context: BuildContext): BuildFeatureStyle | undefined;
    _parseFeature(feature: BuildFeature, draw: BuildDraw, context: BuildContext): BuildFeatureStyle | undefined;
    preprocess(draw: BuildDraw): BuildDraw | undefined;
    _preprocess(draw: BuildDraw): BuildDraw | undefined;
    parseOrder(order: unknown, context: PropertyContext): unknown;
    scaleOrder(order: number): number;
    parseColor(color: PropertyCache | null | undefined, context: PropertyContext): number[] | undefined;
    buildPolygons(polygons: Extract<BuildGeometry, {type: 'MultiPolygon'}>['coordinates'], style: BuildFeatureStyle, context: BuildContext): number;
    buildLines(lines: number[][][], style: BuildFeatureStyle, context: BuildContext): number;
    buildPoints(points: number[][], style: BuildFeatureStyle, context: BuildContext): number;
    setGL(context: WebGLRenderingContext | null, blocks?: Record<string, UniformBuffer>, options?: StyleGLOptions): void;
    makeMesh(vertices: Uint8Array, elements: MeshElementData, options?: Partial<import('../tile/tile-build-types').TileStylePayload>): VBOMesh;
    render(mesh: VBOMesh, options: MeshRenderOptions): boolean;
    getProgram(key?: 'program' | 'selection_program'): ShaderProgram | undefined;
    compileSetup(): void;
    addShaderBlock(key: string, block: string, scope?: string | null): void;
    removeShaderBlock(key: string): void;
    replaceShaderBlock(key: string, block: string, scope?: string | null): void;
    buildDefineList(): Record<string, unknown>;
    hasRasters(): boolean;
    setupRasters(): void;
    buildRasterTextures(tile: StyleFinalizeTile, data: BuildTileData<Uint8Array>): Promise<BuildTileData<Uint8Array> | null>;
    loadTextures(tile: RasterTextureTile): Promise<RasterTextureInfo[]>;
    setupCustomAttributes(): void;
    addCustomAttributesToAttributeList(attributes: VertexAttribute[]): VertexAttribute[];
    addCustomAttributesToVertexTemplate(style: BuildFeatureStyle, offset: number): void;
    setup(): void;
    setUniforms(): void;
    render_states: Record<StyleState['blend'], {depth_test: boolean; depth_write: boolean}>;
    default_blend_orders: Record<StyleState['blend'], number>;
    getBlendOrderForDraw(draw: {blend_order?: number}): number | undefined;
}
/** Serializable loaded raster metadata; no GPU object crosses the worker boundary. */
export interface RasterTextureInfo {
    name: string;
    width: number;
    height: number;
    loaded: boolean;
    index: number;
    coords: {x: number; y: number; z: number};
}
/** Main-thread raster request carries geometry metadata, not a complete worker build. */
export type RasterTextureTile = Pick<WorkerBuildTile, 'coords' | 'source' | 'min' | 'max'> & {rasters: string[]};
/** Nested feature counters, with no GPU or tile ownership. */
export type LayerDebugTree = Record<string, LayerDebugCounts>;
/** Feature-local tree records which nodes have already contributed counters. */
export interface CountedLayerTree {[name: string]: CountedLayerTree;}
