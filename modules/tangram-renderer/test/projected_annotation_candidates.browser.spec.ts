// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {Points} from '../src/styles/points/points';
import {TextLabels} from '../src/styles/text/text_labels';
import {textLayoutToJSON} from '../src/labels/label';

/** Use the actual style procedure without workers, font rasterization or GPU resources. */
function style(projected = true) {
    return Object.assign({}, Points, {cpu_projection: projected ? {type: 'equal-earth'} : undefined, name: 'markers'});
}

test('projected worker candidates preserve authored collision and distinguish source, layer, draw and typed IDs', () => {
    const context = {source: 'cities', layer: 'places'};
    const draw = {key: 'markers/draw', collide: true};
    const layout = style().computeLayout({}, {id: 7, properties: {}}, draw, context, {units_per_pixel: 4});
    expect(layout).toMatchObject({collide: false, projected_collide: true});
    expect(JSON.parse(layout.projected_identity)).toEqual(['cities', 'places', 'markers', 'markers/draw', 'number', 7]);
    for (const alternative of [
        style().computeLayout({}, {id: '7', properties: {}}, draw, context, {}),
        style().computeLayout({}, {id: 7, properties: {}}, draw, {...context, source: 'other'}, {}),
        style().computeLayout({}, {id: 7, properties: {}}, draw, {...context, layer: 'other'}, {}),
        style().computeLayout({}, {id: 7, properties: {}}, {...draw, key: 'other'}, context, {})
    ]) expect(alternative.projected_identity).not.toBe(layout.projected_identity);
    expect(style().computeLayout({}, {properties: {id: 7}}, draw, context, {}).projected_identity).toBe(layout.projected_identity);
    expect(style().computeLayout({}, {properties: {}}, draw, context, {}).projected_identity).toBeUndefined();
    expect(style(false).computeLayout({}, {id: 7, properties: {}}, draw, context, {})).toMatchObject({collide: true});
    expect(textLayoutToJSON({...layout, repeat_distance: 320}).repeat_distance).toBe(80);
    expect(textLayoutToJSON({...layout, projected_height: -1.0625})).toMatchObject({projected_height: -1.0625});
    expect(textLayoutToJSON(layout)).not.toHaveProperty('projected_height');
});

test('projected text identity distinguishes strings even without feature IDs and leaves classic layouts alone', () => {
    const tile = {id: 'tile', key: 'tile', generation: 1, overzoom2: 1};
    const context = {source: 'cities', layer: 'places', geometry: 'point', tile};
    const draw = {key: 'labels/draw', collide: false};
    const create = (text: string, projected = true) => TextLabels.computeTextLayout.call(style(projected), {},
        {properties: {}, geometry: {type: 'Point', coordinates: [0, 0]}}, draw, context, tile, text, {style: 'normal', supersample: 1});
    const first = create('London');
    expect(first.projected_collide).toBe(false);
    expect(first.projected_identity).toBe(create('London').projected_identity);
    expect(first.projected_identity).not.toBe(create('Paris').projected_identity);
    expect(create('London', false).projected_identity).toBeUndefined();
});
