// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, describe, expect, test, vi} from 'vitest';
import Scene from '../src/scene/classic_scene';
import Context from '../src/gl/context';
import Texture from '../src/gl/texture';
import ShaderProgram from '../src/gl/shader_program';
import Task from '../src/utils/task';
import WorkerBroker from '../src/utils/worker_broker';
import Light from '../src/lights/light';
import DataSource from '../src/sources/data_source';
import StyleParser from '../src/styles/style_parser';

function createScene() {
    const scene = Object.create(Scene.prototype);
    scene.initialized = true;
    scene.updating = 0;
    scene.dirty = false;
    scene.frame = 3;
    scene.generation = 2;
    scene.last_complete_generation = 2;
    scene.last_main_render = 2;
    scene.last_selection_render = 1;
    scene.last_render_count = 0;
    scene.render_count = 0;
    scene.sources = {osm: {name: 'osm'}};
    scene.config = {scene: {}};
    scene.styles = {};
    scene.lights = {};
    scene.uniform_buffers = {};
    scene.portable_rendering = false;
    scene.owns_gl = false;
    scene.render_loop = false;
    scene.render_loop_active = false;
    scene.render_loop_stop = false;
    scene.trigger = vi.fn();
    scene.requestRedraw = vi.fn();
    scene.updateViewComplete = vi.fn();
    scene.updateDevicePixelRatio = vi.fn();
    scene.getFeatureSelectionMapSize = vi.fn().mockResolvedValue(0);
    scene.view = {
        isAnimating: vi.fn(() => false),
        panning: false,
        ready: vi.fn(() => true),
        setViewportSize: vi.fn(),
        setupProgram: vi.fn(),
        setupTile: vi.fn(),
        size: {css: {height: 200, width: 400}},
        tile_zoom: 10,
        update: vi.fn(),
        user_input_active: false
    };
    scene.tile_manager = {
        allVisibleTilesLabeled: vi.fn(() => true),
        getRenderableTiles: vi.fn(() => []),
        isLoadingVisibleTiles: vi.fn(() => false),
        removeTiles: vi.fn(),
        updateLabels: vi.fn()
    };
    scene.media_capture = {
        completeScreenshot: vi.fn(),
        screenshot: vi.fn(() => Promise.resolve('image')),
        startVideoCapture: vi.fn(() => 'recording'),
        stopVideoCapture: vi.fn(() => 'video')
    };
    scene.style_manager = {
        getActiveBlendOrders: vi.fn(() => []),
        getActiveStyles: vi.fn(() => [])
    };
    return scene;
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('Scene host lifecycle', () => {
    test('rejects a failed rebuild after draining and starts the queued correction', async () => {
        const scene = createScene();
        const resolve = vi.fn();
        const reject = vi.fn();
        const queuedResolve = vi.fn();
        const queuedReject = vi.fn();
        scene.building = {resolve, reject, queued: {options: {preserveTileCache: true},
            resolve: queuedResolve, reject: queuedReject}};
        scene.logFirstBuild = vi.fn();
        vi.spyOn(scene, 'rebuild').mockResolvedValue(true);
        scene.tileManagerBuildError('vertex budget exceeded');
        scene.tileManagerBuildError('later failure');
        expect(reject).not.toHaveBeenCalled();
        scene.tileManagerBuildDone();
        await Promise.resolve();
        expect(reject).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({message: 'vertex budget exceeded'}));
        expect(resolve).not.toHaveBeenCalled();
        expect(scene.building).toBeNull();
        expect(scene.rebuild).toHaveBeenCalledExactlyOnceWith({preserveTileCache: true});
        expect(queuedResolve).toHaveBeenCalledWith(true);
        expect(queuedReject).not.toHaveBeenCalled();
        scene.tileManagerBuildError('background failure');
        expect(scene.building).toBeNull();
    });

    test('checks readiness and updates external script inventory', () => {
        const scene = createScene();
        expect(scene.ready()).toBe(true);
        scene.view.ready.mockReturnValue(false);
        expect(scene.ready()).toBe(false);
        scene.view.ready.mockReturnValue(true);
        scene.sources = {};
        expect(scene.ready()).toBe(false);

        scene.config = {
            scene: {scripts: {first: 'a.js', duplicate: 'a.js'}},
            sources: {osm: {scripts: ['b.js', 'a.js']}}
        };
        expect(scene.updateExternalScripts()).toBe(true);
        expect(scene.external_scripts).toEqual(['a.js', 'b.js']);
        expect(scene.updateExternalScripts()).toBe(false);
    });

    test('creates, reuses, and resets worker collections', async () => {
        const scene = createScene();
        scene.config = {scene: {}, sources: {}};
        scene.makeWorkers = vi.fn().mockResolvedValue('workers');
        scene.destroyWorkers = vi.fn();
        await expect(scene.createWorkers()).resolves.toBe('workers');
        expect(scene.makeWorkers).toHaveBeenCalled();

        scene.workers = [{terminate: vi.fn()}];
        scene.external_scripts = [];
        await scene.createWorkers();
        expect(scene.makeWorkers).toHaveBeenCalledTimes(1);

        const workers = scene.workers;
        Scene.prototype.destroyWorkers.call(scene);
        expect(workers[0].terminate).toHaveBeenCalled();
        expect(scene.workers).toBeNull();
        expect(scene.selection).toBeNull();
    });

    test('coordinates context scope, resizing, and host redraw callbacks', () => {
        const scene = createScene();
        scene.webgl_context_scope = vi.fn(callback => callback());
        expect(scene.withWebGLContext(() => 7)).toBe(7);
        expect(scene.webgl_context_scope).toHaveBeenCalled();

        scene.webgl_context_scope = null;
        expect(scene.withWebGLContext(() => 8)).toBe(8);
        scene.gl = {};
        scene.owns_gl = true;
        vi.spyOn(Context, 'resize').mockImplementation(() => {});
        scene.resizeMap(320, 180);
        expect(scene.view.setViewportSize).toHaveBeenCalledWith(320, 180);
        expect(Context.resize).toHaveBeenCalled();
        scene.view.setViewportSize.mockClear();
        scene.resizeMap(0, 0);
        expect(scene.view.setViewportSize).not.toHaveBeenCalled();

        scene.redraw_callback = vi.fn();
        Scene.prototype.requestRedraw.call(scene);
        expect(scene.redraw_callback).toHaveBeenCalled();
        scene.update = vi.fn();
        scene.immediateRedraw();
        expect(scene.update).toHaveBeenCalled();
    });

    test('invalidates externally owned WebGL state and processes host-frame tasks', () => {
        const scene = createScene();
        scene.render_states = {invalidate: vi.fn()};
        vi.spyOn(ShaderProgram, 'resetCurrent').mockImplementation(() => {});
        vi.spyOn(Texture, 'resetBindings').mockImplementation(() => {});
        scene.resetWebGLState();
        expect(scene.render_states.invalidate).toHaveBeenCalled();

        vi.spyOn(Task, 'setState').mockImplementation(() => {});
        vi.spyOn(Task, 'processAll').mockImplementation(() => {});
        scene.view.user_input_active = true;
        scene.processTasks();
        expect(Task.setState).toHaveBeenCalledWith({user_moving_view: true});
        expect(Task.processAll).toHaveBeenCalled();
    });

    test('updates only when rendering is ready and preserves animation redraws', () => {
        const scene = createScene();
        scene.dirty = false;
        expect(scene.updateScene()).toBe(false);
        expect(scene.trigger).toHaveBeenCalledWith('pre_update', false);

        scene.dirty = true;
        scene.render = vi.fn();
        Object.defineProperty(scene, 'animated', {configurable: true, value: true});
        expect(scene.updateScene({renderPass: 'pass'})).toBe(true);
        expect(scene.render).toHaveBeenCalledWith({main: true, selection: false, renderPass: 'pass'});
        expect(scene.media_capture.completeScreenshot).toHaveBeenCalled();
        expect(scene.dirty).toBe(true);
        expect(scene.frame).toBe(4);
    });
});

describe('Scene render orchestration', () => {
    function createRenderStates() {
        return {
            blending: {set: vi.fn()},
            culling: {set: vi.fn()},
            defaults: {
                blending: false,
                culling: true,
                culling_face: 1029,
                depth_test: true,
                depth_write: true
            },
            depth_test: {set: vi.fn()},
            depth_write: {set: vi.fn()}
        };
    }

    test.each(['opaque', 'overlay', 'inlay', 'translucent', 'add', 'multiply', false])(
        'maps %s blending to WebGL and portable render states',
        blend => {
            const scene = createScene();
            scene.render_states = createRenderStates();
            scene.gl = {ONE: 1, ONE_MINUS_SRC_ALPHA: 771, SRC_ALPHA: 770, SRC_COLOR: 768, ZERO: 0};
            scene.setRenderState({blend});
            expect(scene.render_states.blending.set).toHaveBeenCalled();
            expect(scene.mesh_render_state).toBeNull();

            scene.portable_rendering = true;
            scene.mesh_renderer = {
                getRenderPipelineParameters: vi.fn(() => ({
                    cullMode: 'none',
                    depthCompare: 'always',
                    depthWriteEnabled: false,
                    blend: Boolean(blend && blend !== 'opaque')
                }))
            };
            scene.setRenderState({blend, cull_face: false, depth_test: false, depth_write: false});
            expect(scene.mesh_render_state).toMatchObject({
                cullMode: 'none',
                depthCompare: 'always',
                depthWriteEnabled: false
            });
            expect(scene.mesh_renderer.getRenderPipelineParameters).toHaveBeenCalledWith({
                depthTest: false,
                depthWrite: false,
                cullFace: false,
                blend
            });
        }
    );

    test('sets up styles with direct and uniform-buffer bindings', () => {
        const scene = createScene();
        const program = {
            bindUniformBlocks: vi.fn(),
            uniform: vi.fn(),
            use: vi.fn()
        };
        const style = {getProgram: vi.fn(() => program), name: 'roads', setup: vi.fn()};
        scene.lights = {sun: {setupProgram: vi.fn()}};
        expect(scene.setupStyle(style, 'program')).toBe(program);
        expect(program.uniform).toHaveBeenCalledWith('1f', 'u_time', 0);
        expect(scene.view.setupProgram).toHaveBeenCalledWith(program);

        scene.uniform_buffers.TangramView = {setUniform: vi.fn()};
        expect(scene.setupStyle(style, 'program')).toBe(program);
        expect(scene.uniform_buffers.TangramView.setUniform).toHaveBeenCalledWith('u_time', 0);
        expect(program.bindUniformBlocks).toHaveBeenCalled();

        style.getProgram.mockReturnValue(null);
        expect(scene.setupStyle(style, 'selection_program')).toBeUndefined();
        style.getProgram.mockImplementation(() => { throw new Error('shader'); });
        expect(scene.setupStyle(style, 'program')).toBeUndefined();
        expect(scene.trigger).toHaveBeenCalledWith('warning', expect.objectContaining({type: 'styles'}));
    });

    test('renders mesh variants in order and skips invalid proxy tiles', () => {
        const scene = createScene();
        scene.view.projection = {type: 'globe'};
        const render = vi.fn(() => true);
        const style = {name: 'roads', render};
        const mesh = order => ({geometry_count: order + 2, variant: {blend_order: 1, mesh_order: order}});
        const visible = {
            meshes: {roads: [mesh(1), mesh(0)]},
            shouldProxyForStyle: vi.fn(() => true)
        };
        const skipped = {
            meshes: {roads: [mesh(0)]},
            shouldProxyForStyle: vi.fn(() => false)
        };
        scene.tile_manager.getRenderableTiles.mockReturnValue([visible, skipped]);
        scene.styles.roads = style;
        scene.setupStyle = vi.fn(() => ({id: 'program'}));
        scene.requestRedraw = vi.fn();
        expect(scene.renderStyle('roads', 'program', 1)).toBe(5);
        expect(scene.view.setupTile).toHaveBeenCalledTimes(2);
        expect(render).toHaveBeenCalledTimes(2);
        expect(render.mock.calls[0][1].projection).toBe('globe');
        expect(scene.requestRedraw).toHaveBeenCalledTimes(2);
    });

    test('renders portable blend-order groups without raw WebGL state', () => {
        const scene = createScene();
        scene.portable_rendering = true;
        scene.styles = {
            roads: {blend: 'opaque', name: 'roads'},
            labels: {blend: 'overlay', name: 'labels'}
        };
        scene.style_manager.getActiveBlendOrders.mockReturnValue([
            {blend_order: 0, styles: ['missing', 'roads', 'labels']}
        ]);
        scene.setRenderState = vi.fn();
        scene.renderStyle = vi.fn(() => 4);
        expect(scene.renderPortablePass('program', {allow_blend: true, renderPass: 'host'})).toBe(8);
        expect(scene.setRenderState).toHaveBeenCalledTimes(2);
        expect(scene.renderStyle).toHaveBeenCalledWith('labels', 'program', 0, null, 'host');
    });

    test('clears only initialized WebGL frames', () => {
        const scene = createScene();
        scene.gl = {clear: vi.fn(), COLOR_BUFFER_BIT: 1, DEPTH_BUFFER_BIT: 2, STENCIL_BUFFER_BIT: 4};
        scene.render_states = {depth_write: {set: vi.fn()}};
        scene.clearFrame();
        expect(scene.gl.clear).toHaveBeenCalledWith(7);
        scene.portable_rendering = true;
        scene.gl.clear.mockClear();
        scene.clearFrame();
        expect(scene.gl.clear).not.toHaveBeenCalled();
    });
});

describe('Scene public helpers', () => {
    test('normalizes feature selection coordinates and errors', async () => {
        const scene = createScene();
        scene.selection_feature_count = 2;
        scene.selection = {getFeatureAt: vi.fn().mockResolvedValue({feature: 1})};
        await expect(scene.getFeatureAt({x: 200, y: 100}, {radius: 10})).resolves.toEqual({
            feature: 1,
            pixel: {x: 200, y: 100}
        });
        expect(scene.selection.getFeatureAt).toHaveBeenCalledWith(
            {x: 0.5, y: 0.5},
            {radius: {x: 0.025, y: 0.05}}
        );
        scene.selection.getFeatureAt.mockRejectedValue(new Error('pick'));
        await expect(scene.getFeatureAt({x: 1, y: 1}, {})).resolves.toEqual({error: expect.any(Error)});
        scene.portable_rendering = true;
        await expect(scene.getFeatureAt({x: 1, y: 1}, {})).resolves.toBeUndefined();
    });

    test('queries, deduplicates, and groups worker features', async () => {
        const scene = createScene();
        scene.workers = [{}];
        scene.tile_manager.getRenderableTiles.mockReturnValue([{key: '1/2/3'}]);
        vi.spyOn(WorkerBroker, 'postMessage').mockResolvedValue([
            [
                {id: 1, properties: {kind: 'road', name: 'A'}},
                {id: 1, properties: {kind: 'road', name: 'A'}}
            ],
            [{id: 2, properties: {kind: 'water', name: 'B'}}]
        ]);
        await expect(scene.queryFeatures({group_by: 'kind'})).resolves.toMatchObject({
            road: [expect.objectContaining({id: 1})],
            water: [expect.objectContaining({id: 2})]
        });
        await expect(scene.queryFeatures({unique: false})).resolves.toHaveLength(3);
        scene.initialized = false;
        await expect(scene.queryFeatures()).resolves.toEqual([]);
    });

    test('creates and removes data sources and marks geometry producers', () => {
        const scene = createScene();
        scene.sources = {removed: {name: 'removed'}};
        scene.config = {
            layers: {roads: {data: {source: 'osm'}}},
            sources: {osm: {type: 'MVT', url: 'tiles/{z}/{x}/{y}.mvt'}}
        };
        scene.tile_manager.removeTiles = vi.fn();
        vi.spyOn(DataSource, 'create').mockImplementation(config => ({...config}));
        vi.spyOn(DataSource, 'tileLayoutChanged').mockReturnValue(true);
        scene.createDataSources();
        expect(scene.sources.osm.builds_geometry_tiles).toBe(true);
        expect(scene.sources.removed).toBeUndefined();
        expect(scene.tile_manager.removeTiles).toHaveBeenCalled();
    });

    test('creates visible lights and updates opaque and transparent backgrounds', () => {
        const scene = createScene();
        scene.config = {
            lights: {
                hidden: {type: 'ambient', visible: false},
                'main-light': {type: 'ambient'}
            },
            scene: {background: {color: '#ff0000'}}
        };
        vi.spyOn(Light, 'create').mockImplementation((view, light) => ({...light, update: vi.fn()}));
        vi.spyOn(Light, 'inject').mockImplementation(() => {});
        scene.createLights();
        expect(scene.lights.main_light).toBeDefined();
        expect(scene.lights.hidden).toBeUndefined();
        scene.setBackground();

        scene.owns_gl = true;
        scene.canvas = {style: {}};
        scene.gl = {clearColor: vi.fn()};
        vi.spyOn(StyleParser, 'evalCachedColorProperty').mockReturnValue([1, 0, 0, 1]);
        scene.updateBackground();
        expect(scene.canvas.style.backgroundColor).toContain('rgba');
        expect(scene.gl.clearColor).toHaveBeenCalledWith(1, 0, 0, 1);
        StyleParser.evalCachedColorProperty.mockReturnValue([0, 0, 0, 0]);
        scene.updateBackground();
        expect(scene.canvas.style.backgroundColor).toBe('transparent');
    });

    test('deduplicates selection-map requests and drives capture helpers', async () => {
        const scene = createScene();
        scene.workers = [{}];
        vi.spyOn(WorkerBroker, 'postMessage').mockResolvedValue([2, 3]);
        const first = Scene.prototype.getFeatureSelectionMapSize.call(scene);
        const second = Scene.prototype.getFeatureSelectionMapSize.call(scene);
        await expect(Promise.all([first, second])).resolves.toEqual([5, 5]);
        expect(WorkerBroker.postMessage).toHaveBeenCalledTimes(1);
        expect(scene.fetching_selection_map).toBeNull();

        await expect(scene.screenshot({background: 'black'})).resolves.toBe('image');
        expect(scene.media_capture.screenshot).toHaveBeenCalledWith({background: 'black'});
        expect(scene.startVideoCapture()).toBe('recording');
        expect(scene.stopVideoCapture()).toBe('video');
    });

    test('emits view completion once tiles are ready', () => {
        const scene = createScene();
        scene.render_count_changed = true;
        scene.view_complete = false;
        Scene.prototype.updateViewComplete.call(scene);
        expect(scene.tile_manager.updateLabels).toHaveBeenCalled();
        expect(scene.trigger).toHaveBeenCalledWith('view_complete', {first: true});
        expect(scene.view_complete).toBe(true);
        Scene.prototype.resetViewComplete.call(scene);
        expect(scene.last_complete_generation).toBeNull();
    });
});
