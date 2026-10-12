// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, expect, test, vi} from 'vitest';
import {mountGlobeTerrainExample} from '../examples/terrain/globe-app';
import {createTerrainStreamFixture} from './terrain-stream-fixture';
import {createTerrainImageSource} from '../examples/terrain/terrain-source';
import {lngLatToWorld} from '@math.gl/web-mercator';

const mocks = vi.hoisted(() => ({autoLoad: true, viewportZoom: 1, decoderDestroy: vi.fn(), selectDetail: vi.fn(), construct: vi.fn(), setProps: vi.fn(), finalize: vi.fn(), layers: vi.fn(), pick: vi.fn(() => ({coordinate: [80, 25, 1234]}))}));
vi.mock('../examples/terrain/globe-detail', async original => {
    const module = await original<typeof import('../examples/terrain/globe-detail')>();
    return {...module, selectGlobeTerrainDetail: (...parameters: Parameters<typeof module.selectGlobeTerrainDetail>) => {mocks.selectDetail(...parameters); return module.selectGlobeTerrainDetail(...parameters);}};
});
vi.mock('@deck.gl/core', async original => {
    const module = await original<typeof import('@deck.gl/core')>();
    return {...module, Deck: class {
        constructor(props: unknown) {mocks.construct(props); queueMicrotask(() => {if (mocks.autoLoad && props && typeof props === 'object' && 'onLoad' in props && typeof props.onLoad === 'function') props.onLoad();});}
        setProps = mocks.setProps; finalize = mocks.finalize;
        getViewports = () => [new module._GlobeViewport({width: 512, height: 320, longitude: 80, latitude: 25, zoom: mocks.viewportZoom})];
    }};
});
vi.mock('@vis.gl/tangram-layers/experimental/terrain', () => ({getGlobeScreenRatio: () => 1, GlobeTerrainLayer: class {
    constructor(props: unknown) {mocks.layers(props);}
    pickTerrain = mocks.pick;
    getStatistics = () => ({tileCount: 16, exaggeration: 100, displayBytes: 4096, queryIndexBytes: 0, updateMs: 1, queryMs: 2});
}}));
vi.mock('../examples/terrain/decoder-pool', () => ({TerrainDecoderPool: class {
    decodeGrid = vi.fn(async (_bytes: ArrayBuffer, bounds: readonly [number, number, number, number]) => {
        const southwest = lngLatToWorld([bounds[0], bounds[1]]), northeast = lngLatToWorld([bounds[2], bounds[3]]), scale = 2 * Math.PI * 6378137 / 512;
        return {grid: createTerrainStreamFixture([(southwest[0] - 256) * scale, (southwest[1] - 256) * scale, (northeast[0] - 256) * scale, (northeast[1] - 256) * scale]).grid};
    });
    destroy = mocks.decoderDestroy;
    getStatistics = () => ({created: 2, active: 0, idle: 2, completed: 20, failed: 0, cancelled: 0});
}}));
/** Small topology tests host lifecycle, not exhaustive tessellation; high-resolution geometry is covered in the owning module/GPU tests. */
function mountTestGlobeTerrainExample(host: HTMLElement, options: Parameters<typeof mountGlobeTerrainExample>[1]): ReturnType<typeof mountGlobeTerrainExample> {
    return mountGlobeTerrainExample(host, {preparationBudgetMs: 1000, meshResolution: 4, ...options});
}

const hosts: HTMLElement[] = [], instances: ReturnType<typeof mountGlobeTerrainExample>[] = [];
afterEach(() => {instances.splice(0).forEach(instance => instance.destroy()); hosts.splice(0).forEach(host => host.remove()); vi.unstubAllGlobals(); vi.clearAllMocks(); mocks.autoLoad = true; mocks.viewportZoom = 1;});

test('navigation draws immediately but coalesces detail selection until settled; teardown cancels the pending selection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]))));
    const host = document.createElement('div'); document.body.append(host); hosts.push(host);
    const instance = mountTestGlobeTerrainExample(host, {workerUrl: `${location.origin}/worker.js`}); instances.push(instance);
    await instance.ready;
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const selected = mocks.selectDetail.mock.calls.length, properties = mocks.construct.mock.calls[0][0];
    if (!properties || typeof properties !== 'object' || !('onViewStateChange' in properties) || typeof properties.onViewStateChange !== 'function') throw new Error('Missing navigation callback');
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    try {
        mocks.viewportZoom = 3;
        for (let index = 0; index < 4; index++) {properties.onViewStateChange({viewState: {longitude: 80 + index, latitude: 25, zoom: 3}}); await vi.advanceTimersByTimeAsync(100);}
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        expect(mocks.setProps).toHaveBeenCalledWith({viewState: {longitude: 83, latitude: 25, zoom: 3, maxZoom: 12}});
        expect(mocks.selectDetail).toHaveBeenCalledTimes(selected);
        await vi.advanceTimersByTimeAsync(20);
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        expect(mocks.selectDetail).toHaveBeenCalledTimes(selected + 1);
        properties.onViewStateChange({viewState: {longitude: 90, latitude: 25, zoom: 3}});
        instance.destroy(); await vi.advanceTimersByTimeAsync(200);
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        expect(mocks.selectDetail).toHaveBeenCalledTimes(selected + 1);
    } finally {vi.useRealTimers();}
});

test('mount keeps global bytes warm across camera/settings/device changes and owns teardown', async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([1]))); vi.stubGlobal('fetch', fetch);
    const host = document.createElement('div'); document.body.append(host); hosts.push(host);
    const changed = vi.fn();
    const instance = mountTestGlobeTerrainExample(host, {workerUrl: `${location.origin}/worker.js`, parameters: new URLSearchParams('device=webgl'), onParametersChange: changed}); instances.push(instance);
    await instance.ready;
    await expect.poll(() => host.querySelector('[data-example="status"]')?.textContent).toContain('16 tiles');
    expect(fetch).toHaveBeenCalledTimes(20); // Four z1 parents and sixteen global z2 tiles.
    expect(mocks.layers).toHaveBeenLastCalledWith(expect.objectContaining({globeTerrainExaggeration: 100, data: expect.any(Array)}));
    expect(host.querySelector('[data-example="status"]')?.textContent).toContain('16 tiles');
    expect(host.querySelector('[data-example="status"]')?.textContent).toContain('100.0×');
    expect(host.querySelector('[data-example="decoder-status"]')?.textContent).toContain('0.0 MB source meshes');
    expect(host.querySelector('[data-example="preparation-status"]')?.textContent).toContain('0 pending');
    expect(host.querySelector('[data-example="attribution"]')?.textContent).toContain('Mapterhorn');
    const maximum = host.querySelector<HTMLInputElement>('[data-example="exaggeration"]')!;
    expect(maximum.type).toBe('range'); expect(maximum.min).toBe('0'); expect(maximum.max).toBe('200'); expect(maximum.step).toBe('1');
    expect(maximum.labels).toHaveLength(1);
    expect(maximum.labels?.[0].textContent).toContain('Maximum globe exaggeration');
    expect(host.querySelector<HTMLOutputElement>('[data-example="exaggeration-value"]')?.value).toBe('100×');
    maximum.value = '50'; maximum.dispatchEvent(new Event('input'));
    const wireframe = host.querySelector<HTMLInputElement>('[data-example="wireframe"]')!; wireframe.checked = true; wireframe.dispatchEvent(new Event('change'));
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    expect(mocks.layers).toHaveBeenLastCalledWith(expect.objectContaining({globeTerrainExaggeration: 50, wireframe: true}));
    expect(changed).toHaveBeenCalled();
    for (const value of [0, 200, 25]) {
        maximum.value = String(value); maximum.dispatchEvent(new Event('input'));
        expect(host.querySelector<HTMLOutputElement>('[data-example="exaggeration-value"]')?.value).toBe(`${value}×`);
        expect(changed.mock.lastCall?.[0].get('exaggeration')).toBe(String(value));
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        expect(mocks.layers).toHaveBeenLastCalledWith(expect.objectContaining({globeTerrainExaggeration: value}));
    }
    const warmDownloads = fetch.mock.calls.length;
    const buildsBeforeCamera = mocks.layers.mock.calls.length;
    const properties = mocks.construct.mock.calls[0][0];
    expect(properties).toMatchObject({viewState: {maxZoom: 12}});
    if (!properties || typeof properties !== 'object' || !('onViewStateChange' in properties) || typeof properties.onViewStateChange !== 'function' || !('onClick' in properties) || typeof properties.onClick !== 'function') throw new Error('Missing navigation/picking callback');
    properties.onViewStateChange({viewState: {longitude: 100, latitude: 20, zoom: 4}});
    properties.onViewStateChange({viewState: {longitude: 100, latitude: 20, zoom: 20}});
    expect(mocks.setProps).toHaveBeenLastCalledWith({viewState: {longitude: 100, latitude: 20, zoom: 12, maxZoom: 12}});
    properties.onClick({x: 256, y: 160});
    expect(host.querySelector('[data-example="terrain-hit"]')?.textContent).toContain('1234.0 physical m');
    expect(host.querySelector('[data-example="display-status"]')?.textContent).toContain('last pick 2.0 ms');
    expect(host.querySelector('[data-example="display-status"]')?.textContent).toContain('excludes GPU/transient');
    if ('onAfterRender' in properties && typeof properties.onAfterRender === 'function') properties.onAfterRender();
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    expect(mocks.layers.mock.calls.length).toBe(buildsBeforeCamera);
    host.querySelector<HTMLButtonElement>('[data-device-type="webgpu"]')!.click();
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    expect(mocks.finalize).toHaveBeenCalledTimes(1); expect(mocks.construct).toHaveBeenCalledTimes(2); expect(fetch).toHaveBeenCalledTimes(warmDownloads);
    expect(mocks.layers.mock.calls.length).toBe(buildsBeforeCamera + 1);
    instance.destroy(); instance.destroy(); maximum.dispatchEvent(new Event('input'));
    expect(mocks.finalize).toHaveBeenCalledTimes(2); expect(host.children).toHaveLength(0);
    expect(mocks.decoderDestroy).toHaveBeenCalledOnce();
});

test('invalid hosts reject before allocation; failed tile requests report retry and remain bounded', async () => {
    const host = document.createElement('div'); hosts.push(host);
    expect(() => mountTestGlobeTerrainExample(host, {workerUrl: 'https://example.invalid/worker.js'})).toThrow('same-origin');
    expect(() => mountTestGlobeTerrainExample(host, {workerUrl: `${location.origin}/worker.js`, preparationBudgetMs: 0})).toThrow('slice target');
    expect(() => mountTestGlobeTerrainExample(host, {workerUrl: `${location.origin}/worker.js`, maxPreparedBytes: -1})).toThrow('byte limit');
    expect(() => mountTestGlobeTerrainExample(host, {workerUrl: `${location.origin}/worker.js`, maxDisplayBytes: -1})).toThrow('byte limits');
    expect(() => mountTestGlobeTerrainExample(host, {workerUrl: `${location.origin}/worker.js`, maxQueryIndexBytes: 0.5})).toThrow('byte limits');
    for (const meshResolution of [1, 257, 2.5]) expect(() => mountTestGlobeTerrainExample(host, {workerUrl: `${location.origin}/worker.js`, meshResolution})).toThrow('resolution');
    expect(() => mountTestGlobeTerrainExample(host, {workerUrl: `${location.origin}/worker.js`, source: createTerrainImageSource({id: 'local', urlTemplate: `${location.origin}/{z}/{x}/{y}`, minZoom: 3, credits: [{label: 'local', url: location.origin}]})})).toThrow('zooms');
    expect(host.children).toHaveLength(0);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', {status: 503})));
    const instance = mountTestGlobeTerrainExample(host, {workerUrl: `${location.origin}/worker.js`, parameters: new URLSearchParams('exaggeration=invalid')}); instances.push(instance);
    await instance.ready;
    expect(host.querySelector('[data-example="status"]')?.textContent).toContain('failed');
    expect(host.querySelector<HTMLInputElement>('[data-example="exaggeration"]')?.value).toBe('100');
});

test('cooperative preparation pauses during navigation and teardown prevents late publication', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]))));
    const host = document.createElement('div'); document.body.append(host); hosts.push(host);
    const instance = mountTestGlobeTerrainExample(host, {workerUrl: `${location.origin}/worker.js`, preparationBudgetMs: 0.00001}); instances.push(instance);
    await instance.ready;
    const properties = mocks.construct.mock.calls[0][0];
    if (!properties || typeof properties !== 'object' || !('onViewStateChange' in properties) || typeof properties.onViewStateChange !== 'function') throw new Error('Missing navigation callback');
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    try {
        properties.onViewStateChange({viewState: {longitude: 81, latitude: 25, zoom: 1}});
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        const diagnostic = host.querySelector('[data-example="preparation-status"]')?.textContent;
        expect(diagnostic).toContain('pending'); expect(diagnostic).not.toContain('0 pending');
        expect(mocks.layers.mock.lastCall?.[0]).toMatchObject({data: []});
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        expect(host.querySelector('[data-example="preparation-status"]')?.textContent).toBe(diagnostic);
        instance.destroy(); const published = mocks.layers.mock.calls.length;
        await vi.advanceTimersByTimeAsync(200); await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        expect(mocks.layers).toHaveBeenCalledTimes(published); expect(host.children).toHaveLength(0);
    } finally {vi.useRealTimers();}
});

test('template admission failure reports explicit retry without restarting tile acquisition or publishing partial geometry', async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([1]))); vi.stubGlobal('fetch', fetch);
    const host = document.createElement('div'); document.body.append(host); hosts.push(host);
    const instance = mountTestGlobeTerrainExample(host, {workerUrl: `${location.origin}/worker.js`, maxPreparedBytes: 0, preparationBudgetMs: 1000}); instances.push(instance);
    await instance.ready;
    await expect.poll(() => host.querySelector('[data-example="preparation-status"]')?.textContent).toContain('retained-byte limit');
    expect(mocks.layers.mock.lastCall?.[0]).toMatchObject({data: []});
    const diagnostic = host.querySelector('[data-example="preparation-status"]')?.textContent;
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    expect(host.querySelector('[data-example="preparation-status"]')?.textContent).toBe(diagnostic);
    host.querySelector<HTMLButtonElement>('[data-example="retry"]')!.click();
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    expect(host.querySelector('[data-example="preparation-status"]')?.textContent).toContain('retained-byte limit');
    expect(fetch).toHaveBeenCalledTimes(20);
});

test('cached tiles wait for asynchronous GPU initialization and ignore replaced device callbacks', async () => {
    mocks.autoLoad = false;
    const fetch = vi.fn(async () => new Response(new Uint8Array([1]))); vi.stubGlobal('fetch', fetch);
    const host = document.createElement('div'); document.body.append(host); hosts.push(host);
    const instance = mountTestGlobeTerrainExample(host, {workerUrl: `${location.origin}/worker.js`, parameters: new URLSearchParams('device=webgl')}); instances.push(instance);
    await instance.ready;
    expect(mocks.layers).not.toHaveBeenCalled();
    host.querySelector<HTMLButtonElement>('[data-device-type="webgpu"]')!.click();
    for (const [index, call] of mocks.construct.mock.calls.entries()) {
        const properties = call[0];
        if (!properties || typeof properties !== 'object' || !('onLoad' in properties) || typeof properties.onLoad !== 'function') throw new Error('Missing device readiness callback');
        properties.onLoad();
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        if (index === 0) expect(mocks.layers).not.toHaveBeenCalled();
        else expect(mocks.layers).toHaveBeenCalled();
    }
    expect(fetch).toHaveBeenCalledTimes(20);
});

test.each([['0', '0'], ['200', '200'], ['25.5', '26'], ['-1', '100'], ['201', '100'], ['', '100'], ['%20%20', '100']])('URL exaggeration %s initializes a matching slider and readout', async (requested, expected) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]))));
    const host = document.createElement('div'); hosts.push(host);
    const instance = mountTestGlobeTerrainExample(host, {workerUrl: `${location.origin}/worker.js`, parameters: new URLSearchParams(`exaggeration=${requested}`)}); instances.push(instance);
    await instance.ready;
    expect(host.querySelector<HTMLInputElement>('[data-example="exaggeration"]')?.value).toBe(expected);
    expect(host.querySelector<HTMLOutputElement>('[data-example="exaggeration-value"]')?.value).toBe(`${expected}×`);
    expect(mocks.layers).toHaveBeenLastCalledWith(expect.objectContaining({globeTerrainExaggeration: Number(expected)}));
});

test('zoom streams higher-detail globe tiles and retains global fallback across device/settings changes', async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([1]))); vi.stubGlobal('fetch', fetch);
    const host = document.createElement('div'); document.body.append(host); hosts.push(host);
    // Streaming/payload conformance is independent of wall-clock frame slicing; pause/yield behavior is tested separately.
    const instance = mountTestGlobeTerrainExample(host, {workerUrl: `${location.origin}/worker.js`, parameters: new URLSearchParams('device=webgl'), preparationBudgetMs: 1000}); instances.push(instance);
    await instance.ready;
    const properties = mocks.construct.mock.calls[0][0];
    if (!properties || typeof properties !== 'object' || !('onViewStateChange' in properties) || typeof properties.onViewStateChange !== 'function') throw new Error('Missing navigation callback');
    mocks.viewportZoom = 6; properties.onViewStateChange({viewState: {longitude: 80, latitude: 25, zoom: 6}});
    await expect.poll(() => Number(host.querySelector('[data-example="status"]')?.textContent?.match(/z(\d+) detail/)?.[1] ?? 0)).toBeGreaterThanOrEqual(4);
    await expect.poll(() => host.querySelector('[data-example="status"]')?.textContent).not.toContain('queued');
    expect(fetch.mock.calls.length).toBeGreaterThan(20);
    const warm = fetch.mock.calls.length;
    const maximum = host.querySelector<HTMLInputElement>('[data-example="exaggeration"]')!;
    maximum.value = '25'; maximum.dispatchEvent(new Event('input'));
    host.querySelector<HTMLButtonElement>('[data-device-type="webgpu"]')!.click();
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    expect(fetch.mock.calls.length).toBe(warm);
    mocks.viewportZoom = 1; properties.onViewStateChange({viewState: {longitude: 80, latitude: 25, zoom: 1}});
    await expect.poll(() => host.querySelector('[data-example="status"]')?.textContent).toContain('z2 detail');
    expect(fetch.mock.calls.length).toBe(warm);
});
