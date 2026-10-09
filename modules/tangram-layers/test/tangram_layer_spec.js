// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import { assert } from 'chai';
import {expect} from 'vitest';
import {FirstPersonViewport} from '@deck.gl/core';
import createTangramLayerClass, {getFirstPersonViewFrame} from '../src/tangram-layer';
import Camera from '../../tangram-renderer/src/scene/camera';
import LumaDeviceRenderer from '../../tangram-renderer/src/gpu/luma_device_renderer';

const IDENTITY_MATRIX = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1
];

class FakeLayer {
    constructor(props = {}) {
        const defaults = Object.fromEntries(Object.entries(this.constructor.defaultProps).map(([name, value]) =>
            [name, value && typeof value === 'object' && 'value' in value ? value.value : value]));
        this.props = Object.assign({ visible: true, opacity: 1 }, defaults, props);
        this.state = {};
        this.errors = [];
        this.redrawCount = 0;
    }

    setState(state) {
        Object.assign(this.state, state);
    }

    setNeedsRedraw() {
        this.redrawCount++;
    }

    raiseError(error, message) {
        this.errors.push({ error, message });
    }
}

class FakeScene {
    constructor(source, options) {
        this.source = source;
        this.options = options;
        this.listeners = {};
        this.resizeCalls = [];
        this.viewCalls = [];
        this.cameraMatrixCalls = [];
        this.updateCalls = [];
        this.onUpdate = null;
        this.destroyed = false;
        this.loadArguments = null;
        this.deferred = createDeferred();
        this.view = {
            setView: view => this.viewCalls.push(view),
            buffer: 0
        };
    }

    subscribe(listeners) {
        Object.assign(this.listeners, listeners);
    }

    load(source, options) {
        this.loadArguments = { source, options };
        return this.deferred.promise;
    }

    resizeMap(width, height) {
        this.resizeCalls.push([width, height]);
    }

    setCameraMatrices(matrices) {
        this.cameraMatrixCalls.push(matrices);
    }

    withWebGLContext(callback) {
        return this.options.webGLContextScope(callback);
    }

    update(options) {
        this.updateCalls.push(options);
        if (this.onUpdate) {
            this.onUpdate();
        }
        return true;
    }

    destroy() {
        this.destroyed = true;
    }

    emit(type, message) {
        if (this.listeners[type]) {
            this.listeners[type](message);
        }
    }
}

FakeScene.instances = [];
FakeScene.create = function(source, options) {
    const scene = new FakeScene(source, options);
    FakeScene.instances.push(scene);
    return scene;
};

class FakeRenderer {
    constructor(source, options) {
        this.device_renderer = options.device ? new LumaDeviceRenderer(options.device) : null;
        const device_options = this.device_renderer ? this.device_renderer.getSceneOptions() : {};
        this.scene = FakeScene.create(source, Object.assign({}, options, device_options, {
            disableRenderLoop: true,
            cameraMode: 'external'
        }));
        this.frameCalls = [];
        this.renderCalls = [];
    }

    subscribe(listeners) {
        return this.scene.subscribe(listeners);
    }

    load(source, options) {
        return this.scene.load(source, options);
    }

    setFrame(frame) {
        this.frameCalls.push(frame);
        const { viewport, view, camera, tileBuffer } = frame;
        if (this.scene.view.size == null) {
            this.scene.view.size = { css: {} };
        }
        if (this.scene.view.size.css.width !== viewport.width ||
            this.scene.view.size.css.height !== viewport.height) {
            this.scene.view.size.css = { width: viewport.width, height: viewport.height };
            this.scene.resizeMap(viewport.width, viewport.height);
        }
        this.scene.view.setView({
            lng: view.longitude,
            lat: view.latitude,
            zoom: view.zoom
        });
        this.scene.setCameraMatrices(camera);
        this.scene.view.buffer = tileBuffer;
    }

    render(options) {
        this.renderCalls.push(options);
        return this.scene.update(options);
    }

    destroy() {
        this.scene.destroy();
        if (this.device_renderer) {
            this.device_renderer.destroy();
        }
    }
}

FakeRenderer.instances = [];
FakeRenderer.create = function(source, options) {
    const renderer = new FakeRenderer(source, options);
    FakeRenderer.instances.push(renderer);
    return renderer;
};

const TangramLayer = createTangramLayerClass({ Layer: FakeLayer, Renderer: FakeRenderer });

describe('ExternalCamera', function () {
    it('accepts caller-provided matrices and supplies camera uniforms', function () {
        let redraw_count = 0;
        const camera = Camera.create('external', {
            scene: {
                requestRedraw() {
                    redraw_count++;
                }
            }
        }, { type: 'external' });
        const view_matrix = IDENTITY_MATRIX.slice();
        const projection_matrix = IDENTITY_MATRIX.slice();
        view_matrix[12] = -10;
        projection_matrix[0] = 2;

        camera.setMatrices({
            view: view_matrix,
            projection: projection_matrix,
            position: [0, 0, 0]
        });
        camera.setMatrices({
            view: view_matrix,
            projection: projection_matrix,
            position: [0, 0, 0]
        });

        let uniforms;
        camera.setupProgram(null, {
            setUniforms(values) {
                uniforms = values;
            }
        });

        assert.strictEqual(camera.type, 'external');
        assert.strictEqual(camera.view_matrix[12], -10);
        assert.strictEqual(camera.projection_matrix[0], 2);
        assert.deepEqual(uniforms.u_eye, [0, 0, 0]);
        assert.deepEqual(uniforms.u_vanishing_point, [0, 0]);
        assert.strictEqual(redraw_count, 1, 'unchanged matrices do not schedule another frame');

        const tilted_view = IDENTITY_MATRIX.slice();
        tilted_view[5] = 0;
        tilted_view[6] = 1;
        tilted_view[9] = -1;
        tilted_view[10] = 0;
        camera.setMatrices({
            view: tilted_view,
            projection: projection_matrix
        });
        const transformed_light = camera.transformVector([0, 0, -1]);
        assert.closeTo(transformed_light[0], 0, 1e-15);
        assert.closeTo(transformed_light[1], 1, 1e-15);
        assert.closeTo(transformed_light[2], 0, 1e-15);
    });
});

describe('TangramLayer', function () {
    const layers = [];
    const parentElements = [];

    afterEach(async function () {
        for (const layer of layers) {
            if (layer.state.tangramRecord && !layer.state.tangramRecord.disposed) {
                layer.finalizeState();
            }
        }
        for (const scene of FakeScene.instances) {
            scene.deferred.resolve();
        }
        await flushPromises();
        for (const parentElement of parentElements) {
            parentElement.remove();
        }
        layers.length = 0;
        parentElements.length = 0;
        FakeScene.instances.length = 0;
        FakeRenderer.instances.length = 0;
    });

    it('shares deck WebGL context with Tangram and synchronizes the viewport', function () {
        const { layer, parentElement, deckCanvas, device } = createLayer();
        const scene = FakeScene.instances[0];

        assert.lengthOf(parentElement.children, 1);
        assert.strictEqual(parentElement.children[0], deckCanvas);
        assert.strictEqual(scene.options.webGLContext, device.handle);
        assert.isTrue(scene.options.disableRenderLoop);
        assert.strictEqual(scene.options.cameraMode, 'external');
        assert.isTrue(scene.options.enableUniformBuffers);
        assert.isTrue(scene.options.deviceShaderCompilation);
        assert.isFunction(scene.options.uniformBufferFactory);
        assert.isFunction(scene.options.shaderFactory);
        assert.isFunction(scene.options.shaderProgramValidator);
        assert.isFunction(scene.options.meshBufferFactory);
        assert.isFunction(scene.options.textureFactory);
        assert.strictEqual(scene.options.maxTextureSize, 8192);
        assert.isObject(scene.options.meshRenderer);
        assert.isFunction(scene.options.meshRenderer.drawMesh);
        assert.isFunction(scene.options.webGLContextScope);
        assert.isFunction(scene.options.requestRedraw);
        assert.strictEqual(scene.options.canvas, deckCanvas);
        assert.deepEqual(scene.resizeCalls, [[800, 600]]);
        assert.deepEqual(scene.viewCalls, [{
            lng: -74.009764,
            lat: 40.705319,
            zoom: 16.25
        }]);
        assert.lengthOf(scene.cameraMatrixCalls, 1);
        assert.closeTo(scene.cameraMatrixCalls[0].view[0], 512 / 40075016.68557849, 1e-15);
        assert.closeTo(scene.cameraMatrixCalls[0].view[5], 512 / 40075016.68557849, 1e-15);
        assert.strictEqual(scene.cameraMatrixCalls[0].view[10], 0.00002);
        assert.strictEqual(scene.cameraMatrixCalls[0].view[12], 256);
        assert.strictEqual(scene.cameraMatrixCalls[0].view[13], 256);
        assert.deepEqual(Array.from(scene.cameraMatrixCalls[0].projection), IDENTITY_MATRIX);

        const uniform_buffer = scene.options.uniformBufferFactory({
            id: 'TangramView',
            byteLength: 64,
            usage: 'uniform'
        });
        assert.strictEqual(uniform_buffer, device.buffers[0]);
        assert.deepEqual(device.bufferOptions, [{
            id: 'tangram-TangramView',
            byteLength: 64,
            usage: 0x0048
        }]);

        const shader = scene.options.shaderFactory({
            id: 'polygons-vertex',
            stage: 'vertex',
            source: '#version 300 es\nvoid main() {}'
        });
        assert.strictEqual(shader, device.shaders[0]);
        assert.deepEqual(device.shaderOptions, [{
            id: 'tangram-polygons-vertex',
            language: 'glsl',
            stage: 'vertex',
            source: '#version 300 es\nvoid main() {}'
        }]);

        const vertex_data = new Float32Array([0, 1, 2, 3]);
        const vertex_buffer = scene.options.meshBufferFactory({
            id: 'mesh-1-vertices',
            usage: 'vertex',
            data: vertex_data
        });
        assert.strictEqual(vertex_buffer, device.buffers[1]);
        assert.deepEqual(device.bufferOptions[1], {
            id: 'tangram-mesh-1-vertices',
            usage: 0x0028,
            data: vertex_data
        });

        const texture_data = new Uint8Array(16);
        const texture = scene.options.textureFactory({
            id: 'labels',
            width: 2,
            height: 2,
            data: texture_data,
            filtering: 'mipmap',
            repeat: true,
            flipY: false,
            premultipliedAlpha: true
        });
        assert.strictEqual(texture, device.textures[0]);
        assert.deepEqual(device.textureOptions, [{
            id: 'tangram-labels',
            width: 2,
            height: 2,
            format: 'rgba8unorm',
            usage: 0x0016,
            mipLevels: 2,
            sampler: {
                minFilter: 'linear',
                magFilter: 'linear',
                mipmapFilter: 'linear',
                addressModeU: 'repeat',
                addressModeV: 'repeat'
            }
        }]);
        assert.deepEqual(texture.writeCalls, [[texture_data, { width: 2, height: 2 }]]);
        assert.strictEqual(texture.mipmapCalls, 1);

        layer.draw();
        assert.lengthOf(scene.resizeCalls, 1, 'unchanged dimensions do not resize again');
    });

    it('selects first-person tiles from the visible ground footprint', function () {
        const viewport = new FirstPersonViewport({
            width: 800,
            height: 600,
            longitude: -74.009764,
            latitude: 40.705319,
            position: [0, 0, 600],
            bearing: 0,
            pitch: 60,
            far: 20000
        });
        const expected_frame = getFirstPersonViewFrame(viewport);
        const { layer } = createLayer({}, { viewport });
        const frame = FakeRenderer.instances[0].frameCalls[0];

        assert.lengthOf(layer.errors, 0);
        assert.deepEqual(frame.viewport, { width: 800, height: 600 });
        assert.closeTo(frame.view.longitude, expected_frame.view.longitude, 1e-12);
        assert.closeTo(frame.view.latitude, expected_frame.view.latitude, 1e-12);
        assert.closeTo(frame.view.zoom, expected_frame.view.zoom, 1e-12);
        expect(frame.view.altitude).toBeCloseTo(600, 7);
        assert.strictEqual(frame.tileBuffer, 1);
        assert.isAbove(frame.view.zoom, 14);
        assert.isBelow(frame.view.zoom, viewport.zoom + 1);
        assert.lengthOf(frame.camera.view, 16);
        assert.lengthOf(frame.camera.projection, 16);
    });

    it('renders on a WebGPU device without reading its raw handle', async function () {
        const { layer, device } = createLayer({}, { deviceType: 'webgpu' });
        const scene = FakeScene.instances[0];
        await flushPromises();
        scene.deferred.resolve();
        await flushPromises();

        const render_pass = createFakeRenderPass();
        layer.draw({ renderPass: render_pass });

        assert.strictEqual(scene.options.device, device);
        assert.strictEqual(scene.options.shaderLanguage, 'wgsl');
        assert.notProperty(scene.options, 'webGLContext');
        assert.notProperty(scene.options, 'webGLContextScope');
        assert.deepEqual(scene.updateCalls, [{ force: true, renderPass: render_pass }]);
        assert.deepEqual(device.stateCalls, []);
    });

    it('keeps an explicitly animated host-driven scene drawing while the view is idle', async function () {
        const { layer } = createLayer({}, { deviceType: 'webgpu' });
        const scene = FakeScene.instances[0];
        await flushPromises();
        scene.deferred.resolve();
        await flushPromises();
        scene.config = { scene: { animated: true } };
        const redraw_count = layer.redrawCount;

        layer.draw({ renderPass: createFakeRenderPass() });

        assert.strictEqual(layer.redrawCount, redraw_count + 1);
    });

    it('builds and caches luma render pipelines and vertex arrays for Tangram meshes', async function () {
        const { layer, device } = createLayer();
        const scene = FakeScene.instances[0];
        await flushPromises();
        scene.deferred.resolve();
        await flushPromises();

        const vertex_buffer = { id: 'vertices' };
        const index_buffer = { id: 'indices' };
        const view_buffer = { id: 'view' };
        const vertex_layout = {};
        const descriptor = {
            topology: 'triangle-list',
            vertexCount: 4,
            indexCount: 6,
            indexType: 'uint16',
            vertexBuffer: vertex_buffer,
            indexBuffer: index_buffer,
            bufferLayout: {
                name: 'vertices',
                byteStride: 12,
                attributes: [{ attribute: 'a_position', format: 'float32x2', byteOffset: 0 }]
            },
            staticAttributes: [{ attribute: 'a_color', value: [1, 0, 0, 1] }]
        };
        const uniform_values = { u_scale: 2 };
        const program = {
            id: 4,
            name: 'polygons',
            vertex_shader_resource: { id: 'vs' },
            fragment_shader_resource: { id: 'fs' },
            getBindings: () => ({ TangramView: view_buffer }),
            getUniformValues: () => Object.assign({}, uniform_values),
            uniform(method, name, value) {
                uniform_values[name] = value;
            }
        };
        const mesh = {
            id: 9,
            vertex_layout,
            uniforms: null,
            getDrawDescriptor: () => descriptor
        };
        const render_pass = createFakeRenderPass();
        const render_state = {
            cullMode: 'back',
            depthCompare: 'always',
            depthWriteEnabled: false,
            blend: true,
            blendColorOperation: 'add',
            blendColorSrcFactor: 'src-alpha',
            blendColorDstFactor: 'one-minus-src-alpha',
            blendAlphaOperation: 'add',
            blendAlphaSrcFactor: 'one',
            blendAlphaDstFactor: 'one-minus-src-alpha'
        };

        const needs_redraw = scene.options.meshRenderer.drawMesh({
            mesh,
            program,
            renderPass: render_pass,
            renderState: render_state,
            visibleTime: 0.25
        });
        scene.options.meshRenderer.drawMesh({
            mesh,
            program,
            renderPass: render_pass,
            renderState: render_state,
            visibleTime: 0.5
        });

        assert.isFalse(needs_redraw);
        assert.lengthOf(device.pipelines, 1, 'pipeline is cached by program, layout, and topology');
        assert.lengthOf(device.vertexArrays, 1, 'vertex array is cached by mesh and pipeline');
        assert.deepEqual(device.pipelineOptions[0], {
            id: 'tangram-polygons-triangle-list-0',
            vs: program.vertex_shader_resource,
            fs: program.fragment_shader_resource,
            bufferLayout: [descriptor.bufferLayout],
            topology: 'triangle-list',
            disableWarnings: true,
            parameters: render_state
        });
        assert.deepEqual(device.vertexArrays[0].bufferCalls, [[0, vertex_buffer]]);
        assert.strictEqual(device.vertexArrays[0].constantCalls[0][0], 1);
        assert.deepEqual(Array.from(device.vertexArrays[0].constantCalls[0][1]), [1, 0, 0, 1]);
        assert.deepEqual(device.vertexArrays[0].indexCalls, [index_buffer]);
        assert.strictEqual(render_pass.calls[0][0], 'pipeline');
        assert.deepEqual(render_pass.calls[1], ['bindings', { TangramView: view_buffer }]);
        assert.strictEqual(render_pass.calls[2][0], 'vertexArray');
        assert.deepEqual(render_pass.calls[3], ['draw', {
            vertexCount: undefined,
            indexCount: 6,
            uniforms: { u_scale: 2, u_visible_time: 0.25 }
        }]);

        scene.options.meshRenderer.drawMesh({
            mesh,
            program,
            renderPass: render_pass,
            renderState: Object.assign({}, render_state, { blend: false }),
            visibleTime: 0.75
        });
        assert.lengthOf(device.pipelines, 2, 'render state selects a distinct pipeline');
        assert.lengthOf(device.vertexArrays, 2, 'vertex arrays match their render pipeline');

        layer.finalizeState();
        assert.isTrue(device.pipelines[0].destroyed);
        assert.isTrue(device.pipelines[1].destroyed);
        assert.isTrue(device.vertexArrays[0].destroyed);
        assert.isTrue(device.vertexArrays[1].destroyed);
    });

    it('binds luma texture resources without falling back to raw WebGL drawing', function () {
        const { device } = createLayer();
        const scene = FakeScene.instances[0];
        const texture = { id: 'texture' };
        device.pipelineShaderLayout = {
            attributes: [],
            bindings: [{ type: 'texture', name: 'u_texture' }]
        };
        const uniform_values = {};
        const render_pass = createFakeRenderPass();
        const result = scene.options.meshRenderer.drawMesh({
            mesh: {
                id: 1,
                vertex_layout: {},
                uniforms: null,
                getDrawDescriptor: () => ({
                    topology: 'triangle-list',
                    vertexBuffer: {},
                    indexBuffer: null,
                    vertexCount: 3,
                    indexCount: 0,
                    bufferLayout: { name: 'vertices', attributes: [] },
                    staticAttributes: []
                })
            },
            program: {
                id: 1,
                name: 'textured',
                vertex_shader_resource: {},
                fragment_shader_resource: {},
                getBindings: () => ({ u_texture: texture }),
                getUniformValues: () => uniform_values,
                uniform(method, name, value) {
                    uniform_values[name] = value;
                }
            },
            renderPass: render_pass,
            visibleTime: 0
        });

        assert.isFalse(result);
        assert.lengthOf(device.pipelines, 1);
        assert.lengthOf(device.vertexArrays, 1);
        assert.deepEqual(render_pass.calls[1], ['bindings', { u_texture: texture }]);
    });

    it('rejects missing pipeline bindings instead of falling back to raw WebGL drawing', function () {
        const { device } = createLayer();
        const scene = FakeScene.instances[0];
        device.pipelineShaderLayout = {
            attributes: [],
            bindings: [{ type: 'texture', name: 'u_texture' }]
        };

        assert.throws(() => scene.options.meshRenderer.drawMesh({
            mesh: {
                id: 1,
                vertex_layout: {},
                uniforms: null,
                getDrawDescriptor: () => ({
                    topology: 'triangle-list',
                    vertexBuffer: {},
                    indexBuffer: null,
                    vertexCount: 3,
                    indexCount: 0,
                    bufferLayout: { name: 'vertices', attributes: [] },
                    staticAttributes: []
                })
            },
            program: {
                id: 1,
                name: 'missing-texture',
                vertex_shader_resource: {},
                fragment_shader_resource: {},
                getBindings: () => ({}),
                getUniformValues: () => ({}),
                uniform() {}
            },
            renderPass: createFakeRenderPass(),
            visibleTime: 0
        }), /missing 'u_texture' binding/);
        assert.lengthOf(device.vertexArrays, 0);
    });

    it('injects the runtime API key and reports a successful load', async function () {
        let loadedScene = null;
        const { layer } = createLayer({
            apiKey: 'runtime-key',
            onSceneLoad: scene => { loadedScene = scene; }
        });
        const scene = FakeScene.instances[0];
        await flushPromises();

        const config = {
            sources: {
                nextzen: {
                    url: 'https://tile.nextzen.org/tile/{z}/{x}/{y}.mvt',
                    url_params: { existing: 'value' }
                },
                other: { url: 'https://example.com/{z}/{x}/{y}.mvt' }
            }
        };
        scene.emit('load', { config });
        scene.deferred.resolve('loaded');
        await flushPromises();

        assert.strictEqual(config.sources.nextzen.url_params.api_key, 'runtime-key');
        assert.strictEqual(config.sources.nextzen.url_params.existing, 'value');
        assert.notProperty(config.sources.other, 'url_params');
        assert.strictEqual(loadedScene, scene);
        assert.isTrue(layer.isLoaded);
        assert.strictEqual(layer.redrawCount, 1);

        scene.options.requestRedraw();
        assert.strictEqual(layer.redrawCount, 2);
    });

    it('renders through luma WebGL state management and restores the compile-time program', async function () {
        const { layer, device, gl } = createLayer();
        const scene = FakeScene.instances[0];
        await flushPromises();
        scene.deferred.resolve();
        await flushPromises();

        const render_pass = {};
        layer.draw({ renderPass: render_pass });

        assert.deepEqual(device.stateCalls, ['push', 'pop']);
        assert.deepEqual(scene.updateCalls, [{ force: true, renderPass: render_pass }]);
        assert.deepEqual(FakeRenderer.instances[0].renderCalls, [{
            force: true,
            renderPass: render_pass
        }]);
        assert.deepInclude(gl.calls, ['depthMask', true]);
        assert.deepInclude(gl.calls, ['clear', gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT]);
        assert.deepInclude(gl.calls, ['useProgram', 'deck-program']);
        assert.notDeepInclude(gl.calls, ['activeTexture', 'deck-active-texture']);
    });

    it('does not inspect raw texture or uniform-buffer bindings during a luma render', async function () {
        const { layer, gl } = createLayer();
        const scene = FakeScene.instances[0];
        await flushPromises();
        scene.deferred.resolve();
        await flushPromises();

        scene.uniform_buffers = { TangramView: { binding: 0 } };

        layer.draw();

        assert.notInclude(gl.parameterQueries, gl.ACTIVE_TEXTURE);
        assert.notInclude(gl.parameterQueries, gl.UNIFORM_BUFFER_BINDING);
        assert.lengthOf(gl.indexedParameterQueries, 0);
        assert.notDeepInclude(gl.calls, ['activeTexture', 'deck-active-texture']);
    });

    it('honors inherited visibility and zero opacity', async function () {
        const { layer } = createLayer();
        const scene = FakeScene.instances[0];
        await flushPromises();
        scene.deferred.resolve();
        await flushPromises();
        const hiddenProps = Object.assign({}, layer.props, { visible: false, opacity: 0.4 });

        layer.props = hiddenProps;
        layer.updateState({ props: hiddenProps, oldProps: {} });
        layer.draw();
        assert.lengthOf(scene.updateCalls, 0);

        const visibleProps = Object.assign({}, hiddenProps, { visible: true });
        layer.props = visibleProps;
        layer.updateState({ props: visibleProps, oldProps: hiddenProps });
        layer.draw();
        assert.lengthOf(scene.updateCalls, 1);

        layer.props = Object.assign({}, visibleProps, { opacity: 0 });
        layer.draw();
        assert.lengthOf(scene.updateCalls, 1);
    });

    it('synchronizes pitch and bearing through the external camera', function () {
        const { layer } = createLayer();
        const scene = FakeScene.instances[0];
        const rotated_view = IDENTITY_MATRIX.slice();
        rotated_view[0] = 0;
        rotated_view[1] = 1;
        rotated_view[4] = -1;
        rotated_view[5] = 0;

        layer.context.viewport = Object.assign({}, layer.context.viewport, {
            bearing: 25,
            pitch: 40,
            viewMatrix: rotated_view
        });
        layer.draw();

        assert.lengthOf(layer.errors, 0);
        assert.lengthOf(scene.cameraMatrixCalls, 2);
        assert.closeTo(scene.cameraMatrixCalls[1].view[1], 512 / 40075016.68557849, 1e-15);
        assert.closeTo(scene.cameraMatrixCalls[1].view[4], -512 / 40075016.68557849, 1e-15);
        assert.strictEqual(scene.view.buffer, 2);
    });

    it('hides the basemap and reports unsupported viewport states once', function () {
        const { layer, deck } = createLayer();
        const record = layer.state.tangramRecord;

        layer.context.viewport = Object.assign({}, layer.context.viewport, { pitch: 90 });
        layer.draw();
        layer.draw();
        assert.lengthOf(record.scene.updateCalls, 0);
        assert.lengthOf(layer.errors, 1);
        assert.match(layer.errors[0].error.message, /bearing and pitch/);

        layer.context.viewport = Object.assign({}, layer.context.viewport, { pitch: 0 });
        deck.viewports = [layer.context.viewport, layer.context.viewport];
        layer.draw();
        assert.lengthOf(layer.errors, 2);
        assert.match(layer.errors[1].error.message, /only one/);

        deck.viewports = null;
        layer.context.viewport = Object.assign({}, layer.context.viewport, { isGeospatial: false });
        layer.draw();
        assert.lengthOf(layer.errors, 3);
        assert.match(layer.errors[2].error.message, /Web Mercator/);

        layer.context.viewport = Object.assign({}, layer.context.viewport, {
            isGeospatial: true,
            viewMatrix: null
        });
        layer.draw();
        assert.lengthOf(layer.errors, 4);
        assert.match(layer.errors[3].error.message, /camera matrices/);

        class GlobeViewport {}
        const globeViewport = Object.assign(new GlobeViewport(), layer.context.viewport, {
            longitude: Number.NaN,
            viewMatrix: IDENTITY_MATRIX,
            projectionMatrix: IDENTITY_MATRIX,
            getBounds: () => [-120, -35, 10, 72]
        });
        deck.viewports = [globeViewport];
        layer.context.viewport = globeViewport;
        layer.draw();
        assert.lengthOf(layer.errors, 5);
        assert.match(layer.errors[4].error.message, /GlobeViewport requires finite longitude/);
    });

    it('reports scene load failures and skips shared-context rendering', async function () {
        let reportedError = null;
        const { layer } = createLayer({
            onSceneError: error => { reportedError = error; }
        });
        const scene = FakeScene.instances[0];
        await flushPromises();

        scene.deferred.reject(new Error('scene failed'));
        await flushPromises();

        assert.strictEqual(reportedError.message, 'scene failed');
        layer.draw();
        assert.lengthOf(scene.updateCalls, 0);
        assert.lengthOf(layer.errors, 1);
        assert.strictEqual(layer.errors[0].message, 'TangramLayer scene');
    });

    it('reports nonfatal scene import failures without disabling rendering', async function () {
        let reportedError = null;
        const { layer } = createLayer({
            onSceneError: error => { reportedError = error; }
        });
        const scene = FakeScene.instances[0];
        await flushPromises();

        scene.emit('error', {
            type: 'scene_import',
            message: 'Failed to import scene: optional.yaml',
            error: new Error('optional scene failed')
        });
        scene.deferred.resolve();
        await flushPromises();

        assert.strictEqual(reportedError.message, 'optional scene failed');
        assert.isFalse(layer.state.tangramRecord.loadFailed);
        layer.draw();
        assert.lengthOf(scene.updateCalls, 1);
    });

    it('destroys a loaded scene without removing deck canvas during finalization', async function () {
        const { layer, parentElement, deckCanvas } = createLayer();
        const scene = FakeScene.instances[0];
        await flushPromises();
        scene.deferred.resolve();
        await flushPromises();

        layer.finalizeState();
        assert.isTrue(scene.destroyed);
        assert.strictEqual(parentElement.children[0], deckCanvas);
    });

    it('guards callbacks and defers destruction when finalized during loading', async function () {
        let loadCallbackCount = 0;
        const { layer, parentElement, deckCanvas } = createLayer({
            onSceneLoad: () => { loadCallbackCount++; }
        });
        const scene = FakeScene.instances[0];
        await flushPromises();

        layer.finalizeState();
        assert.isFalse(scene.destroyed);
        assert.strictEqual(parentElement.children[0], deckCanvas);

        scene.deferred.resolve();
        await flushPromises();
        assert.isTrue(scene.destroyed);
        assert.strictEqual(loadCallbackCount, 0);
    });

    function createLayer(props = {}, { deviceType = 'webgl', viewport: providedViewport } = {}) {
        const parentElement = document.createElement('div');
        parentElement.style.position = 'relative';
        const deckCanvas = document.createElement('canvas');
        Object.defineProperties(deckCanvas, {
            clientWidth: { configurable: true, value: 800 },
            clientHeight: { configurable: true, value: 600 },
            offsetLeft: { configurable: true, value: 4 },
            offsetTop: { configurable: true, value: 6 }
        });
        parentElement.appendChild(deckCanvas);
        document.body.appendChild(parentElement);
        parentElements.push(parentElement);

        const viewport = providedViewport || {
            longitude: -74.009764,
            latitude: 40.705319,
            zoom: 15.25,
            bearing: 0,
            pitch: 0,
            isGeospatial: true,
            // deck.gl selects WEB_MERCATOR_AUTO_OFFSET at zoom 12 and above.
            projectionMode: 4,
            width: 800,
            height: 600,
            viewMatrix: IDENTITY_MATRIX,
            projectionMatrix: IDENTITY_MATRIX,
            distanceScales: {
                unitsPerMeter: [0.00002, 0.00002, 0.00002]
            }
        };
        const gl = createFakeWebGLContext(deckCanvas);
        const device = {
            type: 'webgl',
            info: { shadingLanguage: 'glsl' },
            handle: gl,
            limits: { maxTextureDimension2D: 8192 },
            bufferOptions: [],
            buffers: [],
            shaderOptions: [],
            shaders: [],
            textureOptions: [],
            textures: [],
            pipelineOptions: [],
            pipelines: [],
            vertexArrayOptions: [],
            vertexArrays: [],
            pipelineShaderLayout: {
                attributes: [
                    { name: 'a_position', location: 0 },
                    { name: 'a_color', location: 1 }
                ],
                bindings: [{ type: 'uniform', name: 'TangramView' }]
            },
            stateCalls: [],
            createBuffer(options) {
                this.bufferOptions.push(options);
                const buffer = {
                    handle: {},
                    writes: [],
                    destroyed: false,
                    write(data) {
                        this.writes.push(data);
                    },
                    destroy() {
                        this.destroyed = true;
                    }
                };
                this.buffers.push(buffer);
                return buffer;
            },
            createShader(options) {
                this.shaderOptions.push(options);
                const shader = {
                    handle: {},
                    destroyed: false,
                    destroy() {
                        this.destroyed = true;
                    }
                };
                this.shaders.push(shader);
                return shader;
            },
            createTexture(options) {
                this.textureOptions.push(options);
                const texture = {
                    handle: {},
                    writeCalls: [],
                    externalImageCalls: [],
                    mipmapCalls: 0,
                    destroyed: false,
                    writeData(...args) {
                        this.writeCalls.push(args);
                    },
                    copyExternalImage(options) {
                        this.externalImageCalls.push(options);
                    },
                    generateMipmapsWebGL() {
                        this.mipmapCalls++;
                    },
                    destroy() {
                        this.destroyed = true;
                    }
                };
                this.textures.push(texture);
                return texture;
            },
            createRenderPipeline(options) {
                this.pipelineOptions.push(options);
                const pipeline = {
                    id: options.id,
                    shaderLayout: this.pipelineShaderLayout,
                    bufferLayout: options.bufferLayout,
                    isPending: false,
                    destroyed: false,
                    destroy() {
                        this.destroyed = true;
                    }
                };
                this.pipelines.push(pipeline);
                return pipeline;
            },
            createVertexArray(options) {
                this.vertexArrayOptions.push(options);
                const vertex_array = {
                    bufferCalls: [],
                    constantCalls: [],
                    indexCalls: [],
                    destroyed: false,
                    setBuffer(...args) {
                        this.bufferCalls.push(args);
                    },
                    setConstantWebGL(...args) {
                        this.constantCalls.push(args);
                    },
                    setIndexBuffer(buffer) {
                        this.indexCalls.push(buffer);
                    },
                    destroy() {
                        this.destroyed = true;
                    }
                };
                this.vertexArrays.push(vertex_array);
                return vertex_array;
            },
            pushState() {
                this.stateCalls.push('push');
            },
            popState() {
                this.stateCalls.push('pop');
            }
        };
        if (deviceType === 'webgpu') {
            device.type = 'webgpu';
            device.info.shadingLanguage = 'wgsl';
            delete device.handle;
            Object.defineProperty(device, 'handle', {
                get() {
                    throw new Error('WebGPU device.handle must not be read');
                }
            });
        }
        const deck = {
            viewports: null,
            getCanvas: () => deckCanvas,
            getViewports() {
                return this.viewports || [layer.context.viewport];
            }
        };
        const layer = new TangramLayer(Object.assign({
            id: 'tangram-test',
            scene: 'scene.yaml',
            apiKey: null
        }, props));
        layer.context = { deck, device, viewport };
        layer.initializeState();
        layer.updateState({ props: layer.props, oldProps: {} });
        layers.push(layer);
        return { layer, deck, deckCanvas, device, gl, parentElement };
    }
});

function createFakeRenderPass() {
    return {
        calls: [],
        setPipeline(pipeline) {
            this.calls.push(['pipeline', pipeline]);
        },
        setBindings(bindings) {
            this.calls.push(['bindings', bindings]);
        },
        setVertexArray(vertex_array) {
            this.calls.push(['vertexArray', vertex_array]);
        },
        draw(options) {
            this.calls.push(['draw', options]);
            return true;
        }
    };
}


function createFakeWebGLContext(canvas) {
    const gl = {
        canvas,
        CURRENT_PROGRAM: 0x8B8D,
        ACTIVE_TEXTURE: 0x84E0,
        DEPTH_BUFFER_BIT: 0x0100,
        STENCIL_BUFFER_BIT: 0x0400,
        UNIFORM_BUFFER: 0x8A11,
        UNIFORM_BUFFER_BINDING: 0x8A28,
        UNIFORM_BUFFER_START: 0x8A29,
        UNIFORM_BUFFER_SIZE: 0x8A2A,
        lumaState: { program: 'deck-program' },
        uniformBuffer: null,
        indexedUniformBuffers: {},
        parameterQueries: [],
        indexedParameterQueries: [],
        calls: [],
        getParameter(parameter) {
            this.parameterQueries.push(parameter);
            if (parameter === this.ACTIVE_TEXTURE) {
                return 'deck-active-texture';
            }
            if (parameter === this.UNIFORM_BUFFER_BINDING) {
                return this.uniformBuffer;
            }
            return null;
        },
        getIndexedParameter(parameter, binding) {
            this.indexedParameterQueries.push([parameter, binding]);
            const state = this.indexedUniformBuffers[binding] || {};
            if (parameter === this.UNIFORM_BUFFER_BINDING) {
                return state.buffer || null;
            }
            if (parameter === this.UNIFORM_BUFFER_START) {
                return state.start || 0;
            }
            if (parameter === this.UNIFORM_BUFFER_SIZE) {
                return state.size || 0;
            }
            return null;
        },
        useProgram(program) {
            this.calls.push(['useProgram', program]);
            this.lumaState.program = program;
        },
        activeTexture(texture) {
            this.calls.push(['activeTexture', texture]);
        },
        bindBuffer(target, buffer) {
            this.uniformBuffer = buffer;
            this.calls.push(['bindBuffer', target, buffer]);
        },
        bindBufferBase(target, binding, buffer) {
            this.indexedUniformBuffers[binding] = { buffer, start: 0, size: 0 };
            this.uniformBuffer = buffer;
            this.calls.push(['bindBufferBase', target, binding, buffer]);
        },
        bindBufferRange(target, binding, buffer, start, size) {
            this.indexedUniformBuffers[binding] = { buffer, start, size };
            this.uniformBuffer = buffer;
            this.calls.push(['bindBufferRange', target, binding, buffer, start, size]);
        },
        depthMask(value) {
            this.calls.push(['depthMask', value]);
        },
        clear(mask) {
            this.calls.push(['clear', mask]);
        }
    };
    return gl;
}

function createDeferred() {
    let resolvePromise;
    let rejectPromise;
    let settled = false;
    const promise = new Promise((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
    });
    return {
        promise,
        resolve(value) {
            if (!settled) {
                settled = true;
                resolvePromise(value);
            }
        },
        reject(error) {
            if (!settled) {
                settled = true;
                rejectPromise(error);
            }
        }
    };
}

async function flushPromises() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}
