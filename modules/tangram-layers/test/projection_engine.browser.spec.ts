// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import {createProjectionEngine} from '@math.gl/projection/core';
import createTangramLayerClass from '../src/tangram-layer';
import Renderer from '../../tangram-renderer/src/scene/renderer';
import WorkerBroker from '../../tangram-renderer/src/utils/worker_broker';

test('engine and execution policy identities are forwarded, retained and replaced or omitted explicitly', async () => {
    class BaseLayer {}
    const createRenderer = vi.fn((_scene: unknown, _options: Record<string, unknown>) =>
        ({scene: {}, subscribe: vi.fn(), load: vi.fn(async () => undefined), destroy: vi.fn()}));
    const Layer = createTangramLayerClass({Layer: BaseLayer, ClassicWebGLRenderer: {create: createRenderer}, Renderer: undefined});
    const layer = new Layer();
    const synchronize = vi.spyOn(layer, '_synchronizeTangramScene').mockImplementation(() => {});
    layer.raiseError = vi.fn();
    layer.state = {tangramRecord: null};
    layer.setState = (state: Record<string, unknown>) => {Object.assign(layer.state, state);};
    const device = {type: 'webgpu', createBuffer: vi.fn(), createShader: vi.fn(), createTexture: vi.fn(),
        createRenderPipeline: vi.fn(), createVertexArray: vi.fn()};
    layer.context = {device, deck: {getCanvas: () => document.createElement('canvas')}};
    const properties = {scene: 'scene.yaml', sceneBasePath: null, apiKey: null,
        onSceneLoad: vi.fn(), onSceneError: vi.fn()};
    try {
        const engine = createProjectionEngine();
        const cases = [
            {projectionEngine: engine, projectionEngineExecution: undefined},
            {projectionEngine: createProjectionEngine(), projectionEngineExecution: undefined},
            {projectionEngine: undefined, projectionEngineExecution: undefined},
            {projectionEngine: engine, projectionEngineExecution: {maxBatchPositions: 2}},
            {projectionEngine: engine, projectionEngineExecution: {maxBatchPositions: 8}},
            {projectionEngine: engine, projectionEngineExecution: undefined}
        ];
        for (const {projectionEngine, projectionEngineExecution} of cases) {
            layer.props = {...properties, projectionEngine, projectionEngineExecution};
            const previous = layer.state.tangramRecord;
            layer.updateState({props: layer.props});
            const record = layer.state.tangramRecord;
            await record.loadPromise;
            expect(createRenderer.mock.calls.at(-1)?.[1].projectionEngine).toBe(projectionEngine);
            expect(createRenderer.mock.calls.at(-1)?.[1].projectionEngineExecution).toBe(projectionEngineExecution);
            if (previous) expect(previous.renderer.destroy).toHaveBeenCalledOnce();
            layer.updateState({props: {...layer.props}});
            expect(layer.state.tangramRecord).toBe(record);
        }
        expect(createRenderer).toHaveBeenCalledTimes(cases.length);
        expect(layer.raiseError).not.toHaveBeenCalled();
    } finally {layer.finalizeState(); synchronize.mockRestore();}
});

test('host execution diagnostics are detached and invalid policies allocate no broker endpoints', async () => {
    const engine = createProjectionEngine();
    const existing = Object.keys(WorkerBroker.targets);
    expect(() => Renderer.create({}, {projectionEngine: engine, projectionEngineExecution: {maxBatchPositions: 0}}))
        .toThrow('maxBatchPositions');
    expect(Object.keys(WorkerBroker.targets)).toEqual(existing);
    const renderer = Renderer.create({}, {projectionEngine: engine, projectionEngineExecution: {maxBatchPositions: 2}});
    try {
        expect(renderer.getProjectionEngineStatistics()).toMatchObject({maxBatchPositions: 2, activeRequests: 0, batches: 0});
        const statistics = renderer.getProjectionEngineStatistics();
        if (!statistics) throw new Error('Missing injected host statistics');
        statistics.batches = 100;
        expect(renderer.getProjectionEngineStatistics()?.batches).toBe(0);
    } finally {renderer.destroy();}
    const workerLocalRenderer = Renderer.create({});
    try {expect(workerLocalRenderer.getProjectionEngineStatistics()).toBeUndefined();}
    finally {workerLocalRenderer.destroy();}
});

test('renderer isolates each engine broker endpoint and removes it on teardown', () => {
    const engine = createProjectionEngine();
    const existing = Object.keys(WorkerBroker.targets);
    const first = Renderer.create({}, {projectionEngine: engine});
    const second = Renderer.create({}, {projectionEngine: engine});
    const targets = Object.keys(WorkerBroker.targets).filter(key => !existing.includes(key) && key.startsWith('ProjectionEngine_'));
    let firstDisposed = false;
    let secondDisposed = false;
    try {
        expect(targets).toHaveLength(2);
        firstDisposed = true;
        first.destroy();
        expect(targets.filter(key => key in WorkerBroker.targets)).toHaveLength(1);
        secondDisposed = true;
        second.destroy();
        expect(targets.filter(key => key in WorkerBroker.targets)).toHaveLength(0);
        const stillUsable = engine.createProjection().projectSync([20, 30]);
        expect(stillUsable[0]).toBeCloseTo(20, 12);
        expect(stillUsable[1]).toBeCloseTo(30, 12);
    } finally {
        if (!firstDisposed) first.destroy();
        if (!secondDisposed) second.destroy();
    }
});
