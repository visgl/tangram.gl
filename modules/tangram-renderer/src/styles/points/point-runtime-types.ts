// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {StyleRuntime, StyleInitOptions, BuildMesh, BuildTileData, BuildFeatureStyle} from '../style-runtime-types';
import type {TextLabelRuntime} from '../text/text_labels';
import type {TextFeature, TextContext, TextTile, TextGeometry, TextLabelDraw, ParsedTextFeature, TextFeatureQueue, TextLabelCandidate, TextRenderLabel, TextSprite} from '../text/text-types';
import type {PropertyCache, PointSizeCache, PointSizeImage} from '../property-types';
import type {LabelLayout, LabelPointCoordinate} from '../../labels/label-types';
import type {CollisionObject} from '../../labels/collision-types';
import type LabelPoint from '../../labels/label_point';
import type VertexData from '../../gl/vertex_data';
import type VertexLayout from '../../gl/vertex_layout';
import type {WorkerBuildTile, TileMeshVariant, TileStylePayload} from '../../tile/tile-build-types';
import type {GeometryMeshVariant} from '../geometry-style-types';
import type {MeshElementData} from '../../gl/mesh-types';
import type VBOMesh from '../../gl/vbo_mesh';
import type {buildQuadForPoint} from '../../builders/points';

/** Point evaluation includes the worker build ownership retained by attached text. */
export interface PointContext extends TextContext {tile: WorkerBuildTile & TextTile; layers: string[];}
/** Point caches after normalization; authored extension values remain unresolved. */
export interface PointDraw extends TextLabelDraw {
    layers?: string[];
    group?: string;
    style?: string;
    order?: unknown;
    interactive?: unknown;
    anchor?: string | string[];
    priority?: number | ((context: import('../property-types').PropertyContext) => number);
    color?: PropertyCache;
    alpha?: PropertyCache;
    texture?: string;
    sprite?: unknown;
    sprite_default?: string;
    size?: PointSizeCache;
    outline?: {width?: PropertyCache; color?: PropertyCache; alpha?: PropertyCache};
    placement?: number | string;
    placement_spacing?: PropertyCache;
    placement_min_length_ratio?: PropertyCache;
    offset?: PropertyCache;
    buffer?: PropertyCache;
    repeat_distance?: PropertyCache;
    repeat_group?: string | ((context: import('../property-types').PropertyContext) => string);
    angle?: number | 'auto' | ((context: PointContext) => number);
    tile_edges?: boolean;
    text?: TextLabelDraw & {visible?: boolean; priority?: unknown; optional?: boolean; group?: string; layers?: string[]; order?: unknown; anchor?: string | string[]; interactive?: unknown};
}
/** Scratch feature values span parent points and straight/curved attached text. */
export interface PointFeatureStyle extends BuildFeatureStyle, Partial<LabelLayout> {
    color?: number[];
    alpha?: number;
    texture?: string;
    label_texture?: string | null;
    label_textures?: string[];
    blend_order?: number;
    size?: LabelPointCoordinate | {straight?: LabelPointCoordinate; curved?: LabelPointCoordinate[]};
    texcoords?: number[] | {straight?: TextSprite; curved?: TextSprite[]};
    texcoords_stroke?: number[][];
    outline_width?: number;
    outline_color?: number[];
    outline_edge_pct?: number;
    outline_alpha?: number;
    z?: number;
    label?: TextRenderLabel;
    linked?: CollisionObject['linked'];
}
/** Independent texture/blend permutation, separate from vertex-layout permutations. */
export type PointMeshVariant = GeometryMeshVariant & TileMeshVariant & {shader_point: boolean; point_type: number};
/** Mutable pre-finalization point mesh; no transferred byte facade is accepted here. */
export type PointBuildMesh = BuildMesh;
/** Vertex templates consume layout/variant capabilities, not GPU resource ownership. */
export interface PointTemplateMesh {vertex_data: {vertex_layout: Pick<VertexLayout, 'index'>}; variant: {shader_point?: unknown; selection?: unknown; point_type?: unknown};}
/** A point may own optional attached text before collision placement. */
export interface PointFeatureQueue {feature: TextFeature; draw: PointDraw; context: PointContext; style: PointFeatureStyle; text_feature?: ParsedTextFeature | false | null;}
/** Collision placement adds a label and optional two-way text linkage. */
export interface PointCandidate extends Omit<PointFeatureQueue, 'text_feature'>, CollisionObject {label: LabelPoint;}
/** Attached text retains its parent anchor until the text mixin builds the final label. */
export interface AttachedTextQueue extends TextFeatureQueue {point_label: LabelPoint; linked: PointCandidate; label?: LabelPoint;}
/** Point-owned state in addition to inherited base and text-label lifecycles. */
export interface PointState {
    feature_style: PointFeatureStyle;
    queues: Record<string | number, PointFeatureQueue[]>;
    collision_group_points: string;
    collision_group_text: string;
    fade_in_time: number;
    texture_missing_sprites: Record<string, Record<string, boolean>>;
    texture?: string;
    variants: Record<string, PointMeshVariant>;
    default_anchor: string[];
}
/** Checked concrete point operations; inherited base methods retain their own contracts. */
export interface PointMethods {
    getWGSLShaderSource(selection?: boolean): string;
    init(options?: StyleInitOptions): void;
    setupDefines(): void;
    reset(): void;
    addFeature(feature: TextFeature, draw: PointDraw, context: PointContext): void;
    calcSize(draw: PointDraw, style: PointFeatureStyle, sprite: PointSizeImage | null | undefined, context: PointContext): void;
    hasSprites(style: PointFeatureStyle): unknown;
    getSpriteInfo(style: PointFeatureStyle, sprite?: string): (PointSizeImage & {texcoords: number[]}) | null | undefined;
    parseSprite(style: PointFeatureStyle, draw: PointDraw, context: PointContext): (PointSizeImage & {texcoords: number[]}) | null | undefined;
    queueFeature(feature: PointFeatureQueue, tile: WorkerBuildTile & TextTile): void;
    endData(tile: WorkerBuildTile & TextTile): Promise<BuildTileData<Uint8Array> | null>;
    _preprocess(draw: PointDraw): PointDraw | null;
    computeLayout(target: Partial<LabelLayout>, feature: Pick<TextFeature, 'id' | 'properties'>, draw: PointDraw, context: Pick<TextContext, 'layer'> & Record<string, unknown>, tile: Pick<TextTile, 'units_per_pixel'>): LabelLayout;
    buildTextLabels(tile: TextTile, queue: TextFeatureQueue[]): TextLabelCandidate[];
    buildLabels(size: LabelPointCoordinate, geometry: TextGeometry, layout: LabelLayout): LabelPoint[];
    makeVertexTemplate(style: PointFeatureStyle, mesh: PointTemplateMesh, addCustom?: boolean): number[];
    buildQuad(point: Parameters<typeof buildQuadForPoint>[0], size: LabelPointCoordinate, angle: number,
        angles: Parameters<typeof buildQuadForPoint>[9] | null, preAngles: Parameters<typeof buildQuadForPoint>[7] | null, offset: Parameters<typeof buildQuadForPoint>[5],
        offsets: Parameters<typeof buildQuadForPoint>[6] | null, texcoords: Parameters<typeof buildQuadForPoint>[10], curve: boolean, data: VertexData, template: number[]): number;
    build(style: PointFeatureStyle, context: PointContext): number;
    buildStraightLabel(label: Exclude<TextRenderLabel, {type: 'curved'}>, style: PointFeatureStyle, context: PointContext): number;
    buildCurvedLabel(label: Extract<TextRenderLabel, {num_segments: number}>, style: PointFeatureStyle, context: PointContext): number;
    trackLabel(label: TextRenderLabel, linked: number | string | null | undefined, mesh: PointBuildMesh, count: number, context?: PointContext): void;
    buildLines(lines: number[][][], style: PointFeatureStyle, context: PointContext): number;
    buildPoints(points: number[][], style: PointFeatureStyle, context: PointContext): number;
    buildPolygons(polygons: number[][][][], style: PointFeatureStyle, context: PointContext): number;
    vertexLayoutForMeshVariant(variant: GeometryMeshVariant & TileMeshVariant): VertexLayout;
    meshVariantTypeForDraw(draw: PointFeatureStyle): PointMeshVariant;
    makeMesh(vertices: Uint8Array, elements: MeshElementData, options?: Partial<TileStylePayload>): VBOMesh;
}
/** Prototype/mixin style with concrete state and inherited checked operations. */
export type PointStyleRuntime = Omit<StyleRuntime, keyof PointState | keyof PointMethods> & TextLabelRuntime & PointState & PointMethods;
