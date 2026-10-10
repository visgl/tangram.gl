// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {CollisionObject} from '../../labels/collision-types';
import type {LabelLayout, LabelPointCoordinate} from '../../labels/label-types';
import type LabelPoint from '../../labels/label_point';
import type LabelLine from '../../labels/label_line';
import type TextCanvas from './text_canvas';
import type {TextDraw, TextSettingsResult} from './text_settings';
import type {TaskRecord} from '../../utils/task';
import type {PropertyCache} from '../property-types';

/** Labels submitted by standalone text and attached point text. */
export type TextRenderLabel = LabelPoint | Exclude<ReturnType<typeof LabelLine.create>, false>;

/** Tile metadata needed for text placement and cancellation. */
export interface TextTile {
    id: string;
    key: string;
    generation: number;
    canceled?: boolean;
    overzoom2: number;
    units_per_pixel?: number;
}

/** Supported tile-local feature geometry. */
export type TextGeometry =
    | {type: 'Point'; coordinates: LabelPointCoordinate}
    | {type: 'MultiPoint' | 'LineString'; coordinates: LabelPointCoordinate[]}
    | {type: 'MultiLineString' | 'Polygon'; coordinates: LabelPointCoordinate[][]}
    | {type: 'MultiPolygon'; coordinates: LabelPointCoordinate[][][]};

/** Feature passed to text-source callbacks and label placement. */
export interface TextFeature {
    /** Stable optional source identity, shared by buffered tile copies. */
    id?: string | number;
    geometry: TextGeometry;
    properties: Record<string, TextValue>;
}

/** Legacy text sources may return numeric/falsy values as well as strings. */
export type TextValue = string | number | boolean | null | undefined;

/** Evaluation context supplied to dynamic style properties. */
export interface TextContext {
    tile: TextTile;
    geometry: string;
    layer?: string;
    [property: string]: unknown;
}

/** Property lookup or dynamic text callback, with optional fallbacks. */
export type TextSourceValue = string | ((context: TextContext) => TextValue);
/** Single source, ordered fallbacks, or named boundary-label sources. */
export type TextSource = TextSourceValue | TextSourceValue[] | Record<string, TextSourceValue | TextSourceValue[]>;

/** Text draw properties before/after property-cache preprocessing. */
export interface TextLabelDraw extends TextDraw {
    /** Standalone projected text altitude, cached in physical meters after preprocessing. */
    z?: PropertyCache;
    /** Internal scene draw-group identity, used to keep independent annotations separate. */
    key?: string;
    /** Enable collision placement; projected annotations resolve it in screen space. */
    collide?: boolean | ((context: TextContext) => boolean);
    text_source?: TextSource;
    offset?: unknown;
    buffer?: unknown;
    repeat_distance?: unknown;
    repeat_group?: string | ((context: TextContext) => string);
    align?: string;
    blend_order?: number;
}

/** Parsed text candidate, before its feature and geometry are queued. */
export interface ParsedTextFeature {
    draw: TextLabelDraw;
    text: string;
    text_settings_key: string;
    layout: LabelLayout;
    feature?: TextFeature;
    context?: TextContext;
}

/** Complete feature queue entry supplied by a rendering style. */
export interface TextFeatureQueue extends ParsedTextFeature {
    feature: TextFeature;
    context: TextContext;
}

/** Collision container retaining text/style/feature information. */
export interface TextLabelCandidate extends TextFeatureQueue, CollisionObject {
    label: TextRenderLabel;
}

/** Measured canvas line; structural to avoid exposing the private wrapper class. */
export interface TextLine {
    text: string;
    width: number;
    height: number;
}

/** Logical/collision sizes and device-pixel atlas dimensions. */
export interface TextSize {
    collision_size: LabelPointCoordinate;
    texture_size: LabelPointCoordinate;
    logical_size: LabelPointCoordinate;
    horizontal_buffer: number;
    vertical_buffer: number;
    dpr: number;
    line_height: number;
    background_size: number;
}

/** Cached measurement, including wrapped lines. */
export interface TextMeasurement {
    lines: TextLine[];
    size: TextSize;
}

/** Packed sprite coordinates and owning atlas index. */
export interface TextSprite {
    texture_id: number;
    texcoord: number[];
}

/** Point alignment populated during packing, then rasterization. */
export interface TextAlignment {
    texture_id?: number;
    texture_position?: LabelPointCoordinate;
    texcoords?: number[];
}

/** One unique text/style record, progressively measured and rasterized. */
export interface TextInfo {
    text_settings: TextSettingsResult;
    ref: number;
    size?: TextSize;
    segment_sizes?: TextSize[];
    segments?: string[];
    isRTL?: boolean;
    no_curving?: boolean;
    vertical_buffer?: number;
    align?: Record<string, TextAlignment>;
    type?: string[];
    textures?: (number | number[])[];
    texcoords?: {straight?: TextSprite; curved?: TextSprite[]};
    texcoords_stroke?: number[][];
}

/** Unique strings indexed first by style key and then by original text. */
export type TextTable = Record<string, Record<string, TextInfo>>;

/** Per-word atlas cache shared by straight and curved rasterization. */
export interface TextSpriteCache {
    texture_id: number;
    texture_position: LabelPointCoordinate;
    texcoord?: number[];
    texcoord_stroke?: number[];
}

/** Single atlas produced by the packing pass. */
export interface TextAtlas {
    texture_size: LabelPointCoordinate;
    texcoord_cache: Record<string, Record<string, TextSpriteCache>>;
}

/** Mutable column-packing cursor. */
export interface TextAtlasCursor {
    cx: number;
    cy: number;
    width: number;
    height: number;
    column_width: number;
    texture_id: number;
    texcoord_cache: TextAtlas['texcoord_cache'];
}

/** Cooperative text measurement/rasterization progress. */
export interface TextTaskCursor {
    styles: string[];
    texts: string[] | null;
    style_idx: number | null;
    text_idx: number | null;
}

/** Measurement task payload carried by the generic scheduler. */
export interface TextSizesTask extends TaskRecord<TextTable> {
    texts: TextTable;
    cursor: TextTaskCursor;
}

/** Raster task payload, retaining names for cancellation cleanup. */
export interface TextRasterTask extends TaskRecord<string[]> {
    texts: TextTable;
    textures: TextAtlas[];
    texture_prefix: string;
    resource_context: unknown;
    cursor: TextTaskCursor & {
        texture_idx: number;
        texture_resize: boolean;
        texture_names: string[];
    };
}

/** Shared style state required by the text-label mixin. */
export interface TextLabelState {
    /** Host-driven billboard candidates remain available until every eye is known. */
    screen_space_labels?: boolean;
    /** Projected candidates must bypass worker-local Mercator repeat culling. */
    cpu_projection?: import('../../procedures/mesh-projector').ProjectedBasemapOptions;
    name: string;
    main_thread_target: string;
    max_texture_size: number;
    resource_context: unknown;
    canvas: TextCanvas;
    texts: Record<string, TextTable>;
    computeLayout(target: Partial<LabelLayout>, feature: TextFeature, draw: TextLabelDraw, context: TextContext, tile: TextTile): LabelLayout;
    buildTextLabels(tile: TextTile, queue: TextFeatureQueue[]): TextLabelCandidate[];
}
