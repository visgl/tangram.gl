// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import gl from './constants'; // web workers don't have access to GL context, so import all GL constants
import log from '../utils/log';
import VertexElements from './vertex_elements';
import type {VertexAttribute, AddVertexFunction, VertexBufferViews} from './vertex-types';

type VertexLayoutLike = {
    stride: number;
    index: Record<string, number>;
    dynamic_attribs: VertexAttribute[];
    getAddVertexFunction(): AddVertexFunction;
};

// Maps GL types to JS array types
let array_types = {
    [gl.FLOAT]: Float32Array,
    [gl.BYTE]: Int8Array,
    [gl.UNSIGNED_BYTE]: Uint8Array,
    [gl.INT]: Int32Array,
    [gl.UNSIGNED_INT]: Uint32Array,
    [gl.SHORT]: Int16Array,
    [gl.UNSIGNED_SHORT]: Uint16Array
};

// An intermediary object that holds vertex data in typed arrays, according to a given vertex layout
// Used to construct a mesh/VBO for rendering
export default class VertexData {

    static array_pool: Uint8Array[] = [];
    vertex_layout: VertexLayoutLike;
    vertex_elements: VertexElements;
    stride: number;
    vertex_buffer: Uint8Array;
    element_buffer!: Uint16Array | Uint32Array | false;
    byte_length: number;
    size: number;
    offset: number;
    vertex_count: number;
    realloc_count: number;
    views!: VertexBufferViews;
    vertexLayoutAddVertex!: AddVertexFunction;

    constructor (vertex_layout: VertexLayoutLike, { prealloc = 500 }: {prealloc?: number} = {}) {
        this.vertex_layout = vertex_layout;
        this.vertex_elements = new VertexElements();
        this.stride = this.vertex_layout.stride;

        if (VertexData.array_pool.length > 0) {
            this.vertex_buffer = VertexData.array_pool.pop()!;
            this.byte_length = this.vertex_buffer.byteLength;
            this.size = Math.floor(this.byte_length / this.stride);
            log('trace', `VertexData: reused buffer of bytes ${this.byte_length}, ${this.size} vertices`);
        }
        else {
            this.size = prealloc; // # of vertices to allocate
            this.byte_length = this.stride * this.size;
            this.vertex_buffer = new Uint8Array(this.byte_length);
        }
        this.offset = 0;             // byte offset into currently allocated buffer

        this.vertex_count = 0;
        this.realloc_count = 0;
        this.setBufferViews();
        this.setAddVertexFunction();
    }

    // (Re-)allocate typed views into the main buffer - only create the types we need for this layout
    setBufferViews (): void {
        this.views = {};
        this.views[gl.UNSIGNED_BYTE] = this.vertex_buffer;
        this.vertex_layout.dynamic_attribs.forEach(attrib => {
            // Need view for this type?
            if (this.views[attrib.type] == null) {
                const arrayType = array_types[attrib.type];
                this.views[attrib.type] = new arrayType(this.vertex_buffer.buffer as ArrayBuffer);
            }
        });
    }

    // Check allocated buffer size, expand/realloc buffer if needed
    checkBufferSize (): void {
        if ((this.offset + this.stride) > this.byte_length) {
            this.size = Math.floor(this.size * 1.5);
            this.size -= this.size % 4;
            this.byte_length = this.stride * this.size;
            var new_view = new Uint8Array(this.byte_length);
            new_view.set(this.vertex_buffer); // copy existing data to new buffer
            VertexData.array_pool.push(this.vertex_buffer); // save previous buffer for use by next tile
            this.vertex_buffer = new_view;
            this.setBufferViews();
            this.realloc_count++;
            // log('info', `VertexData: expanded vertex block to ${this.size} vertices`);
        }
    }

    // Initialize the add vertex function (lazily compiled by vertex layout)
    setAddVertexFunction (): void {
        this.vertexLayoutAddVertex = this.vertex_layout.getAddVertexFunction();
    }

    // Add a vertex, copied from a plain JS array of elements matching the order of the vertex layout
    addVertex (vertex: number[]): void {
        this.checkBufferSize();
        this.vertexLayoutAddVertex(vertex, this.views, this.offset);
        this.offset += this.stride;
        this.vertex_count++;
    }

    // Finalize vertex buffer for use in constructing a mesh
    end (): this {
        // Clip the buffer to size used for this VBO
        this.vertex_buffer = this.vertex_buffer.subarray(0, this.offset);
        this.element_buffer = this.vertex_elements.end();

        log('trace', `VertexData: ${this.size} vertices total, realloc count ${this.realloc_count}`);

        return this;
    }

}

// Pool of currently available (previously used) buffers (uint8).
