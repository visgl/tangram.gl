// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {TextStyle} from '../src/styles/text/text';
import type {TextStyleRuntime} from '../src/styles/text/text';
import type {LabelLayout, LabelPointCoordinate} from '../src/labels/label-types';
import type {TextFeature, TextTile, TextContext, TextFeatureQueue, TextInfo, TextSize} from '../src/styles/text/text-types';
import type {TextSettingsResult} from '../src/styles/text/text_settings';
import TextCanvas from '../src/styles/text/text_canvas';

/** Complete normalized layout, with optional per-case overrides. */
export function createLabelLayout(overrides: Partial<LabelLayout> = {}): LabelLayout {
    return {
        angle: 0, anchor: 'center', align: 'center', buffer: [0, 0], collide: false,
        offset: [0, 0], priority: 0, subdiv: 1, units_per_pixel: 1,
        repeat_distance: 0, repeat_scale: 1, vertical_buffer: 0,
        placement_min_length_ratio: 0, ...overrides
    };
}

/** Minimal deterministic tile contract. */
export function createTextTile(overrides: Partial<TextTile> = {}): TextTile {
    return {id: 'tile', key: '0/0/0', generation: 2, overzoom2: 1, ...overrides};
}

/** Evaluation context matching the worker's text-style boundary. */
export function createTextContext(tile = createTextTile()): TextContext {
    return {tile, geometry: 'point', layer: 'places'};
}

/** Point feature with an explicit properties bag. */
export function createTextFeature(position: LabelPointCoordinate = [100, -100]): TextFeature {
    return {geometry: {type: 'Point', coordinates: position}, properties: {name: 'Cafe'}};
}

/** Queued feature retaining the same layout/context objects used by the style. */
export function createTextQueue(overrides: Partial<TextFeatureQueue> = {}): TextFeatureQueue {
    return {
        draw: {}, text: 'Cafe', text_settings_key: 'regular', layout: createLabelLayout(),
        feature: createTextFeature(), context: createTextContext(), ...overrides
    };
}

/** Canvas settings with deterministic built-in font and pixel ratio assumptions. */
export function createTextSettings(overrides: Partial<TextSettingsResult> = {}): TextSettingsResult {
    return {font_css: '12px sans-serif', px_size: 12, fill: '#fff', supersample: 1, text_wrap: false, max_lines: 5, ...overrides};
}

/** Complete measurement record for packing/mesh tests. */
export function createTextSize(size: LabelPointCoordinate = [20, 10]): TextSize {
    return {
        collision_size: size, logical_size: size, texture_size: size,
        horizontal_buffer: 0, vertical_buffer: 0, dpr: 1, line_height: size[1], background_size: 0
    };
}

/** Unique text entry with configurable measured/rasterized stage data. */
export function createTextInfo(overrides: Partial<TextInfo> = {}): TextInfo {
    return {text_settings: createTextSettings(), ref: 0, size: createTextSize(), vertical_buffer: 0, ...overrides};
}

/** Isolated checked style using the actual inherited point/text implementation. */
export function createTextStyle(): TextStyleRuntime {
    const style: TextStyleRuntime = Object.create(TextStyle);
    style.name = 'text-test';
    style.generation = 2;
    style.feature_style = {};
    style.queues = {};
    style.texts = {};
    style.defines = {};
    style.vertex_layouts = {};
    style.vertex_template = [];
    style.canvas = new TextCanvas();
    style.main_thread_target = 'styles.text-test';
    style.max_texture_size = 256;
    style.resource_context = {};
    return style;
}
