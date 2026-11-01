// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import Scene from '../modules/tangram-renderer/src/scene/scene';
import {SceneWorkerThread} from '../modules/tangram-renderer/src/scene/scene-worker-thread';
import WorkerBroker from '../modules/tangram-renderer/src/utils/worker_broker';
import log from '../modules/tangram-renderer/src/utils/log';

test('packaged scene worker supports concurrent broker calls through a math.gl thread', async () => {
    const url = `${location.origin}/modules/tangram-renderer/dist/scene-worker.js`;
    const fixtureUrl = URL.createObjectURL(new Blob([`
        self.seedQueryFixture = () => {
            self.tiles.test = {loaded: true, source: 'fixture', style_z: 0,
                source_data: {layers: {places: {features: [{type: 'Feature', id: 8,
                    properties: {values: new Uint8Array([4, 5, 6])},
                    geometry: {type: 'Point', coordinates: [0, 0]}}]}}}};
        };
    `], {type: 'text/javascript'}));
    const thread = new SceneWorkerThread(url, 0);
    try {
        WorkerBroker.addWorker(thread.worker);
        await expect(thread.initialize(123, 0, 1, 'error', 1, true, [fixtureUrl], 3)).resolves.toBe(0);
        await expect(thread.updateDevicePixelRatio(2)).resolves.toBeUndefined();
        await expect(thread.clearFunctionCache()).resolves.toBeUndefined();
        await expect(thread.profile('task-test')).resolves.toBeUndefined();
        await expect(thread.profile('task-test', true)).resolves.toBeUndefined();
        const results = await Promise.all(Array.from({length: 10}, () =>
            WorkerBroker.postMessage(thread.worker, 'self.getTileSourceStatistics')
        ));
        for (const result of results) expect(result).toMatchObject({maxConcurrentLoads: 3});
        const taskResults = await Promise.all(Array.from({length: 10}, () => thread.getTileSourceStatistics()));
        for (const result of taskResults) expect(result).toMatchObject({maxConcurrentLoads: 3});
        await expect(thread.getSourceMetadata([], 0)).rejects.toThrow('configuration changed');
        await thread.updateConfiguration(false, {
            config: JSON.stringify({global: {}, layers: {}, sources: {}, styles: {}, textures: {}}),
            generation: 1,
            introspection: false
        }, {});
        await expect(thread.getSourceMetadata([], 1)).resolves.toEqual({});
        await expect(thread.updateConfiguration(true, {generation: 1, ribbonZoom: 4}, {})).resolves.toBeUndefined();
        await expect(thread.getFeatureSelection({id: 7, key: 1})).resolves.toEqual({id: 7, feature: undefined});
        await expect(thread.getFeatureSelectionMapSize()).resolves.toBe(0);
        await expect(thread.queryFeatures({tile_keys: [], geometry: true})).resolves.toEqual([]);
        await WorkerBroker.postMessage(thread.worker, 'self.seedQueryFixture');
        for (let attempt = 0; attempt < 2; attempt++) {
            const features = await thread.queryFeatures({tile_keys: ['test']});
            expect(features).toMatchObject([{id: 8, properties: {values: new Uint8Array([4, 5, 6])}}]);
        }
        await WorkerBroker.postMessage(thread.worker, 'self.FeatureSelection.makeColor',
            {id: 4, properties: {values: new Uint8Array([1, 2, 3])}},
            {key: 'tile', coords: {x: 0, y: 0, z: 0}, style_z: 0, source: 'test', generation: 1},
            {source: 'test', layer: 'places', layers: []});
        for (let attempt = 0; attempt < 2; attempt++) {
            const selection = await thread.getFeatureSelection({id: 7, key: 1});
            expect(selection.feature).toMatchObject({id: 4, properties: {values: new Uint8Array([1, 2, 3])}});
        }
        await expect(thread.getFeatureSelectionMapSize()).resolves.toBe(1);
        await expect(thread.resetFeatureSelection(null)).resolves.toBeUndefined();
        const messages: string[] = [];
        WorkerBroker.addTarget('_logProxy', async (_level: unknown, message: string) => {
            messages.push(message);
            return true;
        });
        const callbacks = await Promise.all(Array.from({length: 10}, (_, index) =>
            WorkerBroker.postMessage(thread.worker, '_logProxy', 'error', `callback-${index}`)
        ));
        expect(callbacks).toEqual(Array(10).fill(true));
        expect(messages.sort()).toEqual(Array.from({length: 10}, (_, index) => `callback-${index}`).sort());
    } finally {
        WorkerBroker.addTarget('_logProxy', log);
        thread.destroy();
        URL.revokeObjectURL(fixtureUrl);
    }
});

test('destroy rejects pending tasks and prevents new work', async () => {
    const url = URL.createObjectURL(new Blob(['self.onmessage = () => {};'], {type: 'text/javascript'}));
    const thread = new SceneWorkerThread(url, 1, true);
    try {
        const first = thread.getTileSourceStatistics();
        const second = thread.getFeatureSelectionMapSize();
        const checks = [expect(first).rejects.toThrow('destroyed'), expect(second).rejects.toThrow('destroyed')];
        thread.destroy();
        await Promise.all(checks);
        await expect(thread.getTileSourceStatistics()).rejects.toThrow('destroyed');
        thread.destroy();
    } finally {
        URL.revokeObjectURL(url);
    }
});

test('worker startup failure rejects pending and future tasks', async () => {
    class FailedWorker {
        onerror: ((error: ErrorEvent) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onmessageerror: (() => void) | null = null;
        constructor() {queueMicrotask(() => this.onerror?.(new ErrorEvent('error', {message: 'startup failed'})));}
        postMessage(): void {}
        terminate(): void {}
    }
    vi.stubGlobal('Worker', FailedWorker);
    const thread = new SceneWorkerThread(`${location.origin}/missing-scene-worker.js`, 1, true);
    try {
        await expect(thread.getTileSourceStatistics()).rejects.toThrow('Failed to load');
        await expect(thread.getFeatureSelectionMapSize()).rejects.toThrow('Failed to load');
    } finally {
        thread.destroy();
        vi.unstubAllGlobals();
    }
});

test('an explicitly hosted packaged worker can opt into tasks', async () => {
    const workerURL = `${location.origin}/modules/tangram-renderer/dist/scene-worker.js`;
    const scene = Object.assign(Scene.create({}, {workerURL, workerProtocol: 'tasks', numWorkers: 1}),
        {portable_rendering: true, external_scripts: []});
    try {
        await scene.makeWorkers();
        const statistics = await scene.getTileSourceStatistics();
        expect(statistics).toHaveLength(1);
        expect(statistics[0].workerId).toBe(0);
    } finally {
        scene.destroyWorkers();
    }
});
