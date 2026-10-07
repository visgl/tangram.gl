// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {PropertyContext} from './property-types';
import type {LayerTree, LayerLeaf} from './layer';

/** Raw YAML members validated lazily during matching. */
export type SceneLayerDefinition = Record<string, unknown>;
/** Extensible evaluated draw properties for built-in and custom styles. */
export interface LayerDrawGroup extends Record<string, unknown> {
    visible?: boolean;
    key?: string;
    layers?: string[];
    group?: string;
}
/** Named draw groups at one scene-tree depth. */
export type LayerDrawGroups = Record<string, LayerDrawGroup | null>;
/** Leaf/tree candidates sharing the legacy matching order. */
export type SceneLayer = LayerTree | LayerLeaf;
/** A lazy layer constructor's reserved properties. */
export interface LayerConfig {
    layer: SceneLayerDefinition;
    name: string;
    parent?: LayerTree | null;
    draw?: Record<string, unknown>;
    visible?: boolean;
    enabled?: boolean;
    filter?: unknown;
    exclusive?: boolean;
    priority?: number;
    styles?: Record<string, unknown>;
    layers?: SceneLayer[];
}
/** Context used by feature, property, and zoom filters. */
export interface LayerMatchContext extends PropertyContext {
    zoom: number;
    feature: NonNullable<PropertyContext['feature']>;
}
/** Optimized match retaining the original comparison values. */
export type LayerPropertyMatch = [string, unknown[]];
/** Null means evaluated with no draw; undefined means not evaluated. */
export type LayerCombinationCache = Record<string, LayerDrawGroups | null | undefined>;
