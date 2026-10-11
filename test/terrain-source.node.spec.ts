// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, expect, test, vi} from 'vitest';
import {createTerrainImageSource, createMapterhornTerrainSource} from '../examples/terrain/terrain-source';

const options = {id: 'offline-v1', urlTemplate: 'https://fixture.test/{z}/{x}/{y}.png', credits: [{label: 'Fixture <b>text</b>', url: 'https://fixture.test/license'}]};
const tile = {zoom: 2, column: 1, row: 2};
afterEach(() => vi.useRealTimers());

test('source snapshots metadata, uses canonical addresses and isolates acquisitions', async () => {
    const credits = options.credits.map(credit => ({...credit}));
    const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    const source = createTerrainImageSource({...options, credits, minZoom: 2, maxZoom: 3, noData: 'alpha-zero', fetch});
    credits[0].label = 'Changed';
    expect(source.credits[0].label).toBe('Fixture <b>text</b>'); expect(Object.isFrozen(source)).toBe(true);
    const first = await source.fetchTile(tile, new AbortController().signal);
    const second = await source.fetchTile(tile, new AbortController().signal);
    expect(first).not.toBe(second); expect(new Uint8Array(first)).toEqual(new Uint8Array([1, 2, 3]));
    expect(fetch).toHaveBeenCalledWith('https://fixture.test/2/1/2.png', {signal: expect.any(AbortSignal)});
    expect(source.noData).toBe('alpha-zero');
    for (const changed of [{...tile, zoom: 1}, {...tile, zoom: 4}, {...tile, column: -1}, {...tile, row: 4}]) await expect(source.fetchTile(changed, new AbortController().signal)).rejects.toThrow(/domain/);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(createMapterhornTerrainSource().credits).toHaveLength(3);
});

test('streamed and declared body limits reject before retaining oversized payloads', async () => {
    const cancel = vi.fn();
    const source = createTerrainImageSource({...options, maxBytes: 3, fetch: async () => new Response(new ReadableStream({start(controller) {controller.enqueue(new Uint8Array([1, 2])); controller.enqueue(new Uint8Array([3, 4]));}, cancel}))});
    await expect(source.fetchTile(tile, new AbortController().signal)).rejects.toThrow(/byte limit/);
    expect(cancel).toHaveBeenCalledOnce();
    const declared = createTerrainImageSource({...options, maxBytes: 3, fetch: async () => new Response(new Uint8Array([1]), {headers: {'content-length': '1000'}})});
    await expect(declared.fetchTile(tile, new AbortController().signal)).rejects.toThrow(/byte limit/);
    for (const response of [new Response(null, {status: 404}), new Response(new Uint8Array()), new Response(null)]) {
        const failing = createTerrainImageSource({...options, fetch: async () => response});
        await expect(failing.fetchTile(tile, new AbortController().signal)).rejects.toThrow();
    }
});

test('abort and deadline cancel the real body read; cancelled calls never begin acquisition', async () => {
    vi.useFakeTimers();
    const cancels = vi.fn();
    const fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({cancel: cancels})));
    const source = createTerrainImageSource({...options, fetch, timeoutMilliseconds: 100});
    const controller = new AbortController();
    const cancelled = source.fetchTile(tile, controller.signal);
    const assertion = expect(cancelled).rejects.toThrow();
    await Promise.resolve(); controller.abort(); await assertion;
    expect(cancels).toHaveBeenCalled();
    const timedOut = source.fetchTile(tile, new AbortController().signal);
    const timeoutAssertion = expect(timedOut).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(100); await timeoutAssertion;
    expect(vi.getTimerCount()).toBe(0);
    const previousCalls = fetch.mock.calls.length;
    await expect(source.fetchTile(tile, controller.signal)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(previousCalls);
});

test('nonsettling underlying cancellation cannot hold a failed acquisition or timeout open', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const oversized = createTerrainImageSource({...options, maxBytes: 1, fetch: async () => new Response(new ReadableStream({start(controller) {controller.enqueue(new Uint8Array([1, 2]));}, cancel}))});
    await expect(oversized.fetchTile(tile, new AbortController().signal)).rejects.toThrow(/byte limit/);
    expect(cancel).toHaveBeenCalledOnce();
    const stalled = createTerrainImageSource({...options, timeoutMilliseconds: 100, fetch: async () => new Response(new ReadableStream<Uint8Array>({cancel}))});
    const result = stalled.fetchTile(tile, new AbortController().signal);
    const assertion = expect(result).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(100); await assertion;
    expect(vi.getTimerCount()).toBe(0);
});

test.each([
    {id: ''}, {urlTemplate: 'file:///{z}/{x}/{y}'}, {urlTemplate: 'https://fixture.test/{z}/{x}/{x}'},
    {urlTemplate: 'https://user:password@fixture.test/{z}/{x}/{y}'}, {minZoom: -1}, {maxZoom: 13},
    {minZoom: 4, maxZoom: 3}, {maxBytes: 0}, {maxBytes: 9 * 1024 * 1024}, {timeoutMilliseconds: 0},
    {credits: []}, {credits: [{label: 'unsafe', url: 'javascript:alert(1)'}]}, {credits: [{label: '', url: 'https://fixture.test'}]}
])('invalid metadata rejects without fetching: %j', invalid => {
    expect(() => createTerrainImageSource({...options, ...invalid})).toThrow();
});
