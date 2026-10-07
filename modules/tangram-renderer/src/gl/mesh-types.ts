// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {Buffer, RenderPass, RenderPipelineParameters} from '@luma.gl/core';
import type {GlobeMeshOptions} from './globe_mesh';
import type {VertexArrayBinding, VertexArrayContext} from './vao';
import type {VertexAttribute, VertexAttributeProgram, VertexAttributeContext} from './vertex-types';
import type VBOMesh from './vbo_mesh';
import type {TangramDrawableProgram, TangramMeshBufferOptions, TangramMeshDrawOptions, TangramMeshDrawDescriptor} from '../gpu/tangram_gpu_backend';

/** Original packed vertex/index bytes retained only when CPU updates or refinement need them. */
export type MeshVertexData = Uint8Array | Int8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array;
/** Missing element data means the mesh uses a non-indexed draw. */
export type MeshElementData = Uint16Array | Uint32Array | false | null | undefined;
/** The classic mesh path uses raw GL; the portable path needs no GL context. */
export type MeshContext = Pick<WebGLRenderingContext, 'STATIC_DRAW' | 'ELEMENT_ARRAY_BUFFER' | 'ARRAY_BUFFER' |
    'createBuffer' | 'bindBuffer' | 'bufferData' | 'drawElements' | 'drawArrays' | 'deleteBuffer'> & VertexArrayContext & VertexAttributeContext;
/** Layout capabilities shared by device meshes and their classic attribute bindings. */
export interface MeshVertexLayout {
    stride: number;
    dynamic_attribs?: VertexAttribute[];
    getBufferLayout(): TangramMeshDrawDescriptor['bufferLayout'];
    getStaticAttributes(): {attribute: string; value: number[]}[];
    enableDynamicAttributes?(context: VertexAttributeContext, program: VertexAttributeProgram): void;
    enableStaticAttributes?(context: VertexAttributeContext, program: VertexAttributeProgram): void;
}
/** Legacy program operations added to the device submission contract. */
export interface MeshProgram extends TangramDrawableProgram, VertexAttributeProgram {
    use(options?: {bindUniformBlocks: boolean}): void;
}
/** Caller-supplied allocation and owned texture/fade/refinement state. */
export interface MeshOptions {
    id?: string | number;
    bufferFactory?: (options: TangramMeshBufferOptions) => Buffer;
    draw_mode?: number;
    data_usage?: number;
    uniforms?: Record<string, unknown>;
    textures?: string[];
    retain?: boolean;
    fade_in_time?: number;
    globeRefinement?: GlobeMeshOptions;
    globeRefinementError?: string;
}
/** Per-draw host state; camera projection controls lazy geometry refinement only. */
export interface MeshRenderOptions {
    projection?: string;
    program?: MeshProgram;
    meshRenderer?: {drawMesh(options: Omit<TangramMeshDrawOptions, 'mesh'> & {mesh: VBOMesh}): boolean | null};
    renderPass?: RenderPass;
    renderState?: RenderPipelineParameters;
}
/** Classic bindings are opaque to device renderers and keyed by program identity. */
export type MeshVertexArrays = Record<string | number, VertexArrayBinding>;
