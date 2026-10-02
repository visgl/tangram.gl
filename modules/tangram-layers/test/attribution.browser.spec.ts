// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import createTangramLayerClass from '../src/tangram-layer';

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
