// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, expect, test, vi} from 'vitest';
import {ProjectionBatchExecutor, normalizeProjectionExecutionOptions} from '../src/procedures/projection-batch-executor';
import type {ProjectionEngineTransform} from '../src/types';

afterEach(() => vi.useRealTimers());

/** A detached identity kernel exposes chunk boundaries without involving a projection catalog. */
function createTransform() {
    return {projectFlatSync: vi.fn((coordinates: Float64Array) => coordinates)};
}

/** Controllable compilation fixture, including factories that never settle until explicitly released. */
function deferred<T>() {
    let resolve: (value: T) => void = () => {throw new Error('Uninitialized deferred');};
    const promise = new Promise<T>(resolvePromise => {resolve = resolvePromise;});
    return {promise, resolve};
}

test.each([0, -1, 1.5, 65537, Infinity, NaN])('invalid batch capacity %s fails before execution', maxBatchPositions => {
    expect(() => new ProjectionBatchExecutor({maxBatchPositions})).toThrow('maxBatchPositions');
});

test('default and boundary capacities are captured independently of later option mutations', () => {
    expect(normalizeProjectionExecutionOptions()).toEqual({maxBatchPositions: 4096});
    for (const maxBatchPositions of [1, 65536]) {
        const options = {maxBatchPositions};
        const executor = new ProjectionBatchExecutor(options);
        options.maxBatchPositions = 2;
        const snapshot = executor.getStatistics();
        expect(snapshot.maxBatchPositions).toBe(maxBatchPositions);
        snapshot.maxBatchPositions = 10;
        expect(executor.getStatistics().maxBatchPositions).toBe(maxBatchPositions);
    }
});

test('captures and detaches input before compilation, retaining pair order and partial final chunks', async () => {
    const executor = new ProjectionBatchExecutor({maxBatchPositions: 2});
    const compilation = deferred<ProjectionEngineTransform>();
    const transform = createTransform();
    const input = new Float64Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const pending = executor.execute(input, () => compilation.promise, {scale: 2});
    input.fill(100);
    structuredClone(input.buffer, {transfer: [input.buffer]});
    compilation.resolve(transform);
    expect(await pending).toEqual(new Float64Array([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]));
    expect(transform.projectFlatSync.mock.calls.map(call => call[0].length)).toEqual([4, 4, 2]);
    expect(executor.getStatistics()).toEqual({maxBatchPositions: 2, activeRequests: 0, completedRequests: 1,
        failedRequests: 0, cancelledRequests: 0, submittedPositions: 5, batches: 3, yieldCount: 2});
});

test('yields to a host task between bounded synchronous calls, not only to microtasks', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    setTimeout(() => events.push('host event'), 0);
    const executor = new ProjectionBatchExecutor({maxBatchPositions: 1});
    const pending = executor.execute(new Float64Array([1, 2, 3, 4]), async () => ({
        projectFlatSync(coordinates) {events.push('kernel'); return coordinates;}
    }));
    await vi.runAllTimersAsync();
    await pending;
    expect(events).toEqual(['kernel', 'host event', 'kernel']);
});

test('one request aborts promptly during shared compilation while its neighbor remains usable', async () => {
    const executor = new ProjectionBatchExecutor();
    const compilation = deferred<ProjectionEngineTransform>();
    const transform = createTransform();
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const cancelled = expect(executor.execute(new Float64Array([1, 2]), () => compilation.promise,
        {signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
    const retained = executor.execute(new Float64Array([3, 4]), () => compilation.promise);
    controller.abort();
    await cancelled;
    expect(executor.getStatistics()).toMatchObject({activeRequests: 1, cancelledRequests: 1, batches: 0});
    expect(removeListener).toHaveBeenCalledOnce();
    compilation.resolve(transform);
    expect(await retained).toEqual(new Float64Array([3, 4]));
    expect(transform.projectFlatSync).toHaveBeenCalledOnce();
});

test('abort between chunks never publishes partial output or submits additional coordinates', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const transform = createTransform();
    transform.projectFlatSync.mockImplementationOnce(coordinates => {controller.abort(); return coordinates;});
    const executor = new ProjectionBatchExecutor({maxBatchPositions: 1});
    const rejected = expect(executor.execute(new Float64Array([1, 2, 3, 4]), async () => transform,
        {signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
    await rejected;
    await vi.runAllTimersAsync();
    expect(transform.projectFlatSync).toHaveBeenCalledOnce();
    expect(executor.getStatistics()).toMatchObject({activeRequests: 0, cancelledRequests: 1, completedRequests: 0});
});

test('dispose rejects stuck compilation immediately and prevents late kernel work', async () => {
    const compilation = deferred<ProjectionEngineTransform>();
    const transform = createTransform();
    const executor = new ProjectionBatchExecutor();
    const rejected = expect(executor.execute(new Float64Array([1, 2]), () => compilation.promise)).rejects.toThrow('disposed');
    executor.dispose(); executor.dispose();
    await rejected;
    compilation.resolve(transform);
    await Promise.resolve(); await Promise.resolve();
    expect(transform.projectFlatSync).not.toHaveBeenCalled();
    await expect(executor.execute(new Float64Array([1, 2]), async () => transform)).rejects.toThrow('disposed');
    expect(executor.getStatistics()).toMatchObject({activeRequests: 0, cancelledRequests: 1, batches: 0});
});

test('pre-aborted and malformed batches never compile or enter active work accounting', async () => {
    const executor = new ProjectionBatchExecutor();
    const controller = new AbortController(); controller.abort();
    const compile = vi.fn(async () => createTransform());
    await expect(executor.execute(new Float64Array([1, 2]), compile, {signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
    for (const coordinates of [[1], [NaN, 2], [1, Infinity]]) {
        await expect(executor.execute(new Float64Array(coordinates), compile)).rejects.toThrow('finite');
    }
    for (const options of [{scale: NaN}, {scale: Infinity}, {maxAbsoluteValue: 0}, {maxAbsoluteValue: Infinity}]) {
        await expect(executor.execute(new Float64Array([1, 2]), compile, options)).rejects.toThrow('finite');
    }
    expect(compile).not.toHaveBeenCalled();
    expect(executor.getStatistics()).toMatchObject({activeRequests: 0, completedRequests: 0, failedRequests: 0});
});

test('kernel/compilation errors do not poison independent requests or expose partial output', async () => {
    const executor = new ProjectionBatchExecutor();
    await expect(executor.execute(new Float64Array([1, 2]), async () => {throw new Error('missing grid');})).rejects.toThrow('missing grid');
    for (const value of [NaN, Infinity, 100]) {
        await expect(executor.execute(new Float64Array([1, 2]), async () => ({
            projectFlatSync(coordinates) {coordinates[0] = value; return coordinates;}
        }), {maxAbsoluteValue: 10})).rejects.toThrow('Float32');
    }
    expect(await executor.execute(new Float64Array(), async () => createTransform())).toEqual(new Float64Array());
    expect(executor.getStatistics()).toMatchObject({failedRequests: 4, completedRequests: 1, activeRequests: 0});
    const inverse = await executor.execute(new Float64Array([1, 2]), async () => ({
        projectFlatSync(coordinates) {coordinates.fill(NaN); return coordinates;}
    }), {allowNonfinite: true});
    expect(inverse.every(Number.isNaN)).toBe(true);
});
