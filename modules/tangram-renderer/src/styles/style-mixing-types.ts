// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

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
export interface ManagedStyle extends StyleDefinition {
    name: string;
    main_thread_target: string;
    resource_context?: unknown;
    gl?: unknown;
    init(scene?: Record<string, unknown>): void;
    destroy(): void;
    reset(): void;
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
    meshes: Record<string, {variant: {blend_order: number}}[]>;
}

/** Styles sharing one mesh blend-order pass. */
export interface ActiveStyleBlendOrder {
    blend_order: number;
    styles: string[];
}
