// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test, vi} from 'vitest';
import type {Buffer} from '@luma.gl/core';
import VBOMesh from '../src/gl/vbo_mesh';
import VertexLayout from '../src/gl/vertex_layout';
import type {TangramMeshBufferOptions} from '../src/gpu/tangram_gpu_backend';
import gl from '../src/gl/constants';

/** Lifetime-only facade: the mesh owns opaque resources and only calls destroy. */
function createBufferFixture() {
  const destroy = vi.fn();
  const resource = {destroy, get handle(): never {throw new Error('opaque buffer handle read');}};
  return {resource: resource as unknown as Buffer, destroy};
}

/** Build a real packed layout; no shader, adapter, or provider is needed. */
function createLayout() {
  return new VertexLayout([{name: 'a_position', size: 2, type: gl.SHORT}]);
}

describe('checked mesh ownership contract', () => {
  test.each([new Uint16Array([0, 1, 2]), new Uint32Array([0, 1, 2])])('describes index type and releases each opaque allocation once', indices => {
    const vertices = new Int16Array([1, 2, 3, 4, 5, 6]);
    const buffers: ReturnType<typeof createBufferFixture>[] = [];
    const requests: TangramMeshBufferOptions[] = [];
    const mesh = new VBOMesh(null, vertices, indices, createLayout(), {
      id: 'contract',
      bufferFactory(options) {
        requests.push(options);
        const buffer = createBufferFixture();
        buffers.push(buffer);
        return buffer.resource;
      }
    });
    expect(requests.map(request => request.usage)).toEqual(['vertex', 'index']);
    expect(requests[0].data).toBe(vertices);
    expect(requests[1].data).toBe(indices);
    const descriptor = mesh.getDrawDescriptor();
    expect(descriptor.vertexBuffer).toBe(buffers[0].resource);
    expect(descriptor.indexBuffer).toBe(buffers[1].resource);
    expect({vertexCount: descriptor.vertexCount, indexCount: descriptor.indexCount, indexType: descriptor.indexType}).toEqual({
      vertexCount: 3, indexCount: 3,
      indexType: indices instanceof Uint16Array ? 'uint16' : 'uint32'
    });
    expect(mesh.buffer_size).toBe(vertices.byteLength + indices.byteLength);
    expect(mesh.vertex_data).toBeUndefined();
    expect(mesh.destroy()).toBe(true);
    expect(mesh.destroy()).toBe(false);
    buffers.forEach(buffer => expect(buffer.destroy).toHaveBeenCalledTimes(1));
    expect(mesh.getDrawDescriptor().vertexBuffer).toBeNull();
    expect(mesh.render()).toBe(false);
  });

  test('rolls back the first resource if index allocation fails', () => {
    const buffer = createBufferFixture();
    const createBuffer = vi.fn((options: TangramMeshBufferOptions) => {
      if (options.usage === 'index') {throw new Error('index allocation rejected');}
      return buffer.resource;
    });
    expect(() => new VBOMesh(null, new Int16Array(6), new Uint16Array([0, 1, 2]), createLayout(), {
      bufferFactory: createBuffer
    })).toThrow('index allocation rejected');
    expect(createBuffer).toHaveBeenCalledTimes(2);
    expect(buffer.destroy).toHaveBeenCalledTimes(1);
  });

  test('retains caller-owned CPU views only when requested, then drops them on disposal', () => {
    const vertices = new Int16Array(6);
    const buffer = createBufferFixture();
    const mesh = new VBOMesh(null, vertices, false, createLayout(), {
      retain: true, bufferFactory: () => buffer.resource
    });
    expect(mesh.vertex_data).toBe(vertices);
    expect(mesh.getDrawDescriptor()).toMatchObject({vertexCount: 3, indexCount: 0, indexType: null, indexBuffer: null});
    mesh.destroy();
    expect(mesh.vertex_data).toBeUndefined();
    expect(vertices.byteLength).toBe(12);
  });
});
