// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, describe, expect, test, vi} from 'vitest';
import {Style} from '../src/styles/style';
import {Points} from '../src/styles/points/points';
import Texture from '../src/gl/texture';
import Collision from '../src/labels/collision';
import LabelPoint from '../src/labels/label_point';
import debugSettings from '../src/utils/debug_settings';
import StyleParser from '../src/styles/style_parser';
import {compileFunctionString} from '../src/utils/functions';

function createPoints() {
    const points = Object.create(Points);
    points.name = 'points-lifecycle';
    points.generation = 3;
    points.feature_style = {};
    points.queues = {};
    points.texts = {};
    points.texture_missing_sprites = {};
    points.tile_data = {};
    points.variants = {};
    points.vertex_layouts = {};
    points.vertex_template = [];
    points.addCustomAttributesToAttributeList = vi.fn();
    points.addCustomAttributesToVertexTemplate = vi.fn();
    points.getBlendOrderForDraw = vi.fn(() => 2);
    points.scaleOrder = value => value;
    return points;
}

function label(overrides = {}) {
    return {
        angle: 0,
        id: 7,
        layout: {collide: true},
        may_repeat_across_tiles: false,
        offset: [1, 2],
        position: [100, -100],
        toJSON: () => ({id: 7}),
        type: 'point',
        ...overrides
    };
}

function mesh(overrides = {}) {
    return {
        variant: {point_type: 3, selection: 1, shader_point: true},
        vertex_data: {
            offset: 80,
            stride: 10,
            vertex_layout: {index: {a_point_type: 1}}
        },
        ...overrides
    };
}

afterEach(() => {
    vi.restoreAllMocks();
    debugSettings.suppress_label_fade_in = false;
    debugSettings.suppress_label_snap_animation = false;
    debugSettings.show_hidden_labels = false;
    debugSettings.wireframe = false;
});

describe('point style lifecycle', () => {
    test('initializes shader defines, collision groups, and queues', () => {
        const points = createPoints();
        points.resetText = vi.fn();
        points.init({generation: 3, styles: {'points-lifecycle': points}, sources: {}});
        expect(points.defines).toMatchObject({
            TANGRAM_HAS_SHADER_POINTS: true,
            TANGRAM_POINT_TYPE_LABEL: 2,
            TANGRAM_POINT_TYPE_SHADER: 3,
            TANGRAM_POINT_TYPE_TEXTURE: 1
        });
        expect(points.collision_group_points).toBe('points-lifecycle-points');
        expect(points.stencil_proxy_tiles).toBe(false);
        expect(points.resetText).toHaveBeenCalled();
        expect(points.getWGSLShaderSource()).toContain('@vertex');
    });

    test('honors debug shader flags and non-overlay ordering', () => {
        const points = createPoints();
        points.blend = 'opaque';
        points.defines = {};
        debugSettings.suppress_label_fade_in = true;
        debugSettings.suppress_label_snap_animation = true;
        debugSettings.show_hidden_labels = true;
        debugSettings.wireframe = true;
        points.setupDefines();
        expect(points.fade_in_time).toBe(0);
        expect(points.defines).toMatchObject({
            TANGRAM_LAYER_ORDER: true,
            TANGRAM_SHOW_HIDDEN_LABELS: true,
            TANGRAM_WIREFRAME: true
        });
    });

    test('resolves sprites, defaults, missing sprites, and sizes', () => {
        const points = createPoints();
        const previous = Texture.textures;
        Texture.textures = {icons: {
            sprites: {cafe: [0, 0, 16, 16]},
            width: 64,
            height: 64
        }};
        vi.spyOn(Texture, 'getSpriteInfo').mockImplementation((texture, sprite) =>
            sprite === 'cafe' ? {css_size: [16, 16], texture} : undefined);
        expect(points.hasSprites({texture: 'icons'})).toBeTruthy();
        const info = points.getSpriteInfo({texture: 'icons'}, 'cafe');
        expect(info.sprite).toBe('cafe');
        expect(points.parseSprite({texture: 'icons'}, {sprite: () => 'missing', sprite_default: 'cafe'}, {})).toMatchObject({sprite: 'cafe'});
        expect(points.getSpriteInfo({texture: 'icons'}, 'missing')).toBeUndefined();
        expect(points.texture_missing_sprites.icons.missing).toBe(true);

        const style = {};
        points.calcSize({size: null}, style, {css_size: [18, 20]}, {});
        expect(style.size).toEqual([18, 20]);
        points.calcSize({size: null}, style, null, {});
        expect(style.size).toEqual([16, 16]);
        Texture.textures = previous;
    });

    test('queues valid point features with outlines, layout, and text links', () => {
        const points = createPoints();
        const tile = {generation: 3, id: 'tile', units_per_pixel: 1};
        const context = {feature: {}, layer: 'places', tile, zoom: 10};
        const draw = points._preprocess({
            anchor: ['top'],
            angle: 45,
            buffer: 2,
            color: '#ff0000',
            layers: ['places'],
            offset: [1, 2],
            order: 1,
            outline: {alpha: 0.5, color: '#000000', width: 2},
            placement: 'vertex',
            priority: 1,
            repeat_distance: 20,
            size: 20,
            text: {font: {fill: '#fff', size: '12px'}, optional: false, text_source: 'name'}
        });
        vi.spyOn(Collision, 'addStyle').mockImplementation(() => {});
        vi.spyOn(points, 'parseTextFeature').mockReturnValue({draw: {}, layout: {priority: 5}, text: 'Cafe'});
        const queue = vi.spyOn(points, 'queueFeature').mockImplementation(() => {});
        points.addFeature({geometry: {type: 'Point', coordinates: [0, 0]}, properties: {name: 'Cafe'}}, draw, context);
        expect(queue).toHaveBeenCalled();
        const queued = queue.mock.calls[0][0];
        expect(queued.style.size).toEqual([22, 22]);
        expect(queued.style.outline_edge_pct).toBeGreaterThan(0);
        expect(queued.text_feature.layout.parent).toBe(queued.style);
        expect(Collision.addStyle).toHaveBeenCalledTimes(2);

        points.addFeature({geometry: {type: 'Point'}, properties: {}}, draw, {...context, tile: {...tile, generation: 2}});
        expect(queue).toHaveBeenCalledTimes(1);
    });

    test('validates projected point heights through preprocessing and dynamic scene expressions', () => {
        const points = createPoints();
        points.cpu_projection = {type: 'equal-earth', allowElevation: true};
        const tile = {generation: 3, id: 'tile', units_per_pixel: 1};
        const feature = {properties: {height: 12}, geometry: {type: 'Point', coordinates: [0, 0]}};
        const context = {feature, layer: 'places', tile, zoom: 10};
        vi.spyOn(Collision, 'addStyle').mockImplementation(() => {});
        const queue = vi.spyOn(points, 'queueFeature').mockImplementation(() => {});
        const drawHeight = height => points._preprocess({color: '#fff', size: 20, z: height});
        for (const height of [NaN, 'bad', [[10, NaN]], () => NaN,
            compileFunctionString('function() { return NaN; }', StyleParser.wrapFunction)]) {
            expect(() => points.addFeature(feature, drawHeight(height), context)).toThrow('height');
        }
        const height = compileFunctionString('function() { return feature.height; }', StyleParser.wrapFunction);
        points.addFeature(feature, drawHeight(height), context);
        expect(queue).toHaveBeenLastCalledWith(expect.objectContaining({
            style: expect.objectContaining({z: 192, projected_height: 12})
        }), tile);
        const failedHeight = () => { throw new Error('height expression failed'); };
        expect(() => points.addFeature(feature, drawHeight(failedHeight), context)).toThrow('height expression failed');
        points.cpu_projection = undefined;
        points.addFeature(feature, drawHeight(NaN), context);
        expect(queue).toHaveBeenLastCalledWith(expect.objectContaining({
            style: expect.objectContaining({z: 0})
        }), tile);
    });

    test('computes priority variants and starts missing tile queues', () => {
        const points = createPoints();
        const tile = {id: 'tile', units_per_pixel: 2};
        points.computeLayout({}, {id: 1}, {anchor: 'top', priority: context => context.rank}, {layer: 'places', rank: 4}, tile);
        expect(points.computeLayout({}, {}, {priority: null}, {layer: 'places'}, tile).priority).toBe(4294967295);
        expect(points.computeLayout({}, {}, {priority: 2}, {layer: 'places'}, tile).priority).toBe(2);
        points.queueFeature({id: 1}, tile);
        points.queueFeature({id: 2}, tile);
        expect(points.queues.tile).toHaveLength(2);
        expect(points.tile_data.tile).toBeDefined();
    });

    test('builds point and curved-label vertex templates', () => {
        const points = createPoints();
        const pointLabel = label();
        const style = {
            alpha: 0.5,
            color: [1, 0.5, 0.25, 1],
            label: pointLabel,
            order: 2,
            outline_alpha: 0.25,
            outline_color: [0, 1, 0, 1],
            outline_edge_pct: 0.2,
            selection_color: [1, 1, 1, 1],
            z: 3
        };
        const portable = mesh();
        expect(points.makeVertexTemplate(style, portable)).toContain(3);
        expect(points.addCustomAttributesToVertexTemplate).toHaveBeenCalled();

        const tileMesh = mesh({variant: {selection: 1, shader_point: false}, uniforms: {}});
        points.getTileMesh = vi.fn(() => tileMesh);
        points.makeVertexTemplate = vi.fn(() => []);
        points.buildQuad = vi.fn(() => 2);
        points.trackLabel = vi.fn();
        expect(points.buildStraightLabel(pointLabel, {...style, size: [10, 5], texcoords: [0, 1], texture: 'icons'}, {tile: {}})).toBe(2);
        expect(tileMesh.uniforms).toMatchObject({u_texture: 'icons', u_point_type: 1, u_apply_color_blocks: true});

        const curved = label({
            angles: [[1, 2]],
            num_segments: 1,
            offsets: [[3, 4]],
            pre_angles: [[5, 6]],
            type: 'curved'
        });
        const curvedStyle = {
            ...style,
            label: curved,
            label_textures: ['atlas'],
            size: {curved: [[10, 5]]},
            texcoords: {curved: [{texcoord: [0, 1]}]},
            texcoords_stroke: [[0, 1]]
        };
        expect(points.buildCurvedLabel(curved, curvedStyle, {tile: {}})).toBe(4);
        expect(points.build(curvedStyle, {tile: {}})).toBe(4);
    });

    test('builds all geometry pass-throughs and label tracking branches', () => {
        const points = createPoints();
        points.build = vi.fn(() => 2);
        expect(points.buildLines([], {}, {})).toBe(2);
        expect(points.buildPoints([], {}, {})).toBe(2);
        expect(points.buildPolygons([], {}, {})).toBe(2);

        const targetMesh = mesh();
        points.trackLabel(label(), 12, targetMesh, 2);
        expect(targetMesh.labels[7].ranges).toEqual([[40, 4]]);
        const untracked = mesh();
        points.trackLabel(label({layout: {collide: false}}), null, untracked, 2);
        expect(untracked.labels).toBeUndefined();
        expect(points.buildQuad([0, 0], [0, 2])).toBe(0);
    });

    test('caches GLSL and WGSL layouts and passes fade time to meshes', () => {
        const points = createPoints();
        points.shader_language = 'glsl';
        const textured = points.vertexLayoutForMeshVariant({selection: 0, shader_point: false});
        expect(points.vertexLayoutForMeshVariant({selection: 1, shader_point: false})).toBe(textured);
        expect(textured.index).toHaveProperty('a_texcoord');
        const shader = points.vertexLayoutForMeshVariant({selection: 1, shader_point: true});
        expect(shader).not.toBe(textured);

        points.shader_language = 'wgsl';
        const portable = points.vertexLayoutForMeshVariant({});
        expect(portable.index).toHaveProperty('a_point_type');
        expect(points.vertexLayoutForMeshVariant({shader_point: true})).toBe(portable);

        points.fade_in_time = 0.15;
        vi.spyOn(Style, 'makeMesh').mockReturnValue({mesh: true});
        expect(points.makeMesh({}, null, {uniforms: {}})).toEqual({mesh: true});
        expect(Style.makeMesh).toHaveBeenCalledWith({}, null, expect.objectContaining({fade_in_time: 0.15}));
    });
});
