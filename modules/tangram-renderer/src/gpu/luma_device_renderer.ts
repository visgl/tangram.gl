// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// @ts-nocheck

import { Buffer, Texture } from '@luma.gl/core';
import type {Device} from '@luma.gl/core';

/**
 * Portable Tangram GPU backend implemented exclusively with the luma.gl Device API.
 *
 * This class deliberately never reads `device.handle`. It owns resources and draw
 * submission while Tangram continues to own tile building and scene traversal.
 *
 * @implements {import('./tangram_gpu_backend').TangramGPUBackend}
 */
export default class LumaDeviceRenderer {
    declare readonly device: Device;

    constructor(device) {
        validateDevice(device);
        this.device = device;
        this.pipeline_cache = new WeakMap();
        this.vertex_array_cache = new WeakMap();
        this.mesh_uniform_buffer_cache = new WeakMap();
        this.pipelines = new Set();
        this.vertex_arrays = new Set();
        this.mesh_uniform_buffers = new Set();
    }

    /** Shader language selected by the host device. */
    get shaderLanguage() {
        return this.device.info.shadingLanguage;
    }

    /** Maximum supported two-dimensional texture dimension. */
    get maxTextureSize() {
        return this.device.limits && this.device.limits.maxTextureDimension2D;
    }

    /**
     * Returns the resource factories consumed by Tangram Scene and Style objects.
     */
    getSceneOptions() {
        return {
            enableUniformBuffers: true,
            deviceShaderCompilation: true,
            shaderLanguage: this.shaderLanguage,
            uniformBufferFactory: options => this.createUniformBuffer(options),
            shaderFactory: options => this.createShader(options),
            shaderProgramValidator: options => this.validateShaderProgram(options),
            meshBufferFactory: options => this.createMeshBuffer(options),
            textureFactory: options => this.createTexture(options),
            maxTextureSize: this.maxTextureSize,
            meshRenderer: this
        };
    }

    /** Creates a luma.gl uniform buffer. */
    createUniformBuffer(options) {
        if (options.usage !== 'uniform') {
            throw new Error(`unsupported Tangram buffer usage '${options.usage}'`);
        }
        return this.device.createBuffer({
            id: `tangram-${options.id}`,
            byteLength: options.byteLength,
            usage: Buffer.UNIFORM | Buffer.COPY_DST
        });
    }

    /** Creates a shader in the language supported by the active device. */
    createShader(options) {
        const shader_options = {
            id: `tangram-${options.id}`,
            language: options.language || this.device.info.shadingLanguage,
            stage: options.stage,
            source: options.source
        };
        if (options.entryPoint) {
            shader_options.entryPoint = options.entryPoint;
        }
        return this.device.createShader(shader_options);
    }

    /** Validates a device-owned shader pair when the backend supports layout-free linking. */
    validateShaderProgram({ id, vertexShader, fragmentShader }) {
        // A WebGL program can only be linked against its concrete vertex
        // layout. Tangram does not know that layout until the first mesh draw,
        // where getPipeline() creates the real pipeline with the required
        // attributes. An empty validation layout incorrectly rejects shaders
        // such as TRON roads that declare style-specific vertex attributes.
        if (this.device.type === 'webgl') {
            return;
        }
        const pipeline = this.device.createRenderPipeline({
            id: `tangram-${id}-validation`,
            vs: vertexShader,
            fs: fragmentShader,
            topology: 'triangle-list',
            bufferLayout: [],
            disableWarnings: true
        });
        try {
            if (pipeline.isErrored) {
                throw new Error(`Tangram shader program '${id}' failed device link validation`);
            }
        }
        finally {
            pipeline.destroy();
        }
    }

    /** Creates a luma.gl vertex or index buffer. */
    createMeshBuffer(options) {
        const usage = options.usage === 'vertex' ? Buffer.VERTEX :
            options.usage === 'index' ? Buffer.INDEX : null;
        if (usage == null) {
            throw new Error(`unsupported Tangram mesh buffer usage '${options.usage}'`);
        }
        const props = {
            id: `tangram-${options.id}`,
            usage: usage | Buffer.COPY_DST,
            data: options.data
        };
        if (options.indexType) {
            props.indexType = options.indexType;
        }
        return this.device.createBuffer(props);
    }

    /** Creates and initializes a luma.gl texture. */
    createTexture(options) {
        const mipmapped = options.filtering === 'mipmap' && this.device.type === 'webgl';
        const filter = options.filtering === 'nearest' ? 'nearest' : 'linear';
        const texture = this.device.createTexture({
            id: `tangram-${options.id}`,
            width: options.width,
            height: options.height,
            format: 'rgba8unorm',
            usage: Texture.COPY_DST | Texture.SAMPLE | Texture.RENDER,
            mipLevels: mipmapped ?
                Math.floor(Math.log2(Math.max(options.width, options.height))) + 1 : 1,
            sampler: {
                minFilter: filter,
                magFilter: filter,
                mipmapFilter: mipmapped ? 'linear' : 'none',
                addressModeU: options.repeat ? 'repeat' : 'clamp-to-edge',
                addressModeV: options.repeat ? 'repeat' : 'clamp-to-edge'
            }
        });

        try {
            if (options.data != null) {
                if (ArrayBuffer.isView(options.data) || options.data instanceof ArrayBuffer) {
                    texture.writeData(options.data, {
                        width: options.width,
                        height: options.height
                    });
                }
                else {
                    texture.copyExternalImage({
                        image: options.data,
                        width: options.width,
                        height: options.height,
                        flipY: options.flipY,
                        premultipliedAlpha: options.premultipliedAlpha
                    });
                }
                if (mipmapped) {
                    texture.generateMipmapsWebGL();
                }
            }
            return texture;
        }
        catch (error) {
            texture.destroy();
            throw error;
        }
    }

    /** Translates normalized Tangram state into luma.gl pipeline parameters. */
    getRenderPipelineParameters({ depthTest, depthWrite, cullFace, blend }) {
        const parameters = {
            cullMode: cullFace ? 'back' : 'none',
            depthCompare: depthTest ? 'less' : 'always',
            depthWriteEnabled: depthWrite,
            blend: Boolean(blend && blend !== 'opaque')
        };

        if (blend === 'overlay' || blend === 'inlay' || blend === 'translucent') {
            Object.assign(parameters, {
                blendColorOperation: 'add',
                blendColorSrcFactor: 'src-alpha',
                blendColorDstFactor: 'one-minus-src-alpha',
                blendAlphaOperation: 'add',
                blendAlphaSrcFactor: 'one',
                blendAlphaDstFactor: 'one-minus-src-alpha'
            });
        }
        else if (blend === 'add') {
            Object.assign(parameters, {
                blendColorOperation: 'add',
                blendColorSrcFactor: 'one',
                blendColorDstFactor: 'one',
                blendAlphaOperation: 'add',
                blendAlphaSrcFactor: 'one',
                blendAlphaDstFactor: 'one'
            });
        }
        else if (blend === 'multiply') {
            Object.assign(parameters, {
                blendColorOperation: 'add',
                blendColorSrcFactor: 'zero',
                blendColorDstFactor: 'src',
                blendAlphaOperation: 'add',
                blendAlphaSrcFactor: 'one',
                blendAlphaDstFactor: 'one-minus-src-alpha'
            });
        }

        return parameters;
    }

    /** Draws one Tangram mesh into a host-provided luma.gl RenderPass. */
    drawMesh({ mesh, program, renderPass, renderState, visibleTime }) {
        if (!renderPass || !program || !program.vertex_shader_resource ||
            !program.fragment_shader_resource) {
            throw new Error('Tangram luma renderer requires an active render pass and shader resources');
        }

        const descriptor = mesh.getDrawDescriptor();
        const pipeline = this.getPipeline(program, mesh.vertex_layout, descriptor, renderState);

        if (mesh.uniforms) {
            program.saveUniforms(mesh.uniforms);
            program.setUniforms(mesh.uniforms, false);
        }

        try {
            program.uniform('1f', 'u_visible_time', visibleTime);
            const bindings = program.getBindings();
            this.snapshotMeshUniformBindings(mesh, program, bindings);
            assertPipelineBindings(pipeline, bindings);
            const vertex_array = this.getVertexArray(mesh, pipeline, descriptor);
            renderPass.setPipeline(pipeline);
            renderPass.setBindings(bindings);
            renderPass.setVertexArray(vertex_array);
            const uniforms = program.getUniformValues();
            const draw_succeeded = renderPass.draw({
                vertexCount: descriptor.indexBuffer ? undefined : descriptor.vertexCount,
                indexCount: descriptor.indexBuffer ? descriptor.indexCount : undefined,
                uniforms: this.device.type === 'webgl' ? uniforms : undefined
            });
            return draw_succeeded === false && pipeline.isPending === true;
        }
        finally {
            if (mesh.uniforms) {
                program.restoreUniforms(mesh.uniforms);
            }
        }
    }

    /** Destroys cached luma.gl pipelines and vertex arrays. */
    destroy() {
        for (const uniform_buffer of this.mesh_uniform_buffers) {
            uniform_buffer.destroy();
        }
        for (const vertex_array of this.vertex_arrays) {
            vertex_array.destroy();
        }
        for (const pipeline of this.pipelines) {
            pipeline.destroy();
        }
        this.mesh_uniform_buffers.clear();
        this.vertex_arrays.clear();
        this.pipelines.clear();
    }

    /** Copies mutable uniform blocks into storage unique to the encoded mesh draw. */
    snapshotMeshUniformBindings(mesh, program, bindings) {
        const uniform_blocks = program.uniform_blocks || {};
        const snapshot_blocks = Object.entries(uniform_blocks)
            .filter(([, uniform_buffer]) =>
                uniform_buffer.snapshot_per_mesh && uniform_buffer.data
            );
        if (snapshot_blocks.length === 0) {
            return;
        }

        let mesh_buffers = this.mesh_uniform_buffer_cache.get(mesh);
        if (!mesh_buffers) {
            mesh_buffers = new Map();
            this.mesh_uniform_buffer_cache.set(mesh, mesh_buffers);
        }
        for (const [name, uniform_buffer] of snapshot_blocks) {
            let buffer = mesh_buffers.get(name);
            if (!buffer) {
                buffer = this.device.createBuffer({
                    id: `tangram-mesh-${mesh.id}-${name}-uniforms`,
                    byteLength: uniform_buffer.byteLength,
                    usage: Buffer.UNIFORM | Buffer.COPY_DST
                });
                mesh_buffers.set(name, buffer);
                this.mesh_uniform_buffers.add(buffer);
            }
            buffer.write(new Uint8Array(uniform_buffer.data));
            bindings[name] = buffer;
        }
    }

    getPipeline(program, vertex_layout, descriptor, render_state) {
        let layouts = this.pipeline_cache.get(program);
        if (!layouts) {
            layouts = new WeakMap();
            this.pipeline_cache.set(program, layouts);
        }
        let topologies = layouts.get(vertex_layout);
        if (!topologies) {
            topologies = new Map();
            layouts.set(vertex_layout, topologies);
        }
        let states = topologies.get(descriptor.topology);
        if (!states) {
            states = new Map();
            topologies.set(descriptor.topology, states);
        }
        const state_key = JSON.stringify(render_state || {});
        let pipeline = states.get(state_key);
        if (!pipeline) {
            const pipeline_options = {
                id: `tangram-${program.name || program.id}-${descriptor.topology}-${states.size}`,
                vs: program.vertex_shader_resource,
                fs: program.fragment_shader_resource,
                bufferLayout: [descriptor.bufferLayout],
                topology: descriptor.topology,
                disableWarnings: true
            };
            if (render_state) {
                pipeline_options.parameters = render_state;
            }
            pipeline = this.device.createRenderPipeline(pipeline_options);
            states.set(state_key, pipeline);
            this.pipelines.add(pipeline);
        }
        return pipeline;
    }

    getVertexArray(mesh, pipeline, descriptor) {
        let pipelines_for_mesh = this.vertex_array_cache.get(mesh);
        if (!pipelines_for_mesh) {
            pipelines_for_mesh = new WeakMap();
            this.vertex_array_cache.set(mesh, pipelines_for_mesh);
        }
        let vertex_array = pipelines_for_mesh.get(pipeline);
        if (vertex_array) {
            return vertex_array;
        }

        vertex_array = this.device.createVertexArray({
            id: `tangram-mesh-${mesh.id}-${pipeline.id}`,
            shaderLayout: pipeline.shaderLayout,
            bufferLayout: pipeline.bufferLayout
        });
        const attributes = new Map(
            pipeline.shaderLayout.attributes.map(attribute => [attribute.name, attribute])
        );
        for (const attribute of descriptor.bufferLayout.attributes) {
            const shader_attribute = attributes.get(attribute.attribute);
            if (shader_attribute) {
                vertex_array.setBuffer(shader_attribute.location, descriptor.vertexBuffer);
            }
        }
        for (const attribute of descriptor.staticAttributes) {
            const shader_attribute = attributes.get(attribute.attribute);
            if (shader_attribute) {
                if (this.device.type === 'webgpu') {
                    throw new Error(
                        `Tangram WebGPU renderer requires '${attribute.attribute}' in a vertex buffer`
                    );
                }
                vertex_array.setConstantWebGL(
                    shader_attribute.location,
                    new Float32Array(attribute.value)
                );
            }
        }
        if (descriptor.indexBuffer) {
            vertex_array.setIndexBuffer(descriptor.indexBuffer);
        }

        pipelines_for_mesh.set(pipeline, vertex_array);
        this.vertex_arrays.add(vertex_array);
        return vertex_array;
    }
}

function validateDevice(device) {
    if (!device || !device.info ||
        typeof device.createBuffer !== 'function' ||
        typeof device.createShader !== 'function' ||
        typeof device.createTexture !== 'function' ||
        typeof device.createRenderPipeline !== 'function' ||
        typeof device.createVertexArray !== 'function') {
        throw new Error('Tangram requires a luma.gl Device');
    }
}

function assertPipelineBindings(pipeline, bindings) {
    for (const binding of pipeline.shaderLayout.bindings) {
        if (binding.type === 'sampler' && binding.name.endsWith('Sampler')) {
            const texture_name = binding.name.slice(0, -'Sampler'.length);
            if (bindings[texture_name]) {
                continue;
            }
        }
        if (binding.type !== 'uniform' && binding.type !== 'texture' && binding.type !== 'sampler') {
            throw new Error(`Tangram luma renderer does not support '${binding.type}' bindings`);
        }
        if (!bindings[binding.name]) {
            throw new Error(`Tangram luma renderer is missing '${binding.name}' binding`);
        }
    }
}
