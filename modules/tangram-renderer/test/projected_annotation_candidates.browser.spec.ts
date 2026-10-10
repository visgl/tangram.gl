// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import {Points} from '../src/styles/points/points';
import {TextLabels} from '../src/styles/text/text_labels';
import {textLayoutToJSON} from '../src/labels/label';
import Tile from '../src/tile/tile';
import Collision from '../src/labels/collision';
import RepeatGroup from '../src/labels/repeat_group';
import type {CollisionObject} from '../src/labels/collision-types';

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

test('external Globe/Mercator workers retain collision candidates while classic workers keep their layout', () => {
    const external = Object.assign(style(false), {screen_space_labels: true});
    const coordinates: [number, number] = [0, 0];
    const feature = {id: 7, properties: {}, geometry: {type: 'Point' as const, coordinates}};
    const draw = {key: 'markers/draw', collide: true};
    const context = {source: 'cities', layer: 'places'};
    expect(external.computeLayout({}, feature, draw, context, {})).toMatchObject({
        collide: false, projected_collide: true, projected_identity: expect.any(String)});
    expect(external.computeLayout({}, feature, {...draw, collide: false}, context, {})).toMatchObject({
        collide: false, projected_collide: false});
    expect(style(false).computeLayout({}, feature, draw, context, {})).toMatchObject({collide: true});
    const tile = {id: 'tile', key: 'tile', generation: 1, overzoom2: 1};
    const layout = TextLabels.computeTextLayout.call(external, {}, feature, draw,
        {...context, geometry: 'point', tile}, tile, 'London', {style: 'normal', supersample: 1});
    expect(layout).toMatchObject({collide: false, projected_collide: true, projected_identity: expect.any(String)});
});

test.each([
    {name: 'external Mercator/Globe', screen_space_labels: true, cpu_projection: undefined, retained: 2},
    {name: 'CPU projected', screen_space_labels: false, cpu_projection: {type: 'equal-earth'}, retained: 2},
    {name: 'classic', screen_space_labels: false, cpu_projection: undefined, retained: 1}
])('$name tile construction preserves the appropriate repeat candidates', async ({screen_space_labels, cpu_projection, retained}) => {
    const tile = {id: 'repeat-candidates', source_data: {}, debug: {}};
    // Keep the real tile/collision policy but avoid worker transport and geometry allocation.
    const buildGroups = vi.spyOn(Tile, 'buildStyleGroups').mockImplementation(() => {});
    try {
        Tile.buildGeometry(tile, {scene_id: 'fixture', layers: {}, global: {}, styles: {
            labels: {screen_space_labels, cpu_projection, hasDataForTile: () => false}
        }});
        Collision.addStyle('labels', tile.id);
        const candidates: CollisionObject[] = [0, 1].map(priority => ({label: {
            layout: {priority, collide: false, repeat_scale: 1, repeat_group: 'road-name', repeat_distance: 20},
            position: [priority, 0], discard: () => false
        }}));
        expect(await Collision.collide(candidates, 'labels', tile.id)).toHaveLength(retained);
    }
    finally {
        Collision.abortTile(tile.id);
        RepeatGroup.clear(tile.id);
        buildGroups.mockRestore();
    }
});
