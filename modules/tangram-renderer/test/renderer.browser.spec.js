// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import { assert } from 'chai';
import Renderer from '../src/scene/renderer';
import HostFrame from '../src/scene/host_frame';

const IDENTITY_MATRIX = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1
];

describe('Renderer', function () {
    it('constructs an externally driven scene and applies a host frame', function () {
        const renderer = Renderer.create({});
        const scene = renderer.scene;
        sinon.spy(scene, 'resizeMap');
        sinon.spy(scene.view, 'setView');
        sinon.spy(scene, 'setCameraMatrices');

        renderer.setFrame({
            viewport: { width: 800, height: 600 },
            view: { longitude: -74, latitude: 40.7, zoom: 16 },
            camera: {
                view: IDENTITY_MATRIX,
                projection: IDENTITY_MATRIX,
                position: [0, 0, 0]
            },
            tileBuffer: 2
        });

        assert.isFalse(scene.render_loop);
        assert.strictEqual(scene.view.camera_mode, 'external');
        assert.isTrue(scene.view.external_camera);
        assert.isTrue(scene.resizeMap.calledWith(800, 600));
        assert.isTrue(scene.view.setView.calledWith({ lng: -74, lat: 40.7, zoom: 16 }));
        assert.isTrue(scene.setCameraMatrices.calledOnce);
        assert.strictEqual(scene.view.buffer, 2);
    });

    it('submits updates directly to the host render pass', function () {
        const renderer = Renderer.create({});
        const render_pass = {};
        sinon.stub(renderer.scene, 'updateScene').returns(true);
        sinon.spy(renderer.scene, 'processTasks');

        const rendered = renderer.render({ force: true, renderPass: render_pass });

        assert.isTrue(rendered);
        assert.isTrue(renderer.scene.dirty);
        assert.isTrue(renderer.scene.updateScene.calledWith({ renderPass: render_pass }));
        assert.isTrue(renderer.scene.processTasks.calledOnce);
    });

    it('accepts globe frames and selects tiles from host visibility bounds', function () {
        const renderer = Renderer.create({});
        const scene = renderer.scene;
        sinon.spy(scene, 'resizeMap');
        sinon.spy(scene.view, 'setView');
        const frame = new HostFrame({
            viewport: { width: 800, height: 600 },
            geographicAnchor: { longitude: -74, latitude: 40.7, zoom: 3 },
            projection: { type: 'globe', visibleBounds: [-100, 20, -50, 60] },
            renderViews: [{
                id: 'main',
                camera: {
                    view: IDENTITY_MATRIX,
                    projection: IDENTITY_MATRIX,
                    position: [0, -1000, 0]
                }
            }]
        });

        renderer.setFrame(frame);

        assert.strictEqual(renderer.host_frame, frame);
        assert.deepEqual(scene.view.projection, {
            type: 'globe',
            visibleBounds: [-100, 20, -50, 60]
        });
        assert.isTrue(scene.resizeMap.calledWith(800, 600));
        assert.isTrue(scene.view.setView.calledWith({lng: -74, lat: 40.7, zoom: 3}));
        const coordinates = scene.view.findVisibleTileCoordinates();
        assert.isAbove(coordinates.length, 0);
        assert.isTrue(coordinates.every(coordinate => coordinate.z === 3));
    });

    it('delegates globe tile selection to the injected globe visibility policy', function () {
        const coordinates = [{x: 1, y: 2, z: 4}];
        const globeVisibilityAdapter = {
            findVisibleTileCoordinates: sinon.stub().returns(coordinates)
        };
        const renderer = Renderer.create({}, {globeVisibilityAdapter});
        const visibleBounds = [-100, 20, -50, 60];

        renderer.setFrame(new HostFrame({
            viewport: {width: 800, height: 600},
            geographicAnchor: {longitude: -74, latitude: 40.7, zoom: 4},
            projection: {type: 'globe', visibleBounds},
            renderViews: [{
                id: 'main',
                camera: {
                    view: IDENTITY_MATRIX,
                    projection: IDENTITY_MATRIX,
                    position: [0, -1000, 0]
                }
            }]
        }));

        assert.deepEqual(renderer.scene.view.findVisibleTileCoordinates(), coordinates);
        assert.isTrue(globeVisibilityAdapter.findVisibleTileCoordinates.calledWith({
            tile_zoom: 4,
            buffer: 0,
            visibleBounds,
            cameraPosition: [0, -1000, 0]
        }));
    });

    it('invalidates tile visibility only when host projection metadata changes', function () {
        const renderer = Renderer.create({});
        const scene = renderer.scene;
        const createFrame = visibleBounds => new HostFrame({
            viewport: { width: 800, height: 600 },
            geographicAnchor: { longitude: -74, latitude: 40.7, zoom: 3 },
            projection: { type: 'globe', visibleBounds },
            renderViews: [{
                id: 'main',
                camera: {
                    view: IDENTITY_MATRIX,
                    projection: IDENTITY_MATRIX,
                    position: [0, 0, 1]
                }
            }]
        });
        const updateBounds = sinon.spy(scene.view, 'updateBounds');

        renderer.setFrame(createFrame([-100, 20, -50, 60]));
        updateBounds.resetHistory();
        renderer.setFrame(createFrame([-100, 20, -50, 60]));

        assert.isTrue(updateBounds.notCalled);

        renderer.setFrame(createFrame([-101, 20, -50, 60]));
        assert.isTrue(updateBounds.calledOnce);
    });

    it('accepts an injected renderer visibility and LOD policy', function () {
        const calls = {bounds: 0, tiles: 0};
        const visibility_adapter = {
            calculateBounds() {
                calls.bounds++;
                return {
                    tileZoom: 4,
                    metersPerPixel: 1,
                    sizeMeters: {x: 800, y: 600},
                    centerMeters: {x: 0, y: 0},
                    centerTile: {x: 2, y: 2, z: 4},
                    bounds: {sw: {x: -400, y: -300}, ne: {x: 400, y: 300}}
                };
            },
            findVisibleTileCoordinates() {
                calls.tiles++;
                return [];
            }
        };
        const renderer = Renderer.create({}, {visibilityAdapter: visibility_adapter});

        renderer.setFrame({
            viewport: {width: 800, height: 600},
            view: {longitude: -74, latitude: 40.7, zoom: 3},
            camera: {
                view: IDENTITY_MATRIX,
                projection: IDENTITY_MATRIX,
                position: [0, 0, 0]
            }
        });

        assert.isAbove(calls.bounds, 0);
        assert.strictEqual(renderer.scene.view.tile_zoom, 4);
        assert.strictEqual(renderer.scene.view.meters_per_pixel, 1);
        assert.deepEqual(renderer.scene.view.bounds, {
            sw: {x: -400, y: -300},
            ne: {x: 400, y: 300}
        });
        assert.deepEqual(renderer.scene.view.findVisibleTileCoordinates(), []);
        assert.isAbove(calls.tiles, 0);
    });

    it('selects multiple render views over shared geographic state', function () {
        const renderer = Renderer.create({});
        const scene = renderer.scene;
        sinon.spy(scene, 'resizeMap');
        sinon.spy(scene.view, 'setView');
        sinon.spy(scene, 'setCameraMatrices');
        sinon.stub(scene, 'updateScene').returns(true);

        const left_view = IDENTITY_MATRIX.slice();
        const right_view = IDENTITY_MATRIX.slice();
        left_view[12] = -0.03;
        right_view[12] = 0.03;
        const frame = new HostFrame({
            viewport: { width: 1600, height: 600 },
            geographicAnchor: { longitude: -74, latitude: 40.7, zoom: 16 },
            renderViews: [
                {
                    id: 'left-eye',
                    viewport: { x: 0, y: 0, width: 800, height: 600 },
                    camera: { view: left_view, projection: IDENTITY_MATRIX, position: [-0.03, 0, 0] }
                },
                {
                    id: 'right-eye',
                    viewport: { x: 800, y: 0, width: 800, height: 600 },
                    camera: { view: right_view, projection: IDENTITY_MATRIX, position: [0.03, 0, 0] }
                }
            ]
        });

        renderer.render({ frame, renderViewId: 'left-eye', renderPass: { id: 'left' } });
        renderer.render({ renderViewId: 'right-eye', renderPass: { id: 'right' } });

        assert.strictEqual(renderer.host_frame, frame);
        assert.strictEqual(renderer.active_render_view_id, 'right-eye');
        assert.isTrue(scene.resizeMap.calledWith(800, 600));
        assert.isTrue(scene.view.setView.alwaysCalledWith({ lng: -74, lat: 40.7, zoom: 16 }));
        assert.closeTo(scene.setCameraMatrices.firstCall.args[0].position[0], -0.03, 1e-10);
        assert.closeTo(scene.setCameraMatrices.secondCall.args[0].position[0], 0.03, 1e-10);
        assert.isTrue(scene.updateScene.firstCall.calledWith({ renderPass: { id: 'left' } }));
        assert.isTrue(scene.updateScene.secondCall.calledWith({ renderPass: { id: 'right' } }));
    });

    it('renders each selected view when camera and viewport values are identical', function () {
        const renderer = Renderer.create({});
        const scene = renderer.scene;
        const dirty_states = [];
        sinon.stub(scene, 'updateScene').callsFake(() => {
            dirty_states.push(scene.dirty);
            scene.dirty = false;
            return dirty_states[dirty_states.length - 1];
        });

        const frame = new HostFrame({
            viewport: { width: 800, height: 600 },
            geographicAnchor: { longitude: -74, latitude: 40.7, zoom: 16 },
            renderViews: [
                {
                    id: 'left-eye',
                    viewport: { width: 800, height: 600 },
                    camera: { view: IDENTITY_MATRIX, projection: IDENTITY_MATRIX, position: [0, 0, 0] }
                },
                {
                    id: 'right-eye',
                    viewport: { width: 800, height: 600 },
                    camera: { view: IDENTITY_MATRIX, projection: IDENTITY_MATRIX, position: [0, 0, 0] }
                }
            ]
        });

        assert.isTrue(renderer.render({ frame, renderViewId: 'left-eye' }));
        assert.isTrue(renderer.render({ renderViewId: 'right-eye' }));
        assert.deepEqual(dirty_states, [true, true]);
    });

    it('requests another host frame while an active style is animated', function () {
        const request_redraw = sinon.spy();
        const renderer = Renderer.create({}, { requestRedraw: request_redraw });
        sinon.stub(renderer.scene, 'updateScene').returns(true);
        renderer.scene.config = { scene: {} };
        Object.defineProperty(renderer.scene, 'animated', {
            configurable: true,
            value: true
        });

        renderer.render();

        assert.isTrue(request_redraw.calledOnce);
    });

    it('owns the luma device backend and installs its scene resource factories', function () {
        const device = {
            type: 'webgpu',
            info: { shadingLanguage: 'wgsl' },
            limits: { maxTextureDimension2D: 4096 },
            createBuffer() {},
            createShader() {},
            createTexture() {},
            createRenderPipeline() {},
            createVertexArray() {}
        };
        Object.defineProperty(device, 'handle', {
            get() { throw new Error('portable scenes must not read device.handle'); }
        });
        const renderer = Renderer.create({}, { device });
        sinon.spy(renderer.device_renderer, 'destroy');

        assert.strictEqual(renderer.device_renderer.device, device);
        assert.strictEqual(renderer.scene.mesh_renderer, renderer.device_renderer);
        assert.isTrue(renderer.scene.enable_uniform_buffers);
        assert.isTrue(renderer.scene.device_shader_compilation);
        assert.strictEqual(renderer.scene.max_texture_size, 4096);
        assert.isFunction(renderer.scene.uniform_buffer_factory);
        assert.isFunction(renderer.scene.shader_factory);
        assert.isFunction(renderer.scene.shader_program_validator);
        assert.isFunction(renderer.scene.mesh_buffer_factory);
        assert.isFunction(renderer.scene.texture_factory);

        renderer.destroy();
        assert.isTrue(renderer.device_renderer.destroy.calledOnce);
    });

    it('initializes portable scene resources without constructing a WebGL context', async function () {
        const buffers = [];
        const device = {
            type: 'webgpu',
            info: { shadingLanguage: 'wgsl' },
            limits: { maxTextureDimension2D: 4096 },
            createBuffer(options) {
                const buffer = {
                    options,
                    write() {},
                    destroy() { this.destroyed = true; }
                };
                buffers.push(buffer);
                return buffer;
            },
            createShader() {},
            createTexture() {},
            createRenderPipeline() {},
            createVertexArray() {}
        };
        Object.defineProperty(device, 'handle', {
            get() { throw new Error('portable scenes must not read device.handle'); }
        });
        const canvas = document.createElement('canvas');
        const renderer = Renderer.create({}, { device, canvas });

        renderer.scene.createCanvas();
        renderer.scene.createCanvas();
        renderer.scene.initialized = true;
        renderer.scene.setRenderState({
            depth_test: true,
            depth_write: false,
            cull_face: false,
            blend: 'overlay'
        });

        assert.isTrue(renderer.scene.portable_rendering);
        assert.strictEqual(renderer.scene.canvas, canvas);
        assert.strictEqual(renderer.scene.resource_context, device);
        assert.isNull(renderer.scene.gl);
        assert.lengthOf(buffers, 3);
        assert.deepEqual(renderer.scene.mesh_render_state, {
            cullMode: 'none',
            depthCompare: 'less',
            depthWriteEnabled: false,
            blend: true,
            blendColorOperation: 'add',
            blendColorSrcFactor: 'src-alpha',
            blendColorDstFactor: 'one-minus-src-alpha',
            blendAlphaOperation: 'add',
            blendAlphaSrcFactor: 'one',
            blendAlphaDstFactor: 'one-minus-src-alpha'
        });

        renderer.scene.selection_feature_count = 1;
        assert.isUndefined(await renderer.scene.getFeatureAt([0, 0]));
        assert.isNull(renderer.scene.selection);

        renderer.destroy();
        assert.isTrue(buffers.every(buffer => buffer.destroyed));
    });
});
