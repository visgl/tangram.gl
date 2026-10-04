// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import { Buffer, Texture } from '@luma.gl/core';
import type {Bindings, BufferProps, Device, PrimitiveTopology, RenderPipeline, RenderPipelineParameters,
    RenderPipelineProps, ShaderProps, VertexArray} from '@luma.gl/core';
import type {TangramDrawableMesh, TangramDrawableProgram, TangramGPUBackend, TangramGPUSceneOptions,
    TangramDrawableUniformBlock, TangramMeshBufferOptions, TangramMeshDrawDescriptor, TangramMeshDrawOptions, TangramRenderStateOptions,
    TangramShaderOptions, TangramShaderProgramOptions, TangramTextureOptions, TangramUniformBufferOptions} from './tangram_gpu_backend';
import {observeGPUResourceDisposal} from './resource_lifecycle';

/** Per-topology pipelines indexed by normalized render state. */
type PipelineStates = Map<PrimitiveTopology, Map<string, RenderPipeline>>;

/** Resource record deliberately contains no reference to its shader-program owner. */
type ProgramResources = {
    layouts: WeakMap<object, PipelineStates>;
    pipelines: Set<RenderPipeline>;
    disposed: boolean;
    unsubscribe: () => void;
};

/** Cached draw resources, without a strong reference to their mesh owner. */
type MeshResources = {
    vertexArrays: Map<RenderPipeline, VertexArray>;
    uniformBuffers: Map<string, {buffer: Buffer; byteLength: number}>;
    disposed: boolean;
    unsubscribe: () => void;
};

/**
 * Portable Tangram GPU backend implemented exclusively with the luma.gl Device API.
 *
 * This class deliberately never reads `device.handle`. It owns resources and draw
 * submission while Tangram continues to own tile building and scene traversal.
 *
 * @implements {import('./tangram_gpu_backend').TangramGPUBackend}
 */
export default class LumaDeviceRenderer implements TangramGPUBackend {
    declare readonly device: Device;
    /** Shader/layout/state cache; keys do not keep scene programs alive. */
    declare private pipeline_cache: WeakMap<TangramDrawableProgram, ProgramResources>;
    /** Mesh/pipeline vertex-array cache. */
    declare private mesh_resource_cache: WeakMap<TangramDrawableMesh, MeshResources>;
    /** Live program generations; released on recompilation/destruction or backend teardown. */
    declare private program_resources: Set<ProgramResources>;
    /** Live mesh resources; released on tile eviction or backend teardown. */
    declare private mesh_resources: Set<MeshResources>;
    /** A destroyed backend cannot reuse cached or host resources. */
    declare private destroyed: boolean;

    constructor(device: Device) {
        validateDevice(device);
        this.device = device;
        this.pipeline_cache = new WeakMap();
        this.mesh_resource_cache = new WeakMap();
        this.program_resources = new Set();
        this.mesh_resources = new Set();
        this.destroyed = false;
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
    getSceneOptions(): TangramGPUSceneOptions {
        this.assertAlive();
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
    createUniformBuffer(options: TangramUniformBufferOptions) {
        this.assertAlive();
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
    createShader(options: TangramShaderOptions) {
        this.assertAlive();
        const shader_options: ShaderProps = {
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
    validateShaderProgram({ id, vertexShader, fragmentShader }: TangramShaderProgramOptions) {
        this.assertAlive();
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
    createMeshBuffer(options: TangramMeshBufferOptions) {
        this.assertAlive();
        const usage = options.usage === 'vertex' ? Buffer.VERTEX :
            options.usage === 'index' ? Buffer.INDEX : null;
        if (usage == null) {
            throw new Error(`unsupported Tangram mesh buffer usage '${options.usage}'`);
        }
        const props: BufferProps = {
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
    createTexture(options: TangramTextureOptions) {
        this.assertAlive();
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
    getRenderPipelineParameters({ depthTest, depthWrite, cullFace, blend }: TangramRenderStateOptions) {
        const parameters: RenderPipelineParameters = {
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
    drawMesh({ mesh, program, renderPass, renderState, visibleTime }: TangramMeshDrawOptions) {
        this.assertAlive();
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

    /** Destroys cached pipelines, vertex arrays and uniform snapshots, not the host device. */
    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        for (const resources of this.mesh_resources) this.disposeMeshResources(resources);
        for (const resources of this.program_resources) this.disposeProgramResources(resources);
        this.pipeline_cache = new WeakMap();
        this.mesh_resource_cache = new WeakMap();
    }

    /** Copies mutable uniform blocks into storage unique to the encoded mesh draw. */
    snapshotMeshUniformBindings(mesh: TangramDrawableMesh, program: TangramDrawableProgram, bindings: Bindings) {
        const uniform_blocks = program.uniform_blocks || {};
        const snapshot_blocks = Object.entries(uniform_blocks)
            .filter((entry): entry is [string, TangramDrawableUniformBlock & {data: ArrayBuffer}] =>
                entry[1].snapshot_per_mesh && Boolean(entry[1].data)
            );
        if (snapshot_blocks.length === 0) {
            return;
        }

        const mesh_buffers = this.getMeshResources(mesh).uniformBuffers;
        for (const [name, uniform_buffer] of snapshot_blocks) {
            let snapshot = mesh_buffers.get(name);
            if (!snapshot || snapshot.byteLength !== uniform_buffer.byteLength) {
                const buffer = this.device.createBuffer({
                    id: `tangram-mesh-${mesh.id}-${name}-uniforms`,
                    byteLength: uniform_buffer.byteLength,
                    usage: Buffer.UNIFORM | Buffer.COPY_DST
                });
                snapshot?.buffer.destroy();
                snapshot = {buffer, byteLength: uniform_buffer.byteLength};
                mesh_buffers.set(name, snapshot);
            }
            snapshot.buffer.write(new Uint8Array(uniform_buffer.data));
            bindings[name] = snapshot.buffer;
        }
    }

    getPipeline(program: TangramDrawableProgram, vertex_layout: object, descriptor: TangramMeshDrawDescriptor,
        render_state?: RenderPipelineParameters) {
        this.assertAlive();
        const resources = this.getProgramResources(program);
        const layouts = resources.layouts;
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
            const pipeline_options: RenderPipelineProps = {
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
            resources.pipelines.add(pipeline);
        }
        return pipeline;
    }

    getVertexArray(mesh: TangramDrawableMesh, pipeline: RenderPipeline, descriptor: TangramMeshDrawDescriptor) {
        this.assertAlive();
        const pipelines_for_mesh = this.getMeshResources(mesh).vertexArrays;
        let vertex_array = pipelines_for_mesh.get(pipeline);
        if (vertex_array) {
            return vertex_array;
        }

        vertex_array = this.device.createVertexArray({
            id: `tangram-mesh-${mesh.id}-${pipeline.id}`,
            shaderLayout: pipeline.shaderLayout,
            bufferLayout: pipeline.bufferLayout
        });
        try {
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
        }
        catch (error) {
            vertex_array.destroy();
            throw error;
        }

        pipelines_for_mesh.set(pipeline, vertex_array);
        return vertex_array;
    }

    /** Create one cleanup generation per program without retaining the owner in a callback. */
    private getProgramResources(program: TangramDrawableProgram): ProgramResources {
        let resources = this.pipeline_cache.get(program);
        if (!resources || resources.disposed) {
            resources = {layouts: new WeakMap(), pipelines: new Set(), disposed: false, unsubscribe: () => {}};
            const owned = resources;
            resources.unsubscribe = observeGPUResourceDisposal(program, () => this.disposeProgramResources(owned));
            this.pipeline_cache.set(program, resources);
            this.program_resources.add(resources);
        }
        return resources;
    }

    /** Reuse live mesh storage, and observe only the resources belonging to that mesh. */
    private getMeshResources(mesh: TangramDrawableMesh): MeshResources {
        this.assertAlive();
        let resources = this.mesh_resource_cache.get(mesh);
        if (!resources || resources.disposed) {
            resources = {vertexArrays: new Map(), uniformBuffers: new Map(), disposed: false, unsubscribe: () => {}};
            const owned = resources;
            resources.unsubscribe = observeGPUResourceDisposal(mesh, () => this.disposeMeshResources(owned));
            this.mesh_resource_cache.set(mesh, resources);
            this.mesh_resources.add(resources);
        }
        return resources;
    }

    /** Release a mesh's cached draw resources, leaving shared program pipelines alive. */
    private disposeMeshResources(resources: MeshResources): void {
        if (resources.disposed) return;
        resources.disposed = true;
        resources.unsubscribe();
        this.mesh_resources.delete(resources);
        for (const vertexArray of resources.vertexArrays.values()) vertexArray.destroy();
        for (const snapshot of resources.uniformBuffers.values()) snapshot.buffer.destroy();
        resources.vertexArrays.clear();
        resources.uniformBuffers.clear();
    }

    /** Invalidate dependent vertex arrays before retiring one program generation's pipelines. */
    private disposeProgramResources(resources: ProgramResources): void {
        if (resources.disposed) return;
        resources.disposed = true;
        resources.unsubscribe();
        this.program_resources.delete(resources);
        for (const mesh of this.mesh_resources) {
            for (const [pipeline, vertexArray] of mesh.vertexArrays) {
                if (resources.pipelines.has(pipeline)) {
                    vertexArray.destroy();
                    mesh.vertexArrays.delete(pipeline);
                }
            }
        }
        for (const pipeline of resources.pipelines) pipeline.destroy();
        resources.pipelines.clear();
        resources.layouts = new WeakMap();
    }

    /** Prevent draw-time reuse after final backend teardown. */
    private assertAlive(): void {
        if (this.destroyed) throw new Error('Tangram GPU backend has been destroyed');
    }
}

function validateDevice(device: Device) {
    if (!device || !device.info ||
        typeof device.createBuffer !== 'function' ||
        typeof device.createShader !== 'function' ||
        typeof device.createTexture !== 'function' ||
        typeof device.createRenderPipeline !== 'function' ||
        typeof device.createVertexArray !== 'function') {
        throw new Error('Tangram requires a luma.gl Device');
    }
}

function assertPipelineBindings(pipeline: RenderPipeline, bindings: Bindings) {
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
