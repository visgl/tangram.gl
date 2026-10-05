// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test, vi} from 'vitest';
import type {Buffer, BufferProps, Device, RenderPass, RenderPipelineProps,
    Shader, ShaderProps} from '@luma.gl/core';
import LumaDeviceRenderer from '../src/gpu/luma_device_renderer';
import {notifyGPUResourceDisposal, observeGPUResourceDisposal} from '../src/gpu/resource_lifecycle';
import type {TangramDrawableMesh, TangramDrawableProgram, TangramMeshDrawDescriptor} from '../src/gpu/tangram_gpu_backend';
import VBOMesh from '../src/gl/vbo_mesh';
import ShaderProgram from '../src/gl/shader_program';
import {StyleManager} from '../src/styles/style_manager';

/** Strict test facade for the small subset of the abstract Device used by this backend. */
function createFixture(type: 'webgl' | 'webgpu') {
    const releaseOrder: string[] = [];
    const createResource = (id: string) => ({id, destroy: vi.fn(() => { releaseOrder.push(id); })});
    const buffers: ReturnType<typeof createBuffer>[] = [];
    const pipelines: ReturnType<typeof createPipeline>[] = [];
    const vertexArrays: ReturnType<typeof createVertexArray>[] = [];
    const createBuffer = (options: BufferProps): ReturnType<typeof createResource> & {
        byteLength: number | undefined; write: ReturnType<typeof vi.fn>;
    } => {
        const resource = {...createResource(options.id || 'buffer'), byteLength: options.byteLength,
            write: vi.fn()};
        buffers.push(resource);
        return resource;
    };
    const createPipeline = (options: RenderPipelineProps): ReturnType<typeof createResource> & {
        bufferLayout: RenderPipelineProps['bufferLayout'];
        shaderLayout: {attributes: {name: string; location: number}[]; bindings: never[]}; isPending: boolean;
    } => {
        const resource = {...createResource(options.id || 'pipeline'), bufferLayout: options.bufferLayout,
            shaderLayout: {attributes: [{name: 'a_position', location: 0}], bindings: []}, isPending: false};
        pipelines.push(resource);
        return resource;
    };
    const createVertexArray = (): ReturnType<typeof createResource> & {
        setBuffer: ReturnType<typeof vi.fn>; setIndexBuffer: ReturnType<typeof vi.fn>;
        setConstantWebGL: ReturnType<typeof vi.fn>;
    } => {
        const resource = {...createResource(`vertex-array-${vertexArrays.length}`),
            setBuffer: vi.fn(), setIndexBuffer: vi.fn(), setConstantWebGL: vi.fn()};
        vertexArrays.push(resource);
        return resource;
    };
    const deviceFacade = {
        type, info: {shadingLanguage: type === 'webgl' ? 'glsl' : 'wgsl'}, limits: {},
        createBuffer: vi.fn(createBuffer), createRenderPipeline: vi.fn(createPipeline),
        createVertexArray: vi.fn(createVertexArray),
        createShader: vi.fn((options: ShaderProps) => createResource(options.id || 'shader')),
        createTexture: vi.fn(), destroy: vi.fn()
    };
    const renderer = new LumaDeviceRenderer(deviceFacade as unknown as Device);
    const pass = {setPipeline: vi.fn(), setBindings: vi.fn(), setVertexArray: vi.fn(),
        draw: vi.fn(() => true), destroy: vi.fn()};
    const vertexBuffer = createResource('scene-vertices');
    const indexBuffer = createResource('scene-indices');
    const layout = {};
    const descriptor: TangramMeshDrawDescriptor = {
        topology: 'triangle-list', vertexCount: 3, indexCount: 3,
        vertexBuffer: vertexBuffer as unknown as Buffer, indexBuffer: indexBuffer as unknown as Buffer,
        bufferLayout: {name: 'vertices', byteStride: 8,
            attributes: [{attribute: 'a_position', format: 'float32x2', byteOffset: 0}]},
        staticAttributes: []
    };
    const createMesh = (id = 1): TangramDrawableMesh => ({id, vertex_layout: layout,
        getDrawDescriptor: () => descriptor});
    const vertexShader = createResource('scene-vertex-shader');
    const fragmentShader = createResource('scene-fragment-shader');
    const createProgram = (): TangramDrawableProgram => ({id: pipelines.length,
        vertex_shader_resource: vertexShader as unknown as Shader,
        fragment_shader_resource: fragmentShader as unknown as Shader,
        uniform_blocks: {TangramTile: {data: new ArrayBuffer(16), byteLength: 16, snapshot_per_mesh: true}},
        uniform: vi.fn(), saveUniforms: vi.fn(), setUniforms: vi.fn(), restoreUniforms: vi.fn(),
        getBindings: () => ({}), getUniformValues: () => ({})});
    const program = createProgram();
    const draw = (mesh: TangramDrawableMesh, selectedProgram = program) => renderer.drawMesh({mesh,
        program: selectedProgram, renderPass: pass as unknown as RenderPass, visibleTime: 1});
    return {renderer, deviceFacade, pass, buffers, pipelines, vertexArrays, releaseOrder,
        vertexBuffer, indexBuffer, vertexShader, fragmentShader, descriptor,
        createMesh, createProgram, program, draw};
}

describe.each(['webgl', 'webgpu'] as const)('GPU cache lifetime (%s)', type => {
    test('reuses live draw resources and releases only a retired mesh', () => {
        const fixture = createFixture(type);
        const first = fixture.createMesh(1);
        const second = fixture.createMesh(2);
        fixture.draw(first);
        fixture.draw(first);
        fixture.draw(second);
        expect(fixture.pipelines).toHaveLength(1);
        expect(fixture.vertexArrays).toHaveLength(2);
        expect(fixture.buffers).toHaveLength(2);
        notifyGPUResourceDisposal(first);
        expect(fixture.vertexArrays[0].destroy).toHaveBeenCalledTimes(1);
        expect(fixture.buffers[0].destroy).toHaveBeenCalledTimes(1);
        expect(fixture.vertexArrays[1].destroy).not.toHaveBeenCalled();
        expect(fixture.buffers[1].destroy).not.toHaveBeenCalled();
        expect(fixture.pipelines[0].destroy).not.toHaveBeenCalled();
        fixture.draw(second);
        expect(fixture.vertexArrays).toHaveLength(2);
        fixture.renderer.destroy();
        fixture.renderer.destroy();
        notifyGPUResourceDisposal(first);
        notifyGPUResourceDisposal(second);
        notifyGPUResourceDisposal(fixture.program);
        for (const resource of [...fixture.buffers, ...fixture.vertexArrays, ...fixture.pipelines]) {
            expect(resource.destroy).toHaveBeenCalledTimes(1);
        }
        for (const host of [fixture.deviceFacade, fixture.pass, fixture.vertexBuffer,
            fixture.indexBuffer, fixture.vertexShader, fixture.fragmentShader]) {
            expect(host.destroy).not.toHaveBeenCalled();
        }
        expect(() => fixture.draw(second)).toThrow('backend has been destroyed');
        expect(() => fixture.renderer.getSceneOptions()).toThrow('backend has been destroyed');
    });

    test('shader invalidation retires every layout/topology/state variant before its pipelines', () => {
        const fixture = createFixture(type);
        const first = fixture.createMesh();
        const second = {...fixture.createMesh(2), vertex_layout: {}};
        fixture.draw(first);
        fixture.renderer.drawMesh({mesh: first, program: fixture.program,
            renderPass: fixture.pass as unknown as RenderPass, visibleTime: 1,
            renderState: {depthWriteEnabled: false}});
        fixture.draw(second);
        fixture.draw({...fixture.createMesh(3), getDrawDescriptor: () => ({...fixture.descriptor, topology: 'line-list'})});
        const otherProgram = fixture.createProgram();
        fixture.draw(first, otherProgram);
        expect(fixture.pipelines).toHaveLength(5);
        notifyGPUResourceDisposal(fixture.program);
        for (let index = 0; index < 4; index++) {
            expect(fixture.pipelines[index].destroy).toHaveBeenCalledTimes(1);
            expect(fixture.vertexArrays[index].destroy).toHaveBeenCalledTimes(1);
            expect(fixture.releaseOrder.indexOf(fixture.vertexArrays[index].id))
                .toBeLessThan(fixture.releaseOrder.indexOf(fixture.pipelines[index].id));
        }
        expect(fixture.pipelines[4].destroy).not.toHaveBeenCalled();
        expect(fixture.vertexArrays[4].destroy).not.toHaveBeenCalled();
        for (const buffer of fixture.buffers) expect(buffer.destroy).not.toHaveBeenCalled();
        fixture.draw(first, otherProgram);
        expect(fixture.pipelines).toHaveLength(5);
        fixture.draw(first);
        expect(fixture.pipelines).toHaveLength(6);
        expect(fixture.vertexArrays).toHaveLength(6);
        expect(fixture.buffers).toHaveLength(3);
        fixture.renderer.destroy();
    });

    test('retiring many tiles keeps only shared pipelines alive', () => {
        const fixture = createFixture(type);
        for (let index = 0; index < 50; index++) {
            const mesh = fixture.createMesh(index);
            fixture.draw(mesh);
            notifyGPUResourceDisposal(mesh);
        }
        expect(fixture.pipelines).toHaveLength(1);
        expect(fixture.vertexArrays).toHaveLength(50);
        expect(fixture.buffers).toHaveLength(50);
        expect(fixture.vertexArrays.every(resource => resource.destroy.mock.calls.length === 1)).toBe(true);
        expect(fixture.buffers.every(resource => resource.destroy.mock.calls.length === 1)).toBe(true);
        fixture.renderer.destroy();
        expect(fixture.pipelines[0].destroy).toHaveBeenCalledTimes(1);
    });

    test('uniform layout changes replace snapshots without losing the old one on allocation failure', () => {
        const fixture = createFixture(type);
        const mesh = fixture.createMesh();
        fixture.draw(mesh);
        fixture.program.uniform_blocks!.TangramTile = {data: new ArrayBuffer(32), byteLength: 32,
            snapshot_per_mesh: true};
        fixture.deviceFacade.createBuffer.mockImplementationOnce(() => { throw new Error('allocation failed'); });
        expect(() => fixture.draw(mesh)).toThrow('allocation failed');
        expect(fixture.buffers[0].destroy).not.toHaveBeenCalled();
        fixture.draw(mesh);
        fixture.draw(mesh);
        expect(fixture.buffers).toHaveLength(2);
        expect(fixture.buffers[0].destroy).toHaveBeenCalledTimes(1);
        expect(fixture.buffers[1].byteLength).toBe(32);
        expect(fixture.buffers[1].write).toHaveBeenCalledTimes(2);
        notifyGPUResourceDisposal(mesh);
        expect(fixture.buffers[1].destroy).toHaveBeenCalledTimes(1);
        fixture.renderer.destroy();
    });

    test.each(['setBuffer', 'setIndexBuffer'] as const)('failed %s destroys the partial vertex array and permits retry', method => {
        const fixture = createFixture(type);
        const mesh = fixture.createMesh();
        const create = fixture.deviceFacade.createVertexArray.getMockImplementation()!;
        fixture.deviceFacade.createVertexArray.mockImplementationOnce(() => {
            const resource = create();
            resource[method].mockImplementationOnce(() => { throw new Error('binding failed'); });
            return resource;
        });
        expect(() => fixture.draw(mesh)).toThrow('binding failed');
        expect(fixture.vertexArrays[0].destroy).toHaveBeenCalledTimes(1);
        fixture.draw(mesh);
        expect(fixture.vertexArrays).toHaveLength(2);
        expect(fixture.pipelines).toHaveLength(1);
        fixture.renderer.destroy();
        expect(fixture.vertexArrays[0].destroy).toHaveBeenCalledTimes(1);
        expect(fixture.vertexArrays[1].destroy).toHaveBeenCalledTimes(1);
    });

    test.each(['mesh-first', 'backend-first'])('%s: VBOMesh retirement also releases cached globe-child resources before scene buffers', order => {
        const fixture = createFixture(type);
        const createMesh = () => new VBOMesh(null, new Float32Array(6), new Uint16Array([0, 1, 2]), {
            stride: 8, getBufferLayout: () => fixture.descriptor.bufferLayout,
            getStaticAttributes: () => []
        }, {bufferFactory: fixture.renderer.getSceneOptions().meshBufferFactory});
        const mesh = createMesh();
        const child = createMesh();
        mesh.globe_mesh = child;
        fixture.draw(mesh as unknown as TangramDrawableMesh);
        fixture.draw(child as unknown as TangramDrawableMesh);
        if (order === 'backend-first') fixture.renderer.destroy();
        expect(mesh.destroy()).toBe(true);
        expect(mesh.destroy()).toBe(false);
        expect(child.destroy()).toBe(false);
        for (const resource of [...fixture.buffers, ...fixture.vertexArrays]) {
            expect(resource.destroy).toHaveBeenCalledTimes(1);
        }
        expect(fixture.releaseOrder.indexOf(fixture.vertexArrays[0].id))
            .toBeLessThan(fixture.releaseOrder.indexOf(fixture.buffers[0].id));
        fixture.renderer.destroy();
    });
});

test('WebGPU static attributes release the partial array instead of leaking it', () => {
    const fixture = createFixture('webgpu');
    fixture.descriptor.staticAttributes = [{attribute: 'a_position', value: [0, 0]}];
    expect(() => fixture.draw(fixture.createMesh())).toThrow('requires');
    expect(fixture.vertexArrays[0].destroy).toHaveBeenCalledTimes(1);
    fixture.renderer.destroy();
    expect(fixture.vertexArrays[0].destroy).toHaveBeenCalledTimes(1);
});

test('rebuilding a manager preserves base objects but retires their owned programs and buffers', () => {
    const manager = new StyleManager() as StyleManager & {styles: Record<string, {
        program: {destroy: ReturnType<typeof vi.fn>} | null;
        selection_program: {destroy: ReturnType<typeof vi.fn>} | null;
        portable_material_buffer: {destroy: ReturnType<typeof vi.fn>} | null;
    }>};
    const polygons = manager.styles.polygons;
    const program = {destroy: vi.fn()};
    const selection = {destroy: vi.fn()};
    const material = {destroy: vi.fn()};
    polygons.program = program;
    polygons.selection_program = selection;
    polygons.portable_material_buffer = material;
    manager.build({});
    expect(manager.styles.polygons).toBe(polygons);
    for (const resource of [program, selection, material]) {
        expect(resource.destroy).toHaveBeenCalledTimes(1);
    }
    expect(polygons.program).toBeNull();
    expect(polygons.selection_program).toBeNull();
    expect(polygons.portable_material_buffer).toBeNull();
    manager.build({});
    for (const resource of [program, selection, material]) {
        expect(resource.destroy).toHaveBeenCalledTimes(1);
    }
});

test('the same mesh/program can have independently owned backend caches', () => {
    const first = createFixture('webgl');
    const second = createFixture('webgl');
    const mesh = first.createMesh();
    first.draw(mesh);
    second.draw(mesh, first.program);
    first.renderer.destroy();
    expect(second.vertexArrays[0].destroy).not.toHaveBeenCalled();
    notifyGPUResourceDisposal(mesh);
    expect(second.vertexArrays[0].destroy).toHaveBeenCalledTimes(1);
    expect(first.vertexArrays[0].destroy).toHaveBeenCalledTimes(1);
    notifyGPUResourceDisposal(first.program);
    expect(second.pipelines[0].destroy).toHaveBeenCalledTimes(1);
    second.renderer.destroy();
});

test('successful shader recompilation invalidates caches; failed replacement preserves the old generation', () => {
    const fixture = createFixture('webgpu');
    const program = new ShaderProgram(null, 'vertex', 'fragment', {shaderLanguage: 'wgsl', deferUniformUpdates: true,
        shaderFactory: fixture.renderer.getSceneOptions().shaderFactory}) as ShaderProgram & TangramDrawableProgram;
    program.compile();
    const mesh = fixture.createMesh();
    fixture.draw(mesh, program as unknown as TangramDrawableProgram);
    const oldVertex = program.vertex_shader_resource;
    fixture.deviceFacade.createShader.mockImplementationOnce(() => { throw new Error('compile failed'); });
    expect(() => program.compile()).toThrow('compile failed');
    expect(fixture.pipelines[0].destroy).not.toHaveBeenCalled();
    expect(oldVertex.destroy).not.toHaveBeenCalled();
    program.compile();
    expect(fixture.pipelines[0].destroy).toHaveBeenCalledTimes(1);
    expect(fixture.vertexArrays[0].destroy).toHaveBeenCalledTimes(1);
    expect(oldVertex.destroy).toHaveBeenCalledTimes(1);
    fixture.draw(mesh, program as unknown as TangramDrawableProgram);
    expect(fixture.pipelines).toHaveLength(2);
    program.destroy();
    program.destroy();
    expect(fixture.pipelines[1].destroy).toHaveBeenCalledTimes(1);
    fixture.renderer.destroy();
    Object.assign(ShaderProgram, {current: null});
});

test('mesh and shader wrappers release their own resources even if a cache observer fails', () => {
    const fixture = createFixture('webgpu');
    const mesh = new VBOMesh(null, new Float32Array(6), false, {
        stride: 8, getBufferLayout: () => fixture.descriptor.bufferLayout, getStaticAttributes: () => []
    }, {bufferFactory: fixture.renderer.getSceneOptions().meshBufferFactory});
    const program = new ShaderProgram(null, 'vertex', 'fragment', {shaderLanguage: 'wgsl',
        shaderFactory: fixture.renderer.getSceneOptions().shaderFactory}) as ShaderProgram & TangramDrawableProgram;
    program.compile();
    const vertex = program.vertex_shader_resource;
    const fragment = program.fragment_shader_resource;
    observeGPUResourceDisposal(mesh, () => { throw new Error('mesh observer'); });
    observeGPUResourceDisposal(program, () => { throw new Error('shader observer'); });
    expect(() => mesh.destroy()).toThrow(AggregateError);
    expect(fixture.buffers[0].destroy).toHaveBeenCalledTimes(1);
    expect(() => program.destroy()).toThrow(AggregateError);
    expect(vertex.destroy).toHaveBeenCalledTimes(1);
    expect(fragment.destroy).toHaveBeenCalledTimes(1);
    fixture.renderer.destroy();
    Object.assign(ShaderProgram, {current: null});
});
