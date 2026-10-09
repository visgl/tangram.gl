// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type VertexData from '../gl/vertex_data';
import type VertexLayout from '../gl/vertex_layout';
import type UniformBuffer from '../gl/uniform_buffer';
import type {UniformBufferOptions} from '../gl/uniform_buffer';
import type {VertexAttribute} from '../gl/vertex-types';
import type {GeometryLine, GeometryPolygon, PolylineStyle} from '../builders/geometry-types';
import type {PropertyCache, PropertyContext, StyleFeature} from './property-types';
import type {ProjectedBasemapOptions} from '../procedures/mesh-projector';

/** Geometry feature properties normalized by the source and style expression boundary. */
export interface GeometryFeature extends StyleFeature {
    properties: Record<string, unknown> & {height?: number; min_height?: number};
}
/** Tile state consumed by line width interpolation and edge clipping. */
export interface GeometryTile {
    id: string | number;
    pad_scale: number;
    overzoom2: number;
}
/** Evaluation context with the tile conversions needed by geometry construction. */
export interface GeometryContext extends PropertyContext {
    /** EPSG:3857 meters per CSS pixel at the style zoom. */
    meters_per_pixel: number;
    feature: GeometryFeature;
    zoom: number;
    units_per_meter_overzoom: number;
    tile: GeometryTile;
    winding?: string;
}
/** Authored extrusion resolves to a flag, height, or [minimum height, height]. */
export type GeometryExtrusion = boolean | number | number[] | null | undefined;
/** Normalized mesh variant shared by outlines, polygons, and portable attributes. */
export interface GeometryMeshVariant {
    key: string | number;
    blend_order: number;
    mesh_order: number;
    selection: number;
    normal?: number;
    offset?: number;
    z_or_offset?: number;
    texcoords?: number | boolean;
    texture?: string | null | false;
    dash?: number[] | null | false;
    dash_key?: string | null | false;
    dash_background_color?: number[] | null | false;
}
/** Per-draw cache fields after property preprocessing, not evaluated feature values. */
export interface GeometryDraw {
    /** Internal fixed-pixel stroke marker captured before distance preprocessing. */
    projected_pixel_width?: boolean;
    color?: PropertyCache | null;
    alpha?: PropertyCache;
    width?: PropertyCache;
    next_width?: PropertyCache;
    offset?: PropertyCache | null;
    next_offset?: PropertyCache;
    z?: PropertyCache;
    extrude?: unknown;
    interactive?: unknown;
    cap?: PolylineStyle['cap'];
    join?: PolylineStyle['join'];
    miter_limit?: number;
    variant: string | number;
    tile_edges?: boolean;
    texcoords?: number | boolean;
    inline_texcoord_width?: number | null;
    offset_precalc?: number;
    offset_scale_precalc?: number;
    dash?: number[] | null | false;
    dash_key?: string | null | false;
    dash_background_color?: number[] | null | false;
    texture?: string | null;
    texture_merged?: string | null | false;
    is_outline?: boolean;
    visible?: boolean;
    order?: unknown;
    blend_order?: number;
    layers: string[];
    style: string;
    preprocessed?: boolean;
    outline?: GeometryDraw | null;
}
/** Values may be authored scalars/functions before the cache wrappers are installed. */
export type RawGeometryDraw = Omit<GeometryDraw, 'variant' | 'color' | 'alpha' | 'width' | 'offset' | 'z' | 'dash_background_color' | 'outline'> & {
    variant?: string | number;
    color?: unknown;
    alpha?: unknown;
    width?: unknown;
    offset?: unknown;
    z?: unknown;
    dash_background_color?: unknown;
    outline?: RawGeometryDraw | null;
};
/** Reused feature record; the base style and parsing methods populate it before building. */
export interface PolygonFeatureStyle {
    color: number[];
    alpha?: number;
    variant: string | number;
    z: number;
    height: number;
    min_height: number;
    extrude: GeometryExtrusion;
    tile_edges?: boolean;
    order: number;
    selection_color: number[];
}
/** Computed line values, including interpolation and a reusable cached outline. */
export interface LineFeatureStyle extends Omit<PolygonFeatureStyle, 'min_height'>, PolylineStyle {
    /** Packed extrusion units per CSS pixel, zero for meter-width strokes. */
    projected_pixel_scale?: number;
    width_unscaled: number;
    next_width_unscaled: number;
    width_scale: number;
    offset_scale: number;
    outline?: GeometryOutlineDraw;
}
/** The outline scratch record always owns width caches, populated before submission. */
export interface GeometryOutlineDraw extends GeometryDraw {
    width: PropertyCache;
    next_width: PropertyCache;
    order: number;
}
/** Worker-side mesh records while packed geometry is still being accumulated. */
export interface GeometryBuildMesh {
    vertex_data: VertexData;
    variant: GeometryMeshVariant;
    uniforms?: Record<string, unknown>;
}
/** Completed tile records used to assign dash/texture uniforms before submission. */
export interface GeometryTileData {
    uniforms: Record<string, unknown>;
    meshes: Record<string, {variant: GeometryMeshVariant; uniforms?: Record<string, unknown>}>;
}
/** Checked geometry style surface; inherited base lifecycle remains a separate tranche. */
export interface GeometryStyleRuntime<FeatureStyle extends Omit<PolygonFeatureStyle, 'min_height'> = PolygonFeatureStyle> {
    name: string;
    built_in: boolean;
    vertex_shader_src: string;
    fragment_shader_src: string;
    selection: boolean;
    animated?: boolean;
    texcoords?: boolean;
    raster?: string | boolean;
    shader_language: 'glsl' | 'wgsl';
    /** Optional scene-wide CPU projection of ground surfaces and fixed-meter line ribbons. */
    cpu_projection?: ProjectedBasemapOptions;
    /** Authored polygon lighting, disabled for initial CPU-projected ground. */
    lighting?: 'vertex' | 'fragment' | boolean;
    /** Position blocks and custom attributes are outside the initial contract. */
    shaders?: {blocks?: {position?: unknown}; attributes?: unknown};
    /** Underlying builtin style after inheritance and mixins. */
    baseStyle(): string;
    portable_lighting_mode?: 'vertex' | 'fragment' | false;
    portable_light_count?: number;
    defines: Record<string, boolean | number | string | undefined>;
    feature_style: FeatureStyle;
    vertex_template: number[];
    variants: Record<string | number, GeometryMeshVariant>;
    vertex_layouts: Record<string | number, VertexLayout>;
    texture?: string;
    dash?: number[] | null | false;
    dash_background_color?: number[] | null | false;
    init(options?: Record<string, unknown>): void;
    destroy(): void;
    setGL(context: unknown, blocks?: Record<string, UniformBuffer>, options?: Record<string, unknown>): void;
    getWGSLShaderSource(selection?: boolean): string;
    _parseFeature(feature: GeometryFeature, draw: GeometryDraw, context: GeometryContext): FeatureStyle | null | undefined;
    _preprocess(draw: RawGeometryDraw): GeometryDraw;
    computeVariant(draw: GeometryDraw | RawGeometryDraw): void;
    getBlendOrderForDraw(draw: GeometryDraw | RawGeometryDraw): number;
    vertexLayoutForMeshVariant(variant: GeometryMeshVariant): VertexLayout;
    meshVariantTypeForDraw(draw: Pick<GeometryDraw, 'variant'>): GeometryMeshVariant;
    makeVertexTemplate(style: FeatureStyle, mesh: GeometryBuildMesh): number[];
    parseColor(property: PropertyCache | null | undefined, context: GeometryContext): number[];
    parseOrder(value: unknown, context: GeometryContext): number;
    scaleOrder(order: number): number;
    addCustomAttributesToAttributeList(attributes: VertexAttribute[]): void;
    addCustomAttributesToVertexTemplate(style: FeatureStyle, offset: number): void;
    getTileMesh(tile: GeometryTile, variant: GeometryMeshVariant): GeometryBuildMesh;
    startData(tile: GeometryTile): void;
    addFeature(feature: GeometryFeature, draw: GeometryDraw, context: GeometryContext): void;
    buildPolygons(polygons: GeometryPolygon[], style: FeatureStyle, context: GeometryContext): number;
    endData(tile: GeometryTile): Promise<GeometryTileData | undefined>;
}
/** Additional lifecycle and interpolation owned only by line styles. */
export interface LineStyleRuntime extends GeometryStyleRuntime<LineFeatureStyle> {
    inline_feature_style: LineFeatureStyle;
    outline_feature_style: LineFeatureStyle;
    styles: Record<string, GeometryStyleRuntime<LineFeatureStyle>>;
    dash_textures: Record<string, boolean>;
    main_thread_target: string;
    resource_context: unknown;
    line_uniform_buffer?: UniformBuffer | null;
    uniform_blocks?: Record<string, UniformBuffer> | null;
    uniform_block_factory?: ((options: UniformBufferOptions) => UniformBuffer) | null;
    calcDistance(property: PropertyCache | null | undefined, context: GeometryContext): number;
    calcDistanceNextZoom(property: PropertyCache | null | undefined, context: GeometryContext): number;
    calcWidth(draw: GeometryDraw, style: LineFeatureStyle, context: GeometryContext): boolean | undefined;
    calcOffset(draw: GeometryDraw, style: LineFeatureStyle, context: GeometryContext): void;
    buildLines(lines: GeometryLine[], style: LineFeatureStyle, context: GeometryContext, options?: {closed_polygon?: boolean; remove_tile_edges?: boolean}): number;
    dashTextureKey(dash: number[]): string;
    getDashTexture(dash: number[]): void;
}
