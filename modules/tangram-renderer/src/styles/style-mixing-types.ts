// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {TileBuildStyle} from '../tile/tile-build-types';
import type {StyleGLOptions} from './style-runtime-types';
import type UniformBuffer from '../gl/uniform_buffer';
import type ShaderProgram from '../gl/shader_program';
import type VBOMesh from '../gl/vbo_mesh';
import type {MeshRenderOptions} from '../gl/mesh-types';

/** Extensible shader customization before and after mixin evaluation. */
export interface StyleShaderDefinition {
    defines?: Record<string, unknown>;
    attributes?: Record<string, unknown>;
    uniforms?: Record<string, unknown>;
    _uniforms?: Record<string, unknown>;
    _uniform_scopes?: Record<string, string>;
    extensions?: string | string[];
    blocks?: Record<string, string | string[]>;
    block_scopes?: Record<string, string | string[]>;
}

/** Authored/intermediate style configuration; abstract styles need no GPU lifecycle. */
export interface StyleDefinition {
    name?: string;
    mix?: string | string[];
    mixed?: Record<string, boolean>;
    base?: string | null;
    animated?: boolean;
    texcoords?: boolean;
    lighting?: string | boolean;
    texture?: string;
    raster?: string | boolean;
    dash?: unknown;
    dash_background_color?: unknown;
    blend?: string | false;
    blend_order?: number;
    defines?: Record<string, unknown>;
    material?: Record<string, unknown>;
    draw?: Record<string, unknown>;
    shaders?: StyleShaderDefinition;
}

/** Instantiated base/custom style surface consumed by the style manager. */
export interface ManagedStyle extends StyleDefinition, TileBuildStyle {
    /** Abstract styles with null bases are not admitted to this initialized registry. */
    base?: string;
    name: string;
    main_thread_target: string;
    resource_context?: unknown;
    gl?: unknown;
    init(scene?: import('./style-runtime-types').StyleInitOptions): void;
    destroy(): void;
    reset(): void;
    /** Effective initialized blend mode; abstract styles never enter the draw registry. */
    blend: 'opaque' | 'translucent' | 'add' | 'multiply' | 'inlay' | 'overlay';
    /** Underlying built-in geometry implementation after mixins are resolved. */
    baseStyle(): string;
    /** Replace worker generation without reallocating style resources. */
    setGeneration(generation: number): void;
    /** Install host resource factories and the caller-owned drawing context. */
    setGL(context: WebGLRenderingContext | null, blocks: Record<string, UniformBuffer>, options: StyleGLOptions): void;
    /** Lazily compile the color or feature-selection program. */
    getProgram(key: 'program' | 'selection_program'): ShaderProgram | undefined;
    /** Optional feature-ID program is owned only by the style that created it. */
    selection_program?: ShaderProgram | null;
    /** Optional std140 material owner, retired with its style generation. */
    portable_material_buffer?: UniformBuffer | null;
    /** Bind style material and shader values for the currently active program. */
    setup(): void;
    /** Submit a retained mesh through the active classic or portable backend. */
    render(mesh: VBOMesh, options: MeshRenderOptions): boolean;
    /** Snapshot captured during worker initialization, absent for ordinary flat scenes. */
    terrain?: import('../procedures/terrain-draping').TerrainDrapingSnapshot;
    /** View-dependent worker ribbon target, separate from physical DEM identity. */
    terrainRibbonZoom?: number;
    /** Initialized shader owner and proxy stencil policy used by main scene passes. */
    program?: ShaderProgram | null;
    stencil_proxy_tiles?: boolean;
}

/** Shader mix state populated in stages without changing the original object shape. */
export interface MixedStyleShaders extends StyleShaderDefinition {
    defines: Record<string, unknown>;
    attributes: Record<string, unknown>;
    uniforms: Record<string, unknown>;
    _uniforms: Record<string, unknown>;
    _uniform_scopes: Record<string, string>;
}

/** Tile mesh metadata used for active styles and ascending blend passes. */
export interface StyleManagerTile {
    meshes: Record<string, {variant: {blend_order?: number}}[]>;
}

/** Styles sharing one mesh blend-order pass. */
export interface ActiveStyleBlendOrder {
    blend_order?: number;
    styles: string[];
}
