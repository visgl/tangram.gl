// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Feature data available to dynamic scene expressions. */
export interface StyleFeature {
    id?: string | number;
    geometry: {type: string};
    properties: Record<string, unknown>;
}

/** Tile conversions used when constructing a feature evaluation context. */
export interface StyleParseTile {
    style_z: number;
    meters_per_pixel: number;
    meters_per_pixel_sq: number;
    units_per_meter_overzoom: number;
}

/** Context may be partial for static expressions; feature evaluation supplies all required fields. */
export interface PropertyContext {
    zoom?: number;
    feature?: StyleFeature;
    layers?: string[];
    global?: unknown;
    [name: string]: unknown;
}

/** Dynamic values are intentionally unknown until the owning property parser normalizes them. */
export type PropertyFunction = ((context: PropertyContext) => unknown) & {source?: string};

/** Mutable cache shared by static, dynamic, and zoom-interpolated scene properties. */
export interface PropertyCache {
    /** Original or once-normalized property; dynamic results are not stored here. */
    value: unknown;
    /** Legacy cache category, populated during construction. */
    type?: number;
    /** Lazily evaluated static value (including falsy values). */
    static?: unknown;
    /** Lazily interpolated results keyed by style zoom. */
    zoom?: Record<number, unknown> | null;
    /** Compiled per-feature evaluator, installed on first evaluation. */
    dynamic?: PropertyFunction;
    /** Optional post-evaluation normalization for dynamic values. */
    dynamic_transform?: ((value: unknown) => unknown) | null;
    /** Whether authored string colors have been normalized within zoom stops. */
    zoom_preprocessed?: boolean;
}

/** Coordinate/value stop consumed by the legacy interpolation procedure. */
export type PropertyStop = [number, unknown];

/** Unit value normalized before distance interpolation. */
export interface UnitValue {
    value: number | number[];
    units?: 'px';
}

/** Texture/sprite metadata used for percent and aspect-ratio sizing. */
export interface PointSizeImage {
    sprite?: string;
    css_size: number[];
    aspect: number;
}

/** Per-stop flags retain the legacy scalar/array representation. */
export type PointSizeFlags = (boolean | boolean[])[];

/** Point sizes using image-relative percentages or an automatic dimension. */
export interface PointSizeCache extends PropertyCache {
    /** Percentage flags matching the original scalar/vector stop shape. */
    has_pct?: PointSizeFlags | null;
    /** Aspect-ratio flags matching the original scalar/vector stop shape. */
    has_ratio?: PointSizeFlags | null;
    /** Independent evaluated caches keyed by sprite name. */
    sprites?: Record<string, PropertyCache | undefined>;
    /** Evaluated cache for an entire texture rather than a named sprite. */
    texture?: PropertyCache;
}

/** A one-time property normalization, with its zoom-stop index. */
export type PropertyTransform = (value: unknown, index: number) => unknown;

/** Checked callable surface of the incrementally initialized legacy parser object. */
export interface StyleParserRuntime {
    /** Retains Math.max coercion, including array results from legacy nested inputs. */
    clampPositive(value: unknown): number;
    noNaN(value: number): number;
    parseNumber(value: unknown[]): number[];
    parseNumber(value: string | number | boolean | null | undefined): number;
    parseNumber(value: unknown): number | number[];
    parsePositiveNumber(value: unknown[]): number[];
    parsePositiveNumber(value: string | number | boolean | null | undefined): number;
    parsePositiveNumber(value: unknown): number | number[];
    /** Preserve NaN only for properties that validate their own numeric contract. */
    wrapFunction(source: string | (() => number[]), preserveNaN?: boolean): string;
    zeroPair: readonly [number, number];
    defaults: {
        color: number[]; width: number; size: number; extrude: boolean;
        height: number; min_height: number; order: number; z: number;
        outline: {color: number[]; width: number}; material: {ambient: number; diffuse: number};
    };
    macros: Record<string, () => number[]>;
    CACHE_TYPE: {STATIC: number; DYNAMIC: number; ZOOM: number};
    getFeatureParseContext(feature: StyleFeature, tile: StyleParseTile, global: unknown): PropertyContext & {feature: StyleFeature; zoom: number};
    createPropertyCache(value: unknown, transform?: PropertyTransform | null, dynamicTransform?: ((value: unknown) => unknown) | null): PropertyCache | undefined;
    createColorPropertyCache(value: unknown): PropertyCache | undefined;
    createPointSizePropertyCache(value: unknown, texture?: unknown): PointSizeCache | undefined;
    evalCachedPointSizeProperty(value: PointSizeCache | null | undefined, sprite: PointSizeImage | null | undefined, texture: PointSizeImage | null | undefined, context: PropertyContext): unknown;
    evalCachedProperty(value: PropertyCache | null | undefined, context: PropertyContext): unknown;
    convertUnits(value: unknown, context: PropertyContext): unknown;
    parseUnits(value: unknown): UnitValue;
    /** Cache projected annotation heights without legacy NaN-to-zero coercion. */
    createProjectedHeightPropertyCache(value: unknown): PropertyCache | undefined;
    /** Evaluate projected heights without swallowing dynamic expression errors. */
    evalProjectedHeightProperty(value: PropertyCache | undefined, context: PropertyContext): unknown;
    evalCachedDistanceProperty(value: PropertyCache | null | undefined, context: PropertyContext): unknown;
    string_colors: Record<string, number[]>;
    colorForString(value: string): number[];
    evalCachedColorProperty(value: PropertyCache | null | undefined, context?: PropertyContext): number[] | undefined;
    evalCachedColorPropertyWithAlpha(value: PropertyCache | null | undefined, alpha: PropertyCache | null | undefined, context: PropertyContext): unknown[] | undefined;
    parseColor(value: unknown, context?: PropertyContext): number[];
    calculateOrder(value: unknown, context: PropertyContext): unknown;
    evalProperty(value: unknown, context: PropertyContext): unknown;
}
