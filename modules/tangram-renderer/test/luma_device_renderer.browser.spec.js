// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, it, test} from 'vitest';
import LumaDeviceRenderer from '../src/gpu/luma_device_renderer';

describe('LumaDeviceRenderer', function () {
    test('WebGPU pipeline cache distinguishes offscreen attachment formats from the canvas', () => {
        const calls = [];
        const device = createDevice(calls);
        device.type = 'webgpu';
        const renderer = new LumaDeviceRenderer(device);
        const mesh = createMesh(), program = createProgram({});
        const offscreen = createRenderPass();
        offscreen.setPipeline = pipeline => { offscreen.pipeline = pipeline; };
        offscreen.props = {framebuffer: {colorAttachments: [{texture: {format: 'rgba8unorm'}}],
            depthStencilAttachment: {texture: {format: 'depth16unorm'}}}};
        renderer.drawMesh({mesh, program, renderPass: offscreen});
        const selectedPipeline = device.pipeline;
        expect(selectedPipeline.options).toMatchObject({colorAttachmentFormats: ['rgba8unorm'],
            depthStencilAttachmentFormat: 'depth16unorm'});
        renderer.drawMesh({mesh, program, renderPass: createRenderPass()});
        const canvasPipeline = device.pipeline;
        expect(canvasPipeline).not.toBe(selectedPipeline);
        renderer.drawMesh({mesh, program, renderPass: offscreen});
        expect(offscreen.pipeline).toBe(selectedPipeline);
        renderer.destroy();
        expect(selectedPipeline.destroyed).toBe(true);
        expect(canvasPipeline.destroyed).toBe(true);
    });
    it('creates portable Tangram resources without reading a backend handle', function () {
        const calls = [];
        const device = createDevice(calls);
        Object.defineProperty(device, 'handle', {
            get() {
                throw new Error('device.handle must not be read');
            }
        });
        const renderer = new LumaDeviceRenderer(device);
        const options = renderer.getSceneOptions();

        options.uniformBufferFactory({ id: 'view', usage: 'uniform', byteLength: 64 });
        options.meshBufferFactory({
            id: 'vertices',
            usage: 'vertex',
            data: new Float32Array([0, 1])
        });
        options.shaderFactory({ id: 'polygon-vertex', stage: 'vertex', source: 'shader' });
        options.textureFactory({
            id: 'atlas',
            width: 1,
            height: 1,
            filtering: 'nearest',
            data: new Uint8Array([255, 255, 255, 255])
        });

        expect(calls.map(call => call[0])).toEqual([
            'buffer', 'buffer', 'shader', 'texture', 'texture-write'
        ]);
        expect(options.meshRenderer).toBe(renderer);
        expect(options.deviceShaderCompilation).toBe(true);
        expect(options.shaderProgramValidator).toBeTypeOf('function');
        expect(options.maxTextureSize).toBe(4096);
    });

    it('validates and releases temporary shader-pair pipelines', function () {
        const device = createDevice([]);
        device.type = 'webgpu';
        device.info.shadingLanguage = 'wgsl';
        const renderer = new LumaDeviceRenderer(device);

        renderer.validateShaderProgram({
            id: 'polygons',
            vertexShader: {id: 'vertex'},
            fragmentShader: {id: 'fragment'}
        });

        expect(device.pipeline.options).toMatchObject({
            id: 'tangram-polygons-validation',
            topology: 'triangle-list',
            bufferLayout: []
        });
        expect(device.pipeline.destroyed).toBe(true);
    });

    it('rejects a shader pair that fails device link validation', function () {
        const device = createDevice([]);
        device.type = 'webgpu';
        device.info.shadingLanguage = 'wgsl';
        device.pipelineErrored = true;
        const renderer = new LumaDeviceRenderer(device);

        expect(() => renderer.validateShaderProgram({
            id: 'broken',
            vertexShader: {id: 'vertex'},
            fragmentShader: {id: 'fragment'}
        })).toThrow("Tangram shader program 'broken' failed device link validation");
        expect(device.pipeline.destroyed).toBe(true);
    });

    it('defers WebGL shader linking until the concrete mesh layout is available', function () {
        const device = createDevice([]);
        const renderer = new LumaDeviceRenderer(device);

        renderer.validateShaderProgram({
            id: 'roads-glow',
            vertexShader: {id: 'vertex'},
            fragmentShader: {id: 'fragment'}
        });

        expect(device.pipeline).toBeUndefined();
    });

    it('omits WebGL compatibility uniforms from WebGPU draw calls', function () {
        const device = createDevice([]);
        device.type = 'webgpu';
        device.info.shadingLanguage = 'wgsl';
        const renderer = new LumaDeviceRenderer(device);
        const render_pass = createRenderPass();
        const program = createProgram({ u_scale: 2 });
        const mesh = createMesh();

        expect(renderer.drawMesh({
            mesh,
            program,
            renderPass: render_pass,
            visibleTime: 0
        })).toBe(false);
        expect(render_pass.draws).toEqual([{
            vertexCount: 3,
            indexCount: undefined,
            uniforms: undefined
        }]);
    });

    it('submits a buffer-bound WebGPU mesh without WebGL compatibility uniforms', function () {
        const device = createDevice([]);
        device.type = 'webgpu';
        device.info.shadingLanguage = 'wgsl';
        const renderer = new LumaDeviceRenderer(device);
        const render_pass = createRenderPass();
        const program = createProgram({});
        const mesh = createMesh();

        expect(renderer.drawMesh({
            mesh,
            program,
            renderPass: render_pass,
            visibleTime: 0
        })).toBe(false);
        expect(render_pass.draws).toEqual([{
            vertexCount: 3,
            indexCount: undefined,
            uniforms: undefined
        }]);

        renderer.destroy();
        expect(device.pipeline.destroyed).toBe(true);
        expect(device.vertex_array.destroyed).toBe(true);
    });

    it('preserves Tangram depth, cull, and blend state in WebGPU pipelines', function () {
        const device = createDevice([]);
        device.type = 'webgpu';
        device.info.shadingLanguage = 'wgsl';
        Object.defineProperty(device, 'handle', {
            get() {
                throw new Error('device.handle must not be read');
            }
        });
        const renderer = new LumaDeviceRenderer(device);
        const render_state = Object.freeze({
            cullMode: 'back',
            depthCompare: 'less',
            depthWriteEnabled: false,
            blend: true,
            blendColorOperation: 'add',
            blendColorSrcFactor: 'src-alpha',
            blendColorDstFactor: 'one-minus-src-alpha',
            blendAlphaOperation: 'add',
            blendAlphaSrcFactor: 'one',
            blendAlphaDstFactor: 'one-minus-src-alpha'
        });

        renderer.drawMesh({
            mesh: createMesh(),
            program: createProgram({}),
            renderPass: createRenderPass(),
            renderState: render_state,
            visibleTime: 0
        });

        expect(device.pipeline.options.parameters).toBe(render_state);
    });

    it('translates Tangram render modes into luma.gl pipeline parameters', function () {
        const renderer = new LumaDeviceRenderer(createDevice([]));

        expect(renderer.getRenderPipelineParameters({
            depthTest: false,
            depthWrite: false,
            cullFace: false,
            blend: 'overlay'
        })).toEqual({
            cullMode: 'none',
            depthCompare: 'always',
            depthWriteEnabled: false,
            blend: true,
            blendColorOperation: 'add',
            blendColorSrcFactor: 'src-alpha',
            blendColorDstFactor: 'one-minus-src-alpha',
            blendAlphaOperation: 'add',
            blendAlphaSrcFactor: 'one',
            blendAlphaDstFactor: 'one-minus-src-alpha'
        });
        expect(renderer.getRenderPipelineParameters({
            depthTest: true,
            depthWrite: true,
            cullFace: true,
            blend: 'add'
        })).toMatchObject({
            cullMode: 'back',
            depthCompare: 'less',
            depthWriteEnabled: true,
            blend: true,
            blendColorSrcFactor: 'one',
            blendColorDstFactor: 'one'
        });
        expect(renderer.getRenderPipelineParameters({
            depthTest: true,
            depthWrite: true,
            cullFace: true,
            blend: 'multiply'
        })).toMatchObject({
            blend: true,
            blendColorSrcFactor: 'zero',
            blendColorDstFactor: 'src'
        });
        expect(renderer.getRenderPipelineParameters({
            depthTest: true,
            depthWrite: true,
            cullFace: true,
            blend: 'opaque'
        })).toEqual({
            cullMode: 'back',
            depthCompare: 'less',
            depthWriteEnabled: true,
            blend: false
        });
    });

    it('snapshots mutable uniform blocks per mesh for deferred WebGPU execution', function () {
        const device = createDevice([]);
        device.type = 'webgpu';
        device.info.shadingLanguage = 'wgsl';
        device.pipelineBindings = [
            { type: 'uniform', name: 'TangramTile' },
            { type: 'uniform', name: 'TangramLine' }
        ];
        const renderer = new LumaDeviceRenderer(device);
        const render_pass = createRenderPass();
        const tile_data = new ArrayBuffer(16);
        const tile_values = new Float32Array(tile_data);
        const line_data = new ArrayBuffer(16);
        const line_values = new Float32Array(line_data);
        const shared_tile_buffer = { id: 'shared-tile-buffer' };
        const shared_line_buffer = { id: 'shared-line-buffer' };
        const program = createProgram({});
        program.uniform_blocks = {
            TangramTile: {
                data: tile_data,
                byteLength: tile_data.byteLength,
                snapshot_per_mesh: true
            },
            TangramLine: {
                data: line_data,
                byteLength: line_data.byteLength,
                snapshot_per_mesh: true
            }
        };
        program.getBindings = () => ({
            TangramTile: shared_tile_buffer,
            TangramLine: shared_line_buffer
        });
        const first_mesh = createMesh();
        const second_mesh = createMesh();
        second_mesh.id = 2;

        tile_values[0] = 1;
        line_values[0] = 10;
        renderer.drawMesh({
            mesh: first_mesh,
            program,
            renderPass: render_pass,
            visibleTime: 0
        });
        tile_values[0] = 2;
        line_values[0] = 20;
        renderer.drawMesh({
            mesh: second_mesh,
            program,
            renderPass: render_pass,
            visibleTime: 0
        });

        expect(device.buffers).toHaveLength(4);
        expect(render_pass.bindings[0].TangramTile).not.toBe(shared_tile_buffer);
        expect(render_pass.bindings[0].TangramLine).not.toBe(shared_line_buffer);
        expect(render_pass.bindings[0].TangramTile).not.toBe(
            render_pass.bindings[1].TangramTile
        );
        expect(
            render_pass.bindings.map(bindings => bindings.TangramTile.writes[0][0])
        ).toEqual([1, 2]);
        expect(
            render_pass.bindings.map(bindings => bindings.TangramLine.writes[0][0])
        ).toEqual([10, 20]);

        renderer.destroy();
        expect(device.buffers.every(buffer => buffer.destroyed)).toBe(true);
        expect(device.buffers[1].destroyed).toBe(true);
    });
});

function createDevice(calls) {
    return {
        type: 'webgl',
        info: { shadingLanguage: 'glsl' },
        limits: { maxTextureDimension2D: 4096 },
        buffers: [],
        createBuffer(options) {
            calls.push(['buffer', options]);
            const buffer = {
                options,
                writes: [],
                destroyed: false,
                destroy() {
                    this.destroyed = true;
                },
                write(data) {
                    this.writes.push(Array.from(new Float32Array(
                        data.buffer,
                        data.byteOffset,
                        data.byteLength / Float32Array.BYTES_PER_ELEMENT
                    )));
                }
            };
            this.buffers.push(buffer);
            return buffer;
        },
        createShader(options) {
            calls.push(['shader', options]);
            return { destroy() {} };
        },
        createTexture(options) {
            calls.push(['texture', options]);
            return {
                writeData(data, write_options) {
                    calls.push(['texture-write', data, write_options]);
                },
                copyExternalImage() {},
                generateMipmapsWebGL() {},
                destroy() {}
            };
        },
        createRenderPipeline(options) {
            this.pipeline = {
                id: options.id,
                options,
                shaderLayout: {
                    attributes: [{ name: 'a_position', location: 0 }],
                    bindings: this.pipelineBindings || []
                },
                bufferLayout: options.bufferLayout,
                isPending: false,
                isErrored: this.pipelineErrored === true,
                destroyed: false,
                destroy() {
                    this.destroyed = true;
                }
            };
            return this.pipeline;
        },
        createVertexArray() {
            this.vertex_array = {
                destroyed: false,
                setBuffer() {},
                setIndexBuffer() {},
                destroy() {
                    this.destroyed = true;
                }
            };
            return this.vertex_array;
        }
    };
}

function createProgram(uniforms) {
    return {
        id: 1,
        name: 'polygon',
        vertex_shader_resource: {},
        fragment_shader_resource: {},
        uniform(method, name, value) {
            if (name !== 'u_visible_time' || Object.keys(uniforms).length > 0) {
                uniforms[name] = value;
            }
        },
        getBindings: () => ({}),
        getUniformValues: () => uniforms
    };
}

function createMesh() {
    return {
        id: 1,
        vertex_layout: {},
        uniforms: null,
        getDrawDescriptor: () => ({
            topology: 'triangle-list',
            vertexCount: 3,
            indexCount: 0,
            vertexBuffer: {},
            indexBuffer: null,
            bufferLayout: {
                name: 'vertices',
                byteStride: 8,
                attributes: [{ attribute: 'a_position', format: 'float32x2', byteOffset: 0 }]
            },
            staticAttributes: []
        })
    };
}

function createRenderPass() {
    return {
        draws: [],
        bindings: [],
        setPipeline() {},
        setBindings(bindings) {
            this.bindings.push(bindings);
        },
        setVertexArray() {},
        draw(options) {
            this.draws.push(options);
            return true;
        }
    };
}
