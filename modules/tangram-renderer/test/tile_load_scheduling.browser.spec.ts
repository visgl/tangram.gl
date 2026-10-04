// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, expect, test, vi} from 'vitest';
import Scene from '../src/scene/scene';
import Renderer from '../src/scene/renderer';
import WorkerBroker from '../src/utils/worker_broker';
import DecodedTileStore from '../src/sources/decoded_tile_store';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])('invalid load capacity %s is rejected during scene and renderer creation', capacity => {
    expect(() => Scene.create({}, {maxConcurrentTileLoadsPerWorker: capacity})).toThrow('positive safe integer');
    expect(() => Renderer.create({}, {maxConcurrentTileLoadsPerWorker: capacity})).toThrow('positive safe integer');
});

test('worker initialization receives a fixed source budget independently of mesh-build limits', async () => {
    const instances: FakeWorker[] = [];
    class FakeWorker extends EventTarget {
        /** Worker transport is intercepted to inspect its initialization options. */
        readonly postMessage = vi.fn();
        /** Scene teardown retains ownership of its worker instances. */
        readonly terminate = vi.fn();
        /** Record allocation without starting an actual worker for this protocol test. */
        constructor(_url: string) { super(); instances.push(this); }
    }
    vi.stubGlobal('Worker', FakeWorker);
    const originalAddWorker = Reflect.get(WorkerBroker, 'addWorker');
    Reflect.set(WorkerBroker, 'addWorker', vi.fn());
    const original = Reflect.get(WorkerBroker, 'postMessage');
    const message = vi.fn(async (..._parameters: unknown[]) => 0);
    Reflect.set(WorkerBroker, 'postMessage', message);
    const scene = Object.assign(Scene.create({}, {numWorkers: 2, maxConcurrentTileLoadsPerWorker: 3}),
        {portable_rendering: true, external_scripts: []});
    try {
        await scene.makeWorkers();
        expect(instances).toHaveLength(2);
        expect(message).toHaveBeenCalledTimes(2);
        for (let index = 0; index < instances.length; index++) {
            expect(message.mock.calls[index].slice(0, 2)).toEqual([instances[index], 'self.init']);
            expect(message.mock.calls[index].at(-1)).toBe(3);
        }
    } finally {
        scene.destroyWorkers();
        Reflect.set(WorkerBroker, 'postMessage', original);
        Reflect.set(WorkerBroker, 'addWorker', originalAddWorker);
    }
    expect(instances.every(worker => worker.terminate.mock.calls.length === 1)).toBe(true);
});

test('per-worker snapshots stay detached and do not aggregate source slots with mesh builds', async () => {
    const workers = [{}, {}], scene = Object.assign(Scene.create({}), {workers});
    const sourceStatistics = new DecodedTileStore(undefined, {maxConcurrentLoads: 2}).getStatistics();
    const original = Reflect.get(WorkerBroker, 'postMessage');
    const message = vi.fn(async () => [
        {...sourceStatistics, sharingEnabled: true, activeAcquisitions: 1},
        {...sourceStatistics, sharingEnabled: false}
    ]);
    Reflect.set(WorkerBroker, 'postMessage', message);
    try {
        const statistics = await scene.getTileSourceStatistics();
        expect(message).toHaveBeenCalledWith(workers, 'self.getTileSourceStatistics');
        expect(statistics).toMatchObject([
            {workerId: 0, activeAcquisitions: 1, maxConcurrentLoads: 2, sharingEnabled: true},
            {workerId: 1, activeAcquisitions: 0, sharingEnabled: false}
        ]);
        statistics[0].queuedTiles = 12;
        expect((await scene.getTileSourceStatistics())[0].queuedTiles).toBe(0);
        expect(statistics[0]).not.toHaveProperty('activeBuilds');
    } finally { Reflect.set(WorkerBroker, 'postMessage', original); }
});

test('statistics reject worker-pool replacement and transport failures instead of returning partial counts', async () => {
    const scene = Object.assign(Scene.create({}), {workers: [{}]});
    const original = Reflect.get(WorkerBroker, 'postMessage');
    const message = vi.fn(async () => { scene.workers = [{}]; return []; });
    Reflect.set(WorkerBroker, 'postMessage', message);
    try {
        await expect(scene.getTileSourceStatistics()).rejects.toThrow('Workers changed');
        message.mockRejectedValueOnce(new Error('worker unavailable'));
        await expect(scene.getTileSourceStatistics()).rejects.toThrow('worker unavailable');
        scene.workers = [];
        expect(await scene.getTileSourceStatistics()).toEqual([]);
        expect(message).toHaveBeenCalledTimes(2);
    } finally { Reflect.set(WorkerBroker, 'postMessage', original); }
});

test('host renderer forwards source diagnostics without changing mesh-resource accounting', async () => {
    const renderer = Renderer.create({}, {maxConcurrentTileLoadsPerWorker: 2});
    const statistics = [{...new DecodedTileStore(undefined, {maxConcurrentLoads: 2}).getStatistics(),
        workerId: 0, sharingEnabled: true}];
    vi.spyOn(renderer.scene, 'getTileSourceStatistics').mockResolvedValue(statistics);
    expect(await renderer.getTileSourceStatistics()).toEqual(statistics);
    expect(renderer.getTileResourceStatistics()).not.toHaveProperty('activeAcquisitions');
});
