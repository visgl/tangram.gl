// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import { assert } from 'chai';
import Context from '../src/gl/context';
import ShaderProgram from '../src/gl/shader_program';
import Texture from '../src/gl/texture';
import UniformBuffer from '../src/gl/uniform_buffer';
import {StyleManager} from '../src/styles/style_manager';
import Camera from '../src/scene/camera';
import Light from '../src/lights/light';
import Tile from '../src/tile/tile';
import {Matrix4} from '@math.gl/core';

describe('UniformBuffer', function () {
    it('creates a std140-compatible layout and declaration', function () {
        const layout = UniformBuffer.createLayout({
            time: 'float',
            resolution: 'vec2',
            map_position: 'vec3',
            projection: 'mat4',
            normal: 'mat3'
        });

        assert.strictEqual(layout.uniforms.time.offset, 0);
        assert.strictEqual(layout.uniforms.resolution.offset, 8);
        assert.strictEqual(layout.uniforms.map_position.offset, 16);
        assert.strictEqual(layout.uniforms.projection.offset, 32);
        assert.strictEqual(layout.uniforms.normal.offset, 96);
        assert.strictEqual(layout.byte_length, 144);

        const uniform_buffer = new UniformBuffer(createFakeWebGL2Context(), {
            name: 'TangramView',
            uniforms: { time: 'float', resolution: 'vec2', projection_mode: 'int' }
        });
        assert.strictEqual(uniform_buffer.getDeclaration(), [
            'layout(std140) uniform TangramView {',
            '    float time;',
            '    vec2 resolution;',
            '    highp int projection_mode;',
            '};'
        ].join('\n'));
        assert.strictEqual(uniform_buffer.getDeclaration({ language: 'wgsl', group: 2 }), [
            'struct TangramViewUniforms {',
            '    time: f32,',
            '    resolution: vec2<f32>,',
            '    projection_mode: i32,',
            '};',
            '@group(2) @binding(0) var<uniform> TangramView: TangramViewUniforms;'
        ].join('\n'));
        assert.deepEqual(uniform_buffer.getBindingLayout({ group: 2 }), {
            type: 'uniform',
            name: 'TangramView',
            group: 2,
            location: 0,
            minBindingSize: 32
        });

        const padded_uniform_buffer = new UniformBuffer(createFakeWebGL2Context(), {
            name: 'TangramCamera',
            binding: 3,
            uniforms: { eye: 'vec3', panning: 'bool' }
        });
        assert.strictEqual(padded_uniform_buffer.layout.uniforms.eye.offset, 0);
        assert.strictEqual(padded_uniform_buffer.layout.uniforms.panning.offset, 12);
        assert.strictEqual(padded_uniform_buffer.byteLength, 16);
        assert.strictEqual(padded_uniform_buffer.getDeclaration({ language: 'wgsl' }), [
            'struct TangramCameraUniforms {',
            '    eye: vec3<f32>,',
            '    panning: u32,',
            '};',
            '@group(0) @binding(3) var<uniform> TangramCamera: TangramCameraUniforms;'
        ].join('\n'));
    });

    it('packs, uploads, and binds values to a program binding point', function () {
        const gl = createFakeWebGL2Context();
        const program = {};
        const uniform_buffer = new UniformBuffer(gl, {
            name: 'TangramView',
            binding: 3,
            uniforms: {
                resolution: 'vec2',
                map_position: 'vec3',
                panning: 'bool',
                normal: 'mat3'
            }
        });

        uniform_buffer.setUniforms({
            resolution: [800, 600],
            map_position: [-74, 40, 16.25],
            panning: true,
            normal: [1, 2, 3, 4, 5, 6, 7, 8, 9]
        });

        assert.isTrue(uniform_buffer.bind(program));
        assert.isFalse(uniform_buffer.upload(), 'bind uploads dirty data once');
        assert.deepEqual(gl.uniform_block_queries, [[program, 'TangramView']]);
        assert.deepEqual(gl.uniform_block_bindings, [[program, 2, 3]]);
        assert.deepEqual(gl.buffer_base_bindings, [[gl.UNIFORM_BUFFER, 3, uniform_buffer.buffer]]);
        assert.lengthOf(gl.uploads, 1);

        const floats = new Float32Array(uniform_buffer.data);
        assert.deepEqual(Array.from(floats.slice(0, 2)), [800, 600]);
        assert.deepEqual(Array.from(floats.slice(4, 7)), [-74, 40, 16.25]);
        assert.strictEqual(new Int32Array(uniform_buffer.data)[7], 1);
        assert.deepEqual(Array.from(floats.slice(8, 11)), [1, 2, 3]);
        assert.deepEqual(Array.from(floats.slice(12, 15)), [4, 5, 6]);
        assert.deepEqual(Array.from(floats.slice(16, 19)), [7, 8, 9]);

        uniform_buffer.setUniform('panning', false);
        assert.isTrue(uniform_buffer.bind(program));
        assert.lengthOf(gl.uploads, 2, 'dirty data uploads while reusing the same program');
        assert.lengthOf(gl.uniform_block_queries, 1, 'program block index is cached');
        assert.lengthOf(gl.uniform_block_bindings, 1, 'program binding is configured once');
    });

    it('can delegate allocation, uploads, and destruction to an injected GPU buffer resource', function () {
        const gl = createFakeWebGL2Context();
        const writes = [];
        let destroyed = false;
        let factory_options;
        const buffer_resource = {
            get handle() { throw new Error('renderer-owned buffers must remain opaque'); },
            write(data) {
                writes.push(Array.from(data));
            },
            destroy() {
                destroyed = true;
            }
        };
        const uniform_buffer = new UniformBuffer(gl, {
            name: 'TangramView',
            binding: 3,
            bufferFactory(options) {
                factory_options = options;
                return buffer_resource;
            },
            uniforms: { time: 'float' }
        });

        assert.deepEqual(factory_options, {
            id: 'TangramView',
            byteLength: 16,
            usage: 'uniform'
        });
        assert.strictEqual(uniform_buffer.buffer, buffer_resource);
        assert.lengthOf(gl.allocations, 0, 'Tangram does not allocate raw WebGL storage');

        const program = new ShaderProgram(gl, '', '', {
            uniform_blocks: { TangramView: uniform_buffer }
        });
        assert.deepEqual(program.getUniformBlockBindingLayouts(), [{
            type: 'uniform',
            name: 'TangramView',
            group: 0,
            location: 3,
            minBindingSize: 16
        }]);
        assert.deepEqual(program.getUniformBlockBindings(), { TangramView: buffer_resource });

        uniform_buffer.setUniform('time', 0.5);
        assert.deepEqual(program.getUniformBlockBindings(), { TangramView: buffer_resource });
        assert.lengthOf(writes, 1);
        assert.strictEqual(new Float32Array(new Uint8Array(writes[0]).buffer)[0], 0.5);
        assert.lengthOf(gl.uniform_block_queries, 0, 'renderer-owned bindings skip raw program queries');
        assert.lengthOf(gl.buffer_base_bindings, 0, 'renderer-owned bindings skip raw WebGL binding');

        uniform_buffer.destroy();
        assert.isTrue(destroyed);
        assert.lengthOf(gl.deleted_buffers, 0, 'Tangram does not delete the resource handle directly');
    });

    it('uses a handle-free portable buffer without accessing WebGL', function () {
        const writes = [];
        const resource = {
            get handle() { throw new Error('portable buffers must remain opaque'); },
            write(data) { writes.push(Array.from(data)); },
            destroy() { this.destroyed = true; }
        };
        const uniform_buffer = new UniformBuffer(null, {
            name: 'TangramView',
            bufferFactory: () => resource,
            uniforms: { time: 'float' }
        });

        assert.strictEqual(uniform_buffer.buffer, resource);
        uniform_buffer.setUniform('time', 2);
        assert.isTrue(uniform_buffer.upload());
        assert.strictEqual(new Float32Array(new Uint8Array(writes[0]).buffer)[0], 2);
        assert.isFalse(uniform_buffer.bind({}));

        uniform_buffer.destroy();
        assert.isTrue(resource.destroyed);
    });

    it('rejects unsupported contexts, types, and values', function () {
        assert.isFalse(UniformBuffer.isSupported({}));
        assert.throws(() => new UniformBuffer({}, { name: 'Test' }), /WebGL2/);
        assert.throws(() => UniformBuffer.createLayout({ value: 'sampler2D' }), /unsupported/);

        const uniform_buffer = new UniformBuffer(createFakeWebGL2Context(), {
            name: 'Test',
            uniforms: { value: 'vec3' }
        });
        assert.throws(() => uniform_buffer.setUniform('missing', 1), /no uniform/);
        assert.throws(() => uniform_buffer.setUniform('value', [1, 2]), /requires 3/);
    });

    it('rebinds registered blocks when a shared-context shader program becomes current', function () {
        const gl = createFakeWebGL2Context();
        const uniform_buffer = {
            calls: [],
            bind(program) {
                this.calls.push(program);
            }
        };
        const program = new ShaderProgram(gl, '', '', {
            uniform_blocks: { TangramView: uniform_buffer }
        });
        program.program = {};
        program.compiled = true;

        ShaderProgram.resetCurrent();
        program.use();
        program.use();
        assert.deepEqual(uniform_buffer.calls, [program.program, program.program]);

        ShaderProgram.resetCurrent();
        program.use();
        assert.deepEqual(uniform_buffer.calls, [program.program, program.program, program.program]);
    });

    it('can defer uniform block bindings to an injected renderer', function () {
        const gl = createFakeWebGL2Context();
        const uniform_buffer = {
            calls: [],
            bind(program) {
                this.calls.push(program);
            }
        };
        const program = new ShaderProgram(gl, '', '', {
            uniform_blocks: { TangramView: uniform_buffer },
            deferUniformBlocks: true
        });
        program.program = {};
        program.compiled = true;

        ShaderProgram.resetCurrent();
        program.use();
        program.bindUniformBlocks();
        assert.lengthOf(uniform_buffer.calls, 0);

        program.use({ bindUniformBlocks: true });
        assert.deepEqual(uniform_buffer.calls, [program.program]);
    });

    it('exposes cached scalar uniform values to an injected renderer', function () {
        const program = new ShaderProgram(createFakeWebGL2Context(), '', '');
        program.uniforms = {
            u_time: { value: 0.5 },
            u_color: { value: [1, 0, 0, 1] },
            inactive: {}
        };

        assert.deepEqual(program.getUniformValues(), {
            u_time: 0.5,
            u_color: [1, 0, 0, 1]
        });
    });

    it('exposes base luma values for one-element uniform arrays', function () {
        const program = new ShaderProgram(createFakeWebGL2Context(), '', '');
        program.uniforms = {
            'u_raster_offsets[0]': { value: [0, 0, 1] },
            'u_raster_sizes[0]': { value: [256, 256] }
        };

        assert.deepEqual(program.getUniformValues(), {
            'u_raster_offsets[0]': [0, 0, 1],
            u_raster_offsets: [0, 0, 1],
            'u_raster_sizes[0]': [256, 256],
            u_raster_sizes: [256, 256]
        });
    });

    it('defers scalar uniform writes to an injected renderer without binding a raw program', function () {
        const raw_calls = [];
        const gl = {
            useProgram() {
                raw_calls.push('useProgram');
            },
            getUniformLocation() {
                raw_calls.push('getUniformLocation');
                return {};
            },
            uniform1f() {
                raw_calls.push('uniform1f');
            }
        };
        const program = new ShaderProgram(gl, '', '', {
            deferUniformUpdates: true
        });
        program.program = {};
        program.compiled = true;

        ShaderProgram.resetCurrent();
        program.use();
        program.uniform('1f', 'u_opacity', 0.75);

        assert.strictEqual(ShaderProgram.current, program);
        assert.deepEqual(program.getUniformValues(), { u_opacity: 0.75 });
        assert.lengthOf(raw_calls, 0);
    });

    it('routes and restores mesh scalars through a per-mesh uniform block', function () {
        const resource = {
            write() {},
            destroy() {}
        };
        const line_uniforms = new UniformBuffer(null, {
            name: 'TangramLine',
            binding: 5,
            snapshotPerMesh: true,
            bufferFactory: () => resource,
            uniforms: {
                u_has_line_texture: 'bool',
                u_texture_ratio: 'float',
                u_dash_background_color: 'vec4'
            }
        });
        const program = new ShaderProgram(null, '', '', {
            shaderLanguage: 'wgsl',
            deferUniformUpdates: true,
            uniform_blocks: { TangramLine: line_uniforms }
        });
        program.compiled = true;
        line_uniforms.setUniforms({
            u_has_line_texture: false,
            u_texture_ratio: 1,
            u_dash_background_color: [0, 0, 0, 0]
        });

        program.saveUniforms({
            u_has_line_texture: true,
            u_texture_ratio: 2,
            u_dash_background_color: [1, 0, 0, 1]
        });
        program.setUniforms({
            u_has_line_texture: true,
            u_texture_ratio: 4,
            u_dash_background_color: [1, 0, 0, 1]
        });

        let integers = new Uint32Array(line_uniforms.data);
        let floats = new Float32Array(line_uniforms.data);
        assert.strictEqual(integers[0], 1);
        assert.strictEqual(floats[1], 4);
        assert.deepEqual(Array.from(floats.slice(4, 8)), [1, 0, 0, 1]);
        assert.isTrue(line_uniforms.snapshot_per_mesh);

        program.restoreUniforms({
            u_has_line_texture: true,
            u_texture_ratio: 2,
            u_dash_background_color: [1, 0, 0, 1]
        });
        integers = new Uint32Array(line_uniforms.data);
        floats = new Float32Array(line_uniforms.data);
        assert.strictEqual(integers[0], 0);
        assert.strictEqual(floats[1], 1);
        assert.deepEqual(Array.from(floats.slice(4, 8)), [0, 0, 0, 0]);

        line_uniforms.destroy();
    });

    it('defers texture uniforms and exposes luma texture bindings to an injected renderer', function () {
        const resource = { handle: {} };
        const first_texture = {
            bind() {
                throw new Error('raw texture binding should be skipped');
            },
            getResource: () => resource
        };
        const second_resource = { handle: {} };
        const second_texture = { getResource: () => second_resource };
        Texture.textures.__deferred_texture_test = first_texture;
        Texture.textures.__deferred_texture_override_test = second_texture;

        const program = new ShaderProgram(createFakeWebGL2Context(), '', '', {
            deferTextureBindings: true
        });
        program.compiled = true;
        program.setTextureUniform('u_texture', '__deferred_texture_test');
        assert.deepEqual(program.getTextureBindings(), { u_texture: resource });
        assert.deepEqual(program.getBindings(), { u_texture: resource });

        program.saveUniforms({ u_texture: true });
        program.setTextureUniform('u_texture', '__deferred_texture_override_test');
        assert.deepEqual(program.getTextureBindings(), { u_texture: second_resource });
        program.restoreUniforms({ u_texture: true });
        assert.deepEqual(program.getTextureBindings(), { u_texture: resource });

        delete Texture.textures.__deferred_texture_test;
        delete Texture.textures.__deferred_texture_override_test;
    });

    it('exposes the base luma binding for deferred sampler arrays', function () {
        const first_resource = { handle: {} };
        const second_resource = { handle: {} };
        Texture.textures.__deferred_texture_array_first = { getResource: () => first_resource };
        Texture.textures.__deferred_texture_array_second = { getResource: () => second_resource };

        const program = new ShaderProgram(createFakeWebGL2Context(), '', '', {
            deferTextureBindings: true
        });
        program.compiled = true;
        program.setUniforms({
            u_rasters: [
                '__deferred_texture_array_first',
                '__deferred_texture_array_second'
            ]
        });

        assert.deepEqual(program.getTextureBindings(), {
            'u_rasters[0]': first_resource,
            u_rasters: first_resource,
            'u_rasters[1]': second_resource
        });

        delete Texture.textures.__deferred_texture_array_first;
        delete Texture.textures.__deferred_texture_array_second;
    });

    it('exposes only the base sampler-array binding to portable shaders', function () {
        const first_resource = { handle: {} };
        const second_resource = { handle: {} };
        Texture.textures.__portable_texture_array_first = { getResource: () => first_resource };
        Texture.textures.__portable_texture_array_second = { getResource: () => second_resource };

        const program = new ShaderProgram(createFakeWebGL2Context(), '', '', {
            shaderLanguage: 'wgsl',
            deferTextureBindings: true
        });
        program.compiled = true;
        program.setUniforms({
            u_rasters: [
                '__portable_texture_array_first',
                '__portable_texture_array_second'
            ]
        });

        assert.deepEqual(program.getTextureBindings(), { u_rasters: first_resource });

        delete Texture.textures.__portable_texture_array_first;
        delete Texture.textures.__portable_texture_array_second;
    });

    it('upgrades legacy Tangram shader syntax and compiles a real WebGL2 uniform block', function () {
        const gl = document.createElement('canvas').getContext('webgl2');
        if (!gl) {
            this.skip();
            return;
        }
        gl._tangram_id = 1000;
        ShaderProgram.reset();

        const uniform_buffer = new UniformBuffer(gl, {
            name: 'TangramView',
            uniforms: { u_time: 'float' }
        });
        const program = new ShaderProgram(gl, [
            'attribute vec4 a_position;',
            'uniform float u_time;',
            'varying float v_time;',
            'void main() {',
            '    v_time = u_time;',
            '    gl_Position = a_position;',
            '}'
        ].join('\n'), [
            'uniform float u_time;',
            'varying float v_time;',
            'void main() {',
            '    gl_FragColor = vec4(v_time + u_time);',
            '}'
        ].join('\n'), {
            uniform_blocks: { TangramView: uniform_buffer }
        });

        program.compile();
        uniform_buffer.setUniform('u_time', 0.25);
        program.use();

        assert.isTrue(program.compiled);
        assert.strictEqual(program.glsl_version, 300);
        assert.strictEqual(gl.getError(), gl.NO_ERROR);

        program.destroy();
        uniform_buffer.destroy();
        ShaderProgram.reset();
    });

    it('can compile and own injected luma-style shader resources', function () {
        const gl = document.createElement('canvas').getContext('webgl2');
        if (!gl) {
            this.skip();
            return;
        }
        gl._tangram_id = 1001;
        ShaderProgram.reset();
        const shaders = [];
        const shader_factory = options => {
            const type = options.stage === 'vertex' ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER;
            const handle = gl.createShader(type);
            gl.shaderSource(handle, options.source);
            gl.compileShader(handle);
            const shader = {
                handle,
                options,
                destroyed: false,
                destroy() {
                    gl.deleteShader(handle);
                    this.destroyed = true;
                }
            };
            shaders.push(shader);
            return shader;
        };
        const program = new ShaderProgram(gl, [
            'attribute vec4 a_position;',
            'void main() {',
            '    gl_Position = a_position;',
            '}'
        ].join('\n'), [
            'void main() {',
            '    gl_FragColor = vec4(1.0);',
            '}'
        ].join('\n'), {
            glsl_version: 300,
            shaderFactory: shader_factory
        });

        program.compile();

        assert.isTrue(program.compiled);
        assert.lengthOf(shaders, 2);
        assert.strictEqual(program.vertex_shader_resource, shaders[0]);
        assert.strictEqual(program.fragment_shader_resource, shaders[1]);
        assert.include(shaders[0].options.source, 'layout(location = 0) in vec4 a_position;');
        assert.deepEqual(ShaderProgram.programs_by_source, {}, 'injected resources bypass the raw shader cache');

        program.destroy();
        assert.isTrue(shaders[0].destroyed);
        assert.isTrue(shaders[1].destroyed);
        ShaderProgram.reset();
    });

    it('compiles Tangram polygon and point styles with the TangramView block', function () {
        const gl = document.createElement('canvas').getContext('webgl2');
        if (!gl) {
            this.skip();
            return;
        }
        Context.configure(gl);
        ShaderProgram.reset();
        Camera.create('uniform-buffer-test', null, { type: 'flat' });
        Light.inject();

        const uniform_blocks = createTangramUniformBlocks(gl);
        const style_manager = new StyleManager();
        style_manager.init();

        for (const name of ['polygons', 'points']) {
            const style = style_manager.styles[name];
            style.init();
            style.setGL(gl, uniform_blocks);
            style.getProgram();
            assert.isTrue(style.program.compiled, `${name} style compiles`);
            assert.strictEqual(style.program.glsl_version, 300);
            if (style.selection_program) {
                style.getProgram('selection_program');
                assert.isTrue(style.selection_program.compiled, `${name} selection style compiles`);
                assert.strictEqual(style.selection_program.glsl_version, 300);
            }
        }
        assert.strictEqual(gl.getError(), gl.NO_ERROR);

        style_manager.destroy(gl);
        Object.values(uniform_blocks).forEach(uniform_buffer => uniform_buffer.destroy());
        ShaderProgram.reset();
    });

    it('routes camera and tile transforms through their uniform blocks', function () {
        const view = {
            aspect: 4 / 3,
            center: { meters: { x: 100, y: 200 } },
            meters_per_pixel: 1,
            size: {
                css: { width: 800, height: 600 },
                meters: { x: 800, y: 600 }
            },
            zoom: 16
        };
        const camera = Camera.create('uniform-routing-test', view, { type: 'flat' });
        camera.update();

        const camera_uniforms = createUniformRecorder();
        const tile_uniforms = createUniformRecorder();
        const program = {
            calls: [],
            uniform(...args) {
                this.calls.push(args);
            }
        };
        const matrices = {
            model: new Float64Array(16),
            model32: new Float32Array(16),
            model_view32: new Float32Array(16),
            normal32: new Float32Array(9),
            inverse_normal32: new Float32Array(9)
        };
        const tile = {
            matrix4: new Matrix4(),
            coords: { z: 14 },
            fade_in: true,
            min: { x: 10, y: 20 },
            proxied_as: null,
            proxy_order_offset: 0.5,
            span: { x: 4096, y: 4096 },
            style_z: 7
        };

        Tile.prototype.setupProgram.call(tile, matrices, program, tile_uniforms);
        camera.setupMatrices(matrices, program, tile_uniforms);
        camera.setupProgram(program, camera_uniforms);

        assert.lengthOf(program.calls, 0, 'scalar uniform path is skipped');
        assert.deepEqual(tile_uniforms.values.u_tile_origin, [10, 20, 7, 14]);
        assert.strictEqual(tile_uniforms.values.u_tile_proxy_order_offset, 0.5);
        assert.isTrue(tile_uniforms.values.u_tile_fade_in);
        assert.instanceOf(tile_uniforms.values.u_model, Float32Array);
        assert.instanceOf(tile_uniforms.values.u_modelView, Float32Array);
        assert.instanceOf(tile_uniforms.values.u_normalMatrix, Float32Array);
        assert.instanceOf(tile_uniforms.values.u_inverseNormalMatrix, Float32Array);
        assert.deepEqual(camera_uniforms.values.u_eye, [0, 0, 600]);
        assert.deepEqual(camera_uniforms.values.u_vanishing_point, [0, 0]);
        assert.instanceOf(camera_uniforms.values.u_projection, Float32Array);
    });
});

function createTangramUniformBlocks(gl) {
    return {
        TangramView: new UniformBuffer(gl, {
            name: 'TangramView',
            binding: 0,
            uniforms: {
                u_resolution: 'vec2',
                u_time: 'float',
                u_map_position: 'vec3',
                u_meters_per_pixel: 'float',
                u_device_pixel_ratio: 'float',
                u_view_pan_snap_timer: 'float',
                u_view_panning: 'bool',
                u_projection_mode: 'int'
            }
        }),
        TangramCamera: new UniformBuffer(gl, {
            name: 'TangramCamera',
            binding: 1,
            uniforms: {
                u_projection: 'mat4',
                u_eye: 'vec3',
                u_vanishing_point: 'vec2'
            }
        }),
        TangramTile: new UniformBuffer(gl, {
            name: 'TangramTile',
            binding: 2,
            uniforms: {
                u_tile_origin: 'vec4',
                u_tile_proxy_order_offset: 'float',
                u_model: 'mat4',
                u_modelView: 'mat4',
                u_normalMatrix: 'mat3',
                u_inverseNormalMatrix: 'mat3',
                u_tile_fade_in: 'bool'
            }
        })
    };
}

function createUniformRecorder() {
    return {
        values: {},
        setUniforms(values) {
            Object.assign(this.values, values);
        }
    };
}

function createFakeWebGL2Context() {
    const gl = {
        UNIFORM_BUFFER: 0x8A11,
        UNIFORM_BUFFER_BINDING: 0x8A28,
        DYNAMIC_DRAW: 0x88E8,
        INVALID_INDEX: 0xFFFFFFFF,
        current_buffer: null,
        allocations: [],
        deleted_buffers: [],
        uploads: [],
        uniform_block_queries: [],
        uniform_block_bindings: [],
        buffer_base_bindings: [],
        createBuffer() {
            return {};
        },
        deleteBuffer(buffer) {
            this.deleted_buffers.push(buffer);
        },
        getParameter(parameter) {
            return parameter === this.UNIFORM_BUFFER_BINDING ? this.current_buffer : null;
        },
        bindBuffer(target, buffer) {
            this.current_buffer = buffer;
        },
        bufferData(target, byte_length, usage) {
            this.allocations.push([target, byte_length, usage]);
        },
        bufferSubData(target, offset, data) {
            this.uploads.push([target, offset, Array.from(data)]);
        },
        getUniformBlockIndex(program, name) {
            this.uniform_block_queries.push([program, name]);
            return 2;
        },
        uniformBlockBinding(program, index, binding) {
            this.uniform_block_bindings.push([program, index, binding]);
        },
        bindBufferBase(target, binding, buffer) {
            this.buffer_base_bindings.push([target, binding, buffer]);
        },
        useProgram() {}
    };
    return gl;
}
