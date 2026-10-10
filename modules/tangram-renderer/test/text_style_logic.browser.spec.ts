// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, describe, expect, test, vi} from 'vitest';
import {Style} from '../src/styles/style';
import {TextStyle} from '../src/styles/text/text';
import Collision from '../src/labels/collision';
import LabelLine from '../src/labels/label_line';
import LabelPoint from '../src/labels/label_point';

function createTextStyle(): any {
    const style = Object.create(TextStyle);
    style.name = 'text-test';
    style.generation = 2;
    style.feature_style = {};
    style.queues = {};
    style.texts = {};
    style.vertex_layouts = {};
    style.vertex_template = [];
    style.addCustomAttributesToAttributeList = vi.fn();
    style.addCustomAttributesToVertexTemplate = vi.fn();
    style.freeText = vi.fn();
    style.getBlendOrderForDraw = vi.fn(() => 4);
    return style;
}

function layout(overrides: any = {}): any {
    return {
        angle: 0,
        buffer: [0, 0],
        collide: false,
        offset: [0, 0],
        priority: 0,
        subdiv: 1,
        units_per_pixel: 1,
        ...overrides
    };
}

afterEach(() => vi.restoreAllMocks());

describe('standalone text style', () => {
    test('initializes text-specific shader state and queues line labels', () => {
        const style = createTextStyle();
        style.setupDefines = vi.fn();
        style.resetText = vi.fn();
        style.init({generation: 2, styles: {'text-test': style}, sources: {}});
        expect(style.defines.TANGRAM_HAS_SHADER_POINTS).toBe(false);
        expect(style.defines.TANGRAM_CURVED_LABEL).toBe(true);
        expect(style.setupDefines).toHaveBeenCalled();

        const queueFeature = vi.spyOn(style, 'queueFeature').mockImplementation(() => {});
        vi.spyOn(Collision, 'addStyle').mockImplementation(() => {});
        style.parseTextFeature = vi.fn(() => ({layout: {}, text: 'Broadway'}));
        const tile = {generation: 2, id: 'tile'};
        style.addFeature({geometry: {type: 'LineString'}}, {}, {tile});
        expect(queueFeature).toHaveBeenCalledWith(expect.objectContaining({text: 'Broadway'}), tile);
        expect(Collision.addStyle).toHaveBeenCalledWith('text-test', 'tile');

        style.parseTextFeature.mockReturnValue([{layout: {}}, {layout: {}}]);
        style.addFeature({geometry: {type: 'MultiLineString'}}, {}, {tile});
        expect(queueFeature).toHaveBeenCalledTimes(3);
        style.parseTextFeature.mockReturnValue(null);
        style.addFeature({geometry: {type: 'Point'}}, {}, {tile});
        style.addFeature({geometry: {type: 'Point'}}, {}, {tile: {...tile, generation: 1}});
    });

    test('preprocesses blend order and resets queues and text caches', () => {
        const style = createTextStyle();
        style.preprocessText = vi.fn(draw => ({...draw, processed: true}));
        expect(style._preprocess({text_source: 'name'})).toMatchObject({blend_order: 4, processed: true});
        style.resetText = vi.fn();
        style.queues.tile = [{}];
        style.reset();
        expect(style.queues).toEqual({});
        expect(style.resetText).toHaveBeenCalled();
        expect(style.getWGSLShaderSource()).toContain('@vertex');
    });

    test('queues each projected standalone text altitude independently and rejects unsupported heights', () => {
        const style = createTextStyle();
        style.cpu_projection = {type: 'equal-earth', allowElevation: true};
        style.preprocessText = vi.fn(draw => draw);
        style.queueFeature = vi.fn();
        style.parseTextFeature = vi.fn(() => [{layout: layout(), text: 'First'}, {layout: layout(), text: 'Second'}]);
        vi.spyOn(Collision, 'addStyle').mockImplementation(() => {});
        const tile = {generation: 2, id: 'tile'};
        const feature = {properties: {}, geometry: {type: 'Point', coordinates: [0, 0]}};
        for (const height of [0, -12.99, 2047.9375]) {
            style.addFeature(feature, style._preprocess({z: height}), {tile, zoom: 6});
            expect(style.queueFeature).toHaveBeenLastCalledWith(expect.objectContaining({
                layout: expect.objectContaining({projected_height: Math.trunc(height * 16) / 16})
            }), tile);
        }
        for (const height of [Infinity, 2048, -2048.1]) {
            expect(() => style.addFeature(feature, style._preprocess({z: height}), {tile})).toThrow('height');
        }
        style.cpu_projection.allowElevation = false;
        expect(() => style.addFeature(feature, style._preprocess({z: 1}), {tile})).toThrow('ground anchors');
        expect(() => style.addFeature({...feature, geometry: {type: 'Polygon'}}, {}, {tile})).toThrow('Point or MultiPoint');
    });

    test('builds point, line, polygon, and multi-geometry labels', () => {
        const style = createTextStyle();
        const pointLayout = layout();
        expect(style.buildLabels([10, 5], {type: 'Point', coordinates: [0, 0]}, pointLayout)[0]).toBeInstanceOf(LabelPoint);
        expect(style.buildLabels([10, 5], {type: 'MultiPoint', coordinates: [[0, 0], [1, 1]]}, pointLayout)).toHaveLength(2);
        const polygon = [[[0, 0], [10, 0], [10, -10], [0, -10], [0, 0]]];
        expect(style.buildLabels([10, 5], {type: 'Polygon', coordinates: polygon}, pointLayout)).toHaveLength(1);
        expect(style.buildLabels([10, 5], {type: 'MultiPolygon', coordinates: [[...polygon]]}, pointLayout)).toHaveLength(1);

        vi.spyOn(LabelLine, 'create').mockImplementation(() => ({type: 'straight'} as any));
        const line = [[0, 0], [10, 0], [20, 0], [30, 0]];
        expect(style.buildLineLabels(line, [10, 5], layout({subdiv: 2}))).toHaveLength(2);
        expect(style.buildLabels([10, 5], {type: 'LineString', coordinates: line}, layout())).toHaveLength(1);
        expect(style.buildLabels([10, 5], {type: 'MultiLineString', coordinates: [line, line]}, layout())).toHaveLength(2);
    });

    test('builds labels from cached articulated and regular text metrics', () => {
        const style = createTextStyle();
        const tile = {id: 'tile'};
        const regular = {feature: {geometry: {type: 'Point', coordinates: [0, 0]}}, layout: layout(), text: 'A', text_settings_key: 'regular'};
        const articulated = {feature: {geometry: {type: 'LineString', coordinates: [[0, 0], [100, 0]]}}, layout: layout(), text: 'Road', text_settings_key: 'articulated'};
        style.texts.tile = {
            regular: {A: {size: {collision_size: [10, 5]}, vertical_buffer: 1, text_settings: {can_articulate: false}}},
            articulated: {Road: {
                no_curving: false,
                segment_sizes: [{collision_size: [4, 5]}, {collision_size: [5, 5]}],
                size: {collision_size: [9, 5]},
                vertical_buffer: 2,
                text_settings: {can_articulate: true}
            }}
        };
        vi.spyOn(LabelLine, 'create').mockImplementation(() => ({type: 'straight'} as any));
        expect(style.buildTextLabels(tile, [regular, articulated])).toHaveLength(2);
        expect(articulated.layout.no_curving).toBe(false);
        expect(regular.layout.vertical_buffer).toBe(1);
    });

    test('creates text vertex templates and caches vertex layouts', () => {
        const style = createTextStyle();
        style.super = {
            makeVertexTemplate() { style.vertex_template = [1, 2, 3, 4]; }
        };
        const mesh = {vertex_data: {vertex_layout: {index: {a_pre_angles: 4}}}};
        expect(style.makeVertexTemplate({}, mesh).slice(4, 16)).toEqual(new Array(12).fill(0));
        expect(style.addCustomAttributesToVertexTemplate).toHaveBeenCalled();

        const first = style.vertexLayoutForMeshVariant({selection: true, shader_point: false});
        const second = style.vertexLayoutForMeshVariant({selection: false, shader_point: false});
        expect(second).toBe(first);
        expect(first.index).toHaveProperty('a_pre_angles');
        expect(style.addCustomAttributesToAttributeList).toHaveBeenCalledTimes(1);
    });

    test('assembles regular, straight, and curved tile label meshes', async () => {
        const style = createTextStyle();
        const tile = {id: 'tile'};
        const tileData = {meshes: {main: {uniforms: {}}}, textures: []};
        vi.spyOn(Style, 'addFeature').mockImplementation(() => {});
        vi.spyOn(Style, 'endData').mockResolvedValue(tileData);

        const base = {
            context: {},
            draw: {blend_order: 3},
            feature: {},
            label: {align: 'center', type: 'straight'},
            text: 'A',
            text_settings_key: 'key'
        };
        style.queues.tile = [base];
        style.collideAndRenderTextLabels = vi.fn().mockResolvedValue({
            labels: [base],
            texts: {key: {A: {
                align: {center: {texcoords: [0, 1], texture_id: 0}},
                size: {logical_size: [10, 5]},
                text_settings: {can_articulate: false}
            }}},
            textures: ['atlas']
        });
        expect(await style.endData(tile)).toBe(tileData);
        expect(style.feature_style).toMatchObject({label_texture: 'atlas', size: [10, 5]});
        expect((tileData.meshes.main.uniforms as any).u_apply_color_blocks).toBe(true);

        style.queues.tile = [base];
        style.collideAndRenderTextLabels.mockResolvedValue({
            labels: [base],
            texts: {key: {A: {
                segment_sizes: [{logical_size: [4, 5]}, {logical_size: [6, 5]}],
                size: {logical_size: [10, 5]},
                texcoords: {straight: {texcoords: [0, 1], texture_id: 0}, curved: [{texture_id: 0}, {texture_id: 1}]},
                texcoords_stroke: [0, 1],
                text_settings: {can_articulate: true}
            }}},
            textures: ['first', 'second']
        });
        await style.endData(tile);
        expect(style.feature_style.label_texture).toBe('first');

        base.label.type = 'curved';
        style.queues.tile = [base];
        await style.endData(tile);
        expect(style.feature_style.label_textures).toEqual(['first', 'second']);
        expect(style.feature_style.size.curved).toEqual([[4, 5], [6, 5]]);
    });
});
