// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen

import chai from 'chai';
import {expect, test} from 'vitest';
let assert = chai.assert;

import {StyleManager} from '../src/styles/style_manager';
import {Style} from '../src/styles/style';
import Context from '../src/gl/context';
import ShaderProgram from '../src/gl/shader_program';
import Camera from '../src/scene/camera';
import Light from '../src/lights/light';

import sampleScene from './fixtures/sample-scene.json';

var canvas, gl;

describe('Styles:', () => {

    let style_manager;

    beforeEach(() => {
        style_manager = new StyleManager();
    });

    describe('StyleManager:', () => {

        beforeEach(() => {
            // These create global shader blocks required by all rendering styles
            Camera.create('default', null, { type: 'flat' });
            Light.inject();

            canvas = document.createElement('canvas');
            gl = Context.getContext(canvas, { alpha: false });

            style_manager.init();
        });

        afterEach(() => {
            style_manager.destroy();
            canvas = null;
            gl = null;
        });

        it('initializes built-in styles', () => {
            assert.equal(style_manager.styles.polygons.constructor, Style.constructor);
            assert.equal(style_manager.styles.points.constructor, Style.constructor);
            assert.equal(style_manager.styles.text.constructor, Style.constructor);
        });

        it('creates a custom style', () => {
            style_manager.create('rainbow', sampleScene.styles.rainbow);
            assert.equal(style_manager.styles.rainbow.constructor, Style.constructor);
            assert.equal(style_manager.styles.rainbow.base, 'polygons');
        });

        test('uses the renderer shader language for worker-built vertex layouts', () => {
            style_manager.build({});
            style_manager.initStyles({ shader_language: 'wgsl' });
            const points = style_manager.styles.points;
            const layout = points.vertexLayoutForMeshVariant({
                key: 'portable-points',
                selection: 1,
                shader_point: true
            });

            expect(points.shader_language).toBe('wgsl');
            expect(layout.index).toHaveProperty('a_point_type');
            const dynamic_attributes = layout.dynamic_attribs.map(attribute => attribute.name);
            expect(dynamic_attributes).toContain('a_texcoord');
            expect(dynamic_attributes).toContain('a_outline_color');

            const lines = style_manager.styles.lines;
            const line_layout = lines.vertexLayoutForMeshVariant({
                key: 'portable-lines',
                offset: 0,
                z_or_offset: 0,
                texcoords: 0,
                selection: 0
            });
            const texcoord_attribute = line_layout.dynamic_attribs.find(
                attribute => attribute.name === 'a_texcoord'
            );
            expect(lines.shader_language).toBe('wgsl');
            expect(texcoord_attribute.type).toBe(gl.FLOAT);
            expect(texcoord_attribute.normalized).toBe(false);
            for (const attribute_name of ['a_offset', 'a_z_and_offset_scale']) {
                const attribute = line_layout.dynamic_attribs.find(
                    candidate => candidate.name === attribute_name
                );
                expect(attribute.static).toBeNull();
                expect(
                    line_layout.getBufferLayout().attributes.find(
                        candidate => candidate.attribute === attribute_name
                    ).format
                ).toBe('sint16x2');
            }

            const line_vertex_template = lines.makeVertexTemplate({
                width_scale: 0,
                order: 1,
                z: 0,
                offset_scale: 0,
                selection_color: [0, 0, 0, 1],
                color: [0.25, 0.5, 0.75, 1]
            }, { variant: {
                offset: 0,
                z_or_offset: 0,
                texcoords: 0,
                selection: 0
            }});
            expect(line_vertex_template.slice(6, 10)).toEqual([0, 0, 0, 0]);
            expect(line_layout.dynamic_attribs.map(attribute => attribute.name)).toContain('a_selection_color');

            const polygons = style_manager.styles.polygons;
            const polygon_layout = polygons.vertexLayoutForMeshVariant({
                key: 'portable-polygons',
                normal: 0,
                selection: 0,
                texcoords: 0
            });
            const normal_attribute = polygon_layout.dynamic_attribs.find(
                attribute => attribute.name === 'a_normal'
            );
            expect(polygons.shader_language).toBe('wgsl');
            expect(normal_attribute.size).toBe(4);
            expect(normal_attribute.static).toBeNull();
            expect(
                polygon_layout.getBufferLayout().attributes.find(
                    attribute => attribute.attribute === 'a_normal'
                ).format
            ).toBe('snorm8x4');
            expect(polygon_layout.dynamic_attribs.map(attribute => attribute.name)).toContain('a_selection_color');
        });

        describe('builds custom styles w/dependencies from stylesheet', () => {

            beforeEach(() => {
                ShaderProgram.reset();
                style_manager.build(sampleScene.styles);
                style_manager.initStyles();
            });

            it('compiles parent custom style', () => {
                style_manager.styles.rainbow.setGL(gl);
                style_manager.styles.rainbow.getProgram();
                assert.equal(style_manager.styles.rainbow.constructor, Style.constructor);
                assert.equal(style_manager.styles.rainbow.base, 'polygons');
                assert.ok(style_manager.styles.rainbow.program.compiled);
            });

            it('compiles child style dependent on another custom style', () => {
                style_manager.styles.rainbow_child.setGL(gl);
                style_manager.styles.rainbow_child.getProgram();
                assert.equal(style_manager.styles.rainbow_child.constructor, Style.constructor);
                assert.equal(style_manager.styles.rainbow_child.base, 'polygons');
                assert.ok(style_manager.styles.rainbow_child.program.compiled);
            });

            it('compiles a style with the same style mixed by multiple ancestors', () => {
                style_manager.styles.descendant.setGL(gl);
                style_manager.styles.descendant.getProgram();
                assert.equal(style_manager.styles.descendant.constructor, Style.constructor);
                assert.equal(style_manager.styles.descendant.base, 'polygons');
                assert.ok(style_manager.styles.descendant.program.compiled);
            });

        });

    });

    describe('Style:', () => {

        beforeEach(() => {
            canvas = document.createElement('canvas');
            gl = Context.getContext(canvas, { alpha: false });
            style_manager.init();
        });

        afterEach(() => {
            style_manager.destroy();
            canvas = null;
            gl = null;
        });

        it('compiles a program', () => {
            style_manager.styles.polygons.init();
            style_manager.styles.polygons.setGL(gl);
            style_manager.styles.polygons.getProgram();
            assert.ok(style_manager.styles.polygons.program.compiled);
        });

        it('injects a dependent uniform in a custom style', () => {
            style_manager.create('scale', sampleScene.styles.scale);
            style_manager.styles.scale.init();
            style_manager.styles.scale.setGL(gl);
            style_manager.styles.scale.getProgram();
            assert.ok(style_manager.styles.scale.program.compiled);
        });

    });

});
