// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

// Manage rendering for primitives
import type {Buffer, PrimitiveTopology} from '@luma.gl/core';
import type {TangramMeshBufferOptions, TangramMeshDrawDescriptor} from '../gpu/tangram_gpu_backend';
import type {MeshContext, MeshVertexData, MeshElementData, MeshVertexLayout, MeshOptions, MeshProgram, MeshRenderOptions, MeshVertexArrays} from './mesh-types';
import ShaderProgram from './shader_program';
import VertexArrayObject from './vao';
import Texture from './texture';
import {refineGlobeMesh, type GlobeMeshOptions} from './globe_mesh';
import {notifyGPUResourceDisposal} from '../gpu/resource_lifecycle';

// A single mesh/VBO, described by a vertex layout, that can be drawn with one or more programs
export default class VBOMesh  {
    /** Next automatically assigned mesh identifier. */
    declare static id: number;
    declare gl: MeshContext | null;
    declare vertex_data?: MeshVertexData;
    declare element_data?: MeshElementData;
    declare vertex_layout: MeshVertexLayout;
    declare id: string | number;
    declare buffer_factory: MeshOptions['bufferFactory'];
    declare vertex_buffer_resource: Buffer | null;
    declare element_buffer_resource?: Buffer | null;
    declare vertex_buffer: Buffer | WebGLBuffer | null;
    declare element_buffer?: Buffer | WebGLBuffer | null;
    declare draw_mode: number;
    declare data_usage: number | null;
    declare vertices_per_geometry: number;
    declare uniforms: MeshOptions['uniforms'];
    declare textures: MeshOptions['textures'];
    declare retain: boolean;
    declare fade_in_time: number;
    declare globe_refinement_error: string | undefined;
    declare vertex_count: number;
    declare element_count: number;
    declare element_type: number;
    declare vaos: MeshVertexArrays;
    declare toggle_element_array: boolean;
    declare valid: boolean;

    /** Vertex/index allocation bytes, excluding textures and projection-specific child meshes. */
    declare buffer_size: number;

    /** Triangle count of the original planar mesh. */
    geometry_count: number;
    /** Shared fade origin for planar and globe variants. */
    created_at: number;
    /** Lazily allocated globe buffers, owned by this mesh. */
    globe_mesh?: VBOMesh | null;
    /** Immutable coarse tile data, released once refinement completes. */
    globe_source?: {
        vertices: MeshVertexData;
        indices: MeshElementData;
        options: MeshOptions & {globeRefinement: GlobeMeshOptions};
    };

    constructor(gl: MeshContext | null, vertex_data: MeshVertexData, element_data: MeshElementData, vertex_layout: MeshVertexLayout, options?: MeshOptions) {
        options = options || {};

        this.gl = gl;
        this.vertex_data = vertex_data; // typed array
        this.element_data = element_data; // typed array
        this.vertex_layout = vertex_layout;
        this.id = options.id != null ? options.id : VBOMesh.id++;
        this.buffer_factory = options.bufferFactory;
        this.vertex_buffer_resource = createBufferResource(this.buffer_factory, {
            id: `mesh-${this.id}-vertices`,
            usage: 'vertex',
            data: this.vertex_data
        });
        this.vertex_buffer = this.vertex_buffer_resource || this.gl!.createBuffer();
        this.buffer_size = this.vertex_data.byteLength;
        this.draw_mode = options.draw_mode || 0x0004;
        this.data_usage = options.data_usage || (this.vertex_buffer_resource ? null : this.gl!.STATIC_DRAW);
        this.vertices_per_geometry = 3; // TODO: support lines, strip, fan, etc.
        this.uniforms = options.uniforms;
        this.textures = options.textures; // any textures owned by this mesh
        this.retain = options.retain || false; // whether to retain mesh data in CPU after uploading to GPU
        this.created_at = +new Date();
        this.fade_in_time = options.fade_in_time || 0; // optional time to fade in mesh
        this.globe_refinement_error = options.globeRefinementError;
        // Only coarse, immutable triangle meshes need a second projection-specific buffer.
        if (options.globeRefinement && options.globeRefinement.tileZoom < 7 &&
            this.draw_mode === 0x0004 && !this.retain) {
            this.globe_source = {vertices: vertex_data, indices: element_data, options: options as MeshOptions & {globeRefinement: GlobeMeshOptions}};
        }

        this.vertex_count = this.vertex_data.byteLength / this.vertex_layout.stride;
        this.element_count = 0;
        this.vaos = {}; // map of VertexArrayObjects, keyed by program

        this.toggle_element_array = false;
        if (this.element_data) {
            this.toggle_element_array = true;
            this.element_count = this.element_data.length;
            this.geometry_count = this.element_count / this.vertices_per_geometry;
            this.element_type = (this.element_data.constructor === Uint16Array) ? 0x1403 : 0x1405;
            try {
                this.element_buffer_resource = createBufferResource(this.buffer_factory, {
                    id: `mesh-${this.id}-indices`,
                    usage: 'index',
                    indexType: this.element_data.constructor === Uint16Array ? 'uint16' : 'uint32',
                    data: this.element_data
                });
            }
            catch (error) {
                if (this.vertex_buffer_resource) {
                    this.vertex_buffer_resource.destroy();
                    this.vertex_buffer_resource = null;
                }
                throw error;
            }
            this.element_buffer = this.element_buffer_resource || this.gl!.createBuffer();
            this.buffer_size += this.element_data.byteLength;
            if (!this.element_buffer_resource) {
                this.gl!.bindBuffer(this.gl!.ELEMENT_ARRAY_BUFFER, this.element_buffer as WebGLBuffer | null);
                this.gl!.bufferData(this.gl!.ELEMENT_ARRAY_BUFFER, this.element_data, this.data_usage!);
            }
        }
        else {
            this.geometry_count = this.vertex_count / this.vertices_per_geometry;
        }

        if (!this.vertex_buffer_resource) {
            this.upload();
        }

        if (!this.retain) {
            delete this.vertex_data;
            delete this.element_data;
        }
        this.valid = true;
    }

    // Render, by default with currently bound program, or otherwise with optionally provided one
    // Returns true if mesh requests a render on next frame (e.g. for fade animations)
    render(options: MeshRenderOptions = {}): boolean {
        if (!this.valid) {
            return false;
        }

        if (options.projection === 'globe') {
            if (this.globe_refinement_error) {
                throw new Error(this.globe_refinement_error);
            }
            if (this.globe_source && this.globe_mesh === undefined) {
                const {vertices, indices, options: meshOptions} = this.globe_source;
                const refined = refineGlobeMesh(vertices as Uint8Array, indices as Uint16Array | Uint32Array | false,
                    this.vertex_layout as MeshVertexLayout & {dynamic_attribs: NonNullable<MeshVertexLayout['dynamic_attribs']>}, meshOptions.globeRefinement);
                this.globe_mesh = refined.vertices === vertices ? null : new VBOMesh(
                    this.gl, refined.vertices, refined.indices, this.vertex_layout,
                    {...meshOptions, id: undefined, globeRefinement: undefined, textures: undefined}
                );
                if (this.globe_mesh) {
                    this.globe_mesh.created_at = this.created_at;
                }
                // A completed refinement no longer needs the duplicate CPU data.
                delete this.globe_source;
            }
            if (this.globe_mesh) {
                return this.globe_mesh.render(options);
            }
        }

        var program: MeshProgram = (options.program || ShaderProgram.current)!;
        let visible_time = (+new Date() - this.created_at) / 1000;
        if (options.meshRenderer && typeof options.meshRenderer.drawMesh === 'function') {
            const needs_redraw = options.meshRenderer.drawMesh({
                mesh: this,
                program,
                renderPass: options.renderPass!,
                renderState: options.renderState,
                visibleTime: visible_time
            });
            if (needs_redraw !== null) {
                return Boolean(needs_redraw) || visible_time < this.fade_in_time;
            }
        }

        program.use(options.meshRenderer ? { bindUniformBlocks: true } : undefined);

        if (this.uniforms) {
            program.saveUniforms(this.uniforms);
            program.setUniforms(this.uniforms, false); // don't reset texture unit
        }

        program.uniform('1f', 'u_visible_time', visible_time);

        this.bind(program);

        if (this.toggle_element_array){
            this.gl!.drawElements(this.draw_mode, this.element_count, this.element_type, 0);
        }
        else {
            this.gl!.drawArrays(this.draw_mode, 0, this.vertex_count);
        }

        VertexArrayObject.bind(this.gl!, null);

        if (this.uniforms) {
            program.restoreUniforms(this.uniforms);
        }

        // Request next render if mesh is fading in
        return (visible_time < this.fade_in_time);
    }

    // Return the renderer-independent resources and draw parameters for this mesh.
    getDrawDescriptor(): TangramMeshDrawDescriptor & {indexType: 'uint16' | 'uint32' | null} {
        return {
            topology: getTopology(this.draw_mode),
            vertexCount: this.vertex_count,
            indexCount: this.element_count,
            indexType: this.toggle_element_array ?
                (this.element_type === 0x1403 ? 'uint16' : 'uint32') : null,
            vertexBuffer: this.vertex_buffer_resource,
            indexBuffer: this.element_buffer_resource || null,
            bufferLayout: this.vertex_layout.getBufferLayout(),
            staticAttributes: this.vertex_layout.getStaticAttributes()
        };
    }

    // Bind buffers and vertex attributes to prepare for rendering
    bind(program: MeshProgram): void {
        // Bind VAO for this progam, or create one
        let vao = this.vaos[program.id];
        if (vao) {
            VertexArrayObject.bind(this.gl!, vao);
        }
        else {
            this.vaos[program.id] = VertexArrayObject.create(this.gl!, () => {
                this.gl!.bindBuffer(this.gl!.ARRAY_BUFFER, this.vertex_buffer as WebGLBuffer | null);
                if (this.toggle_element_array) {
                    this.gl!.bindBuffer(this.gl!.ELEMENT_ARRAY_BUFFER, this.element_buffer as WebGLBuffer | null);
                }
                this.vertex_layout.enableDynamicAttributes!(this.gl!, program);
            });
        }

        this.vertex_layout.enableStaticAttributes!(this.gl!, program);
    }

    // Upload buffer data to GPU
    upload(): void {
        if (this.vertex_buffer_resource) {
            if (typeof this.vertex_buffer_resource.write !== 'function') {
                throw new Error('VBOMesh: portable vertex buffers must support write');
            }
            this.vertex_buffer_resource.write(this.vertex_data!);
            return;
        }
        this.gl!.bindBuffer(this.gl!.ARRAY_BUFFER, this.vertex_buffer as WebGLBuffer | null);
        this.gl!.bufferData(this.gl!.ARRAY_BUFFER, this.vertex_data!, this.data_usage!);
    }

    destroy(): boolean {
        if (!this.valid) {
            return false;
        }
        this.valid = false;
        try {
            notifyGPUResourceDisposal(this);
        }
        finally {
            this.globe_mesh?.destroy();
            this.globe_mesh = null;
            delete this.globe_source;

            for (let v in this.vaos) {
                VertexArrayObject.destroy(this.gl!, this.vaos[v]);
            }

            if (this.vertex_buffer_resource) {
                this.vertex_buffer_resource.destroy();
                this.vertex_buffer_resource = null;
            }
            else {
                this.gl!.deleteBuffer(this.vertex_buffer as WebGLBuffer | null);
            }
            this.vertex_buffer = null;

            if (this.element_buffer) {
                if (this.element_buffer_resource) {
                    this.element_buffer_resource.destroy();
                    this.element_buffer_resource = null;
                }
                else {
                    this.gl!.deleteBuffer(this.element_buffer as WebGLBuffer | null);
                }
                this.element_buffer = null;
            }

            delete this.vertex_data;
            delete this.element_data;

            if (this.textures) {
                this.textures.forEach(t => Texture.release(t));
            }
        }

        return true;
    }

}

VBOMesh.id = 0;

function createBufferResource(buffer_factory: MeshOptions['bufferFactory'], options: TangramMeshBufferOptions): Buffer | null {
    if (typeof buffer_factory !== 'function') {
        return null;
    }
    const resource = buffer_factory(options);
    if (!resource || typeof resource.destroy !== 'function') {
        throw new Error('VBOMesh: bufferFactory must return a GPU resource with destroy');
    }
    return resource;
}

function getTopology(draw_mode: number): PrimitiveTopology {
    switch (draw_mode) {
    case 0x0000:
        return 'point-list';
    case 0x0001:
        return 'line-list';
    case 0x0003:
        return 'line-strip';
    case 0x0004:
        return 'triangle-list';
    case 0x0005:
        return 'triangle-strip';
    default:
        throw new Error(`VBOMesh: unsupported draw mode ${draw_mode}`);
    }
}
