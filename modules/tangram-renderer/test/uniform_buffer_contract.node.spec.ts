// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, expectTypeOf, test, vi} from 'vitest';
import UniformBuffer, {type UniformBufferResource} from '../src/gl/uniform_buffer';
import LumaDeviceRenderer from '../src/gpu/luma_device_renderer';
import type {TangramGPUBackend} from '../src/gpu/tangram_gpu_backend';

describe('checked GPU resource contracts', () => {
    test('device submission implements the portable backend without widening its contract', () => {
        expectTypeOf<LumaDeviceRenderer>().toExtend<TangramGPUBackend>();
    });

    test('portable packing preserves booleans, signed integers and padded matrices', () => {
        const write = vi.fn<(data: Uint8Array) => void>();
        const destroy = vi.fn<() => void>();
        const resource: UniformBufferResource = {write, destroy};
        const buffer = new UniformBuffer(null, {
            name: 'Contract', snapshotPerMesh: true,
            uniforms: {active: 'bool', count: 'int', normal: 'mat3'},
            bufferFactory: () => resource
        });
        buffer.setUniforms({active: true, count: -7,
            normal: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9])});
        expect(buffer.upload()).toBe(true);
        const bytes = write.mock.calls[0][0];
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        expect(view.getInt32(0, true)).toBe(1);
        expect(view.getInt32(4, true)).toBe(-7);
        expect([16, 20, 24, 32, 36, 40, 48, 52, 56].map(offset => view.getFloat32(offset, true)))
            .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
        expect([28, 44, 60].map(offset => view.getFloat32(offset, true))).toEqual([0, 0, 0]);
        expect(buffer.getBindingLayout()).toEqual({type: 'uniform', name: 'Contract',
            group: 0, location: 0, minBindingSize: 64});
        buffer.setUniform('active', false);
        expect(buffer.upload()).toBe(true);
        expect(view.getInt32(0, true)).toBe(0);
        buffer.destroy();
        buffer.destroy();
        expect(destroy).toHaveBeenCalledTimes(1);
        expect(buffer.data).toBeNull();
        expect(buffer.upload()).toBe(false);
        expect(() => buffer.setUniform('active', true)).toThrow('destroyed');
        expect(() => buffer.withBufferBinding(() => true)).toThrow('WebGL2');
    });
});
