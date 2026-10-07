// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {BufferLayout, VertexFormat} from '@luma.gl/core';

/** Numeric views used to pack Tangram's heterogeneous interleaved vertex data. */
export type VertexArray = Float32Array | Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array;
/** Views of the same backing allocation indexed by legacy GL component type. */
export type VertexBufferViews = Record<number, VertexArray>;
/** Generated writer preserving component offsets and packed conversion semantics. */
export type AddVertexFunction = (vertex: number[], views: VertexBufferViews, offset: number) => void;
/** Authored attribute plus the offsets populated by VertexLayout construction. */
export interface VertexAttribute {
    name: string;
    size: number;
    type: number;
    normalized?: boolean;
    static?: number | number[] | null;
    offset?: number;
    byte_size?: number;
    method?: `vertexAttrib${number}fv`;
}
/** Portable layout returned after all dynamic attribute offsets are assigned. */
export type VertexBufferLayout = BufferLayout & {
    attributes: {attribute: string; format: VertexFormat; byteOffset: number}[];
};
/** Shader-side attribute lookup consumed by the classic binding path. */
export interface VertexAttributeProgram {
    attribute(name: string): {location: number};
}
/** Classic WebGL operations consumed by layouts; portable devices bypass this surface. */
export type VertexAttributeContext = Pick<WebGLRenderingContext,
    'enableVertexAttribArray' | 'disableVertexAttribArray' | 'vertexAttribPointer'> &
    Partial<Record<`vertexAttrib${number}fv`, (location: number, value: number[]) => void>>;
