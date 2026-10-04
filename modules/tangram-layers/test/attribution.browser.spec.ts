// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import createTangramLayerClass from '../src/tangram-layer';
import Scene from '../../tangram-renderer/src/scene/scene';
import type {SceneListeners} from '../../tangram-renderer/src/types';

/** Flush the adapter's source-recreation and metadata completion microtasks. */
async function flushCredits() {
    for (let index = 0; index < 6; index++) await Promise.resolve();
}

test('the newest metadata result goes to the current layer owner; disposed results are ignored', async () => {
    class BaseLayer {}
    const Layer = createTangramLayerClass({Layer: BaseLayer, ClassicWebGLRenderer: {}, Renderer: undefined});
    const layer = new Layer();
    const onAttributionChange = vi.fn();
    const owner = new Layer();
    owner.props = {onAttributionChange};
    const scene = {};
    let finishOld: (credits: string[]) => void = () => {};
    const old = new Promise<string[]>(resolve => {finishOld = resolve;});
    const getAttributions = vi.fn().mockReturnValueOnce(old).mockResolvedValueOnce(['© New provider']);
    const record = {owner: layer, renderer: {getAttributions}, scene, disposed: false};
    layer._updateAttributions(record);
    await flushCredits();
    layer._updateAttributions(record);
    record.owner = owner;
    await flushCredits();
    expect(onAttributionChange).toHaveBeenCalledExactlyOnceWith(['© New provider'], scene);
    finishOld(['© Old provider']);
    await flushCredits();
    expect(onAttributionChange).toHaveBeenCalledTimes(1);
    layer._updateAttributions(record);
    record.disposed = true;
    await flushCredits();
    expect(getAttributions).toHaveBeenCalledTimes(2);
});

test('credit failures report a nonfatal scene error instead of silently hiding provider requirements', async () => {
    class BaseLayer {}
    const Layer = createTangramLayerClass({Layer: BaseLayer, ClassicWebGLRenderer: {}, Renderer: undefined});
    const layer = new Layer();
    layer.props = {onSceneError: vi.fn()};
    layer.raiseError = vi.fn();
    const record = {owner: layer, renderer: {getAttributions: vi.fn().mockRejectedValue(new Error('Metadata failure'))},
        scene: {}, disposed: false, loadFailed: false};
    layer._updateAttributions(record);
    await flushCredits();
    expect(layer.props.onSceneError).toHaveBeenCalledTimes(1);
    expect(record.loadFailed).toBe(false);
});

test('an existing source replacement reaches the layer attribution callback through scene updates', async () => {
    const source = {type: 'MVT', url: 'https://old.example/{z}/{x}/{y}.pbf', attribution: '© Old provider'};
    const scene = Scene.create({});
    Object.assign(scene, {config: {sources: {basemap: source}, layers: {}}});
    scene.createDataSources();
    const rebuild = vi.spyOn(scene, 'rebuild').mockResolvedValue(undefined);
    try {
        const renderer = {
            scene,
            subscribe: (listeners: SceneListeners) => scene.subscribe(listeners),
            load: () => Promise.resolve(),
            getAttributions: () => scene.getAttributions()
        };
        class BaseLayer {}
        const Layer = createTangramLayerClass({Layer: BaseLayer, ClassicWebGLRenderer: {create: () => renderer}, Renderer: undefined});
        const layer = new Layer();
        const onAttributionChange = vi.fn();
        layer.props = {...Layer.defaultProps, scene: {sources: {basemap: source}}, onAttributionChange};
        layer.context = {deck: {getCanvas: () => document.createElement('canvas')}, device: {
            type: 'webgpu', createBuffer: vi.fn(), createShader: vi.fn(), createTexture: vi.fn(),
            createRenderPipeline: vi.fn(), createVertexArray: vi.fn()
        }};
        const synchronize = vi.spyOn(layer, '_synchronizeTangramScene').mockImplementation(() => {});
        try {
            const record = layer._createTangramRecord(layer.props);
            if (!record) throw new Error('Expected a valid attribution layer record');
            await record.loadPromise;
            await vi.waitFor(() => expect(onAttributionChange).toHaveBeenLastCalledWith(['© Old provider'], scene));

            await scene.setDataSource('basemap', {...source, url: 'https://new.example/{z}/{x}/{y}.pbf', attribution: '© New provider'});
            await vi.waitFor(() => {
                expect(onAttributionChange).toHaveBeenCalledTimes(2);
                expect(onAttributionChange).toHaveBeenLastCalledWith(['© New provider'], scene);
            });
        } finally {
            synchronize.mockRestore();
        }
    } finally {
        rebuild.mockRestore();
    }
});
