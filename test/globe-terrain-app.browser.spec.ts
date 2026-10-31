// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, expect, test, vi} from 'vitest';
import {mountGlobeTerrainExample} from '../examples/terrain/globe-app';
import {createTerrainStreamFixture} from './terrain-stream-fixture';
import {createTerrainImageSource} from '../examples/terrain/terrain-source';
import {lngLatToWorld} from '@math.gl/geospatial';

const mocks = vi.hoisted(() => ({autoLoad: true, viewportZoom: 1, decoderDestroy: vi.fn(), selectDetail: vi.fn(), construct: vi.fn(), setProps: vi.fn(), finalize: vi.fn(), layers: vi.fn(), pick: vi.fn(() => ({coordinate: [80, 25, 1234]})), elevation: vi.fn((): {coordinate: number[]; position: [number, number, number]} | null => ({coordinate: [80, 25, 1234], position: [0, -256, 0]})), blocker: vi.fn((_start: readonly [number, number, number], _end: readonly [number, number, number], _options?: {startInset?: number; endInset?: number}): {distance: number} | null => null)}));
const basemapMocks = vi.hoisted(() => ({construct: vi.fn<(props: import('@tangram.gl/tangram-layers').TangramLayerProps) => void>(), surface: vi.fn(() => null), pick: vi.fn(() => ({coordinate: [80, 25, 456]}))}));
vi.mock('@tangram.gl/tangram-layers', () => ({TangramLayer: class {
    constructor(props: import('@tangram.gl/tangram-layers').TangramLayerProps) {basemapMocks.construct(props);}
    getDrapedTerrainSurface = basemapMocks.surface; getTerrainAt = basemapMocks.pick;
    getTerrainDrapingStatistics = () => ({meshes: 16, meshBytes: 1000, queryBytes: 1000, stagedMeshBytes: 0, maximumPreparationMs: 1});
}}));
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
vi.mock('@tangram.gl/tangram-layers/experimental/terrain', async original => ({...await original<typeof import('@tangram.gl/tangram-layers/experimental/terrain')>(), getGlobeScreenRatio: () => 1, GlobeTerrainLayer: class {
    constructor(props: unknown) {mocks.layers(props);}
    pickTerrain = mocks.pick;
    sampleElevation = mocks.elevation;
    intersectTerrainSegment = mocks.blocker;
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
    return mountGlobeTerrainExample(host, {basemap: false, preparationBudgetMs: 1000, displayBudgetMs: 1000, meshResolution: 4, ...options});
}

const hosts: HTMLElement[] = [], instances: ReturnType<typeof mountGlobeTerrainExample>[] = [];
afterEach(() => {instances.splice(0).forEach(instance => instance.destroy()); hosts.splice(0).forEach(host => host.remove()); vi.unstubAllGlobals(); vi.clearAllMocks(); mocks.autoLoad = true; mocks.viewportZoom = 1;});

test('pinned targets re-sample admitted terrain on camera changes, skip idle frames and ignore stale or disposed callbacks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]))));
    const host = document.createElement('div'); document.body.append(host); hosts.push(host);
    const instance = mountTestGlobeTerrainExample(host, {workerUrl: `${location.origin}/worker.js`, parameters: new URLSearchParams('device=webgl')}); instances.push(instance); await instance.ready;
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const properties = mocks.construct.mock.calls[0][0];
    if (!properties || typeof properties !== 'object' || !('onClick' in properties) || typeof properties.onClick !== 'function' || !('onAfterRender' in properties) || typeof properties.onAfterRender !== 'function' || !('onViewStateChange' in properties) || typeof properties.onViewStateChange !== 'function') throw new Error('Missing target callbacks');
    properties.onClick({x: 256, y: 160});
    const status = host.querySelector('[data-example="terrain-visibility"]')!;
    expect(status.textContent).toContain('1234.0 physical m'); expect(status.textContent).toContain('not certified visibility');
    const queried = mocks.elevation.mock.calls.length;
    for (let frame = 0; frame < 4; frame++) properties.onAfterRender();
    expect(mocks.elevation).toHaveBeenCalledTimes(queried);
    mocks.viewportZoom = 2; mocks.blocker.mockReturnValueOnce({distance: 1}); properties.onAfterRender();
    expect(status.textContent).toContain('blocked by loaded terrain');
    expect(mocks.blocker.mock.lastCall?.[2]).toEqual({startInset: 1e-7, endInset: 1e-4});
    mocks.viewportZoom = 3; mocks.elevation.mockReturnValueOnce(null); properties.onAfterRender();
    expect(status.textContent).toContain('visibility unknown');
    host.querySelector<HTMLButtonElement>('[data-example="clear-target"]')!.click();
    expect(status.textContent).toContain('Click terrain to pin');
    const cleared = mocks.elevation.mock.calls.length; properties.onAfterRender(); expect(mocks.elevation).toHaveBeenCalledTimes(cleared);
    host.querySelector<HTMLButtonElement>('[data-device-type="webgpu"]')!.click();
    const picked = mocks.pick.mock.calls.length, updates = mocks.setProps.mock.calls.length;
    properties.onClick({x: 256, y: 160}); properties.onViewStateChange({viewState: {longitude: 0, latitude: 0, zoom: 3}});
    expect(mocks.pick).toHaveBeenCalledTimes(picked); expect(mocks.setProps).toHaveBeenCalledTimes(updates);
    const latest = mocks.construct.mock.lastCall?.[0]; instance.destroy();
    if (!latest || typeof latest !== 'object' || !('onClick' in latest) || typeof latest.onClick !== 'function') throw new Error('Missing latest target callback');
    latest.onClick({x: 256, y: 160}); expect(mocks.pick).toHaveBeenCalledTimes(picked);
});

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
    expect(mocks.layers.mock.lastCall?.[0]).toMatchObject({maxDisplayBytes: 128 * 1024 * 1024, maxQueryIndexBytes: 64 * 1024 * 1024});
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
    expect(host.querySelector('[data-example="display-status"]')?.textContent).toContain('last query 2.0 ms');
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
    expect(() => mountTestGlobeTerrainExample(host, {workerUrl: `${location.origin}/worker.js`, displayBudgetMs: 0})).toThrow('Display slice target');
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

test('display work yields, keeps the old admitted generation through slider replacement, and teardown prevents publication', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]))));
    const host = document.createElement('div'); document.body.append(host); hosts.push(host);
    const instance = mountTestGlobeTerrainExample(host, {workerUrl: `${location.origin}/worker.js`, displayBudgetMs: 0.00001}); instances.push(instance);
    await instance.ready;
    await expect.poll(() => mocks.layers.mock.lastCall?.[0]).toMatchObject({data: expect.arrayContaining([expect.any(Object)]), preparedDisplay: expect.any(Object)});
    const previous = mocks.layers.mock.lastCall?.[0];
    if (!previous || typeof previous !== 'object' || !('preparedDisplay' in previous)) throw new Error('Missing display snapshot');
    const slider = host.querySelector<HTMLInputElement>('[data-example="exaggeration"]')!; slider.value = '50'; slider.dispatchEvent(new Event('input'));
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    expect(mocks.layers.mock.lastCall?.[0]).toMatchObject({preparedDisplay: previous.preparedDisplay, globeTerrainExaggeration: 50});
    expect(host.querySelector('[data-example="display-status"]')?.textContent).toContain('display preparation');
    slider.value = '0'; slider.dispatchEvent(new Event('input'));
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    instance.destroy(); const count = mocks.layers.mock.calls.length;
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); expect(mocks.layers).toHaveBeenCalledTimes(count);
});

test('display admission errors stop repeated preparation and preserve source cache for explicit retry', async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([1]))); vi.stubGlobal('fetch', fetch);
    const host = document.createElement('div'); document.body.append(host); hosts.push(host);
    const instance = mountTestGlobeTerrainExample(host, {workerUrl: `${location.origin}/worker.js`, maxDisplayBytes: 0}); instances.push(instance);
    await instance.ready;
    await expect.poll(() => host.querySelector('[data-example="display-status"]')?.textContent).toContain('display-byte limit');
    const status = host.querySelector('[data-example="display-status"]')?.textContent;
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); expect(host.querySelector('[data-example="display-status"]')?.textContent).toBe(status);
    expect(mocks.layers.mock.lastCall?.[0]).toMatchObject({data: []});
    host.querySelector<HTMLButtonElement>('[data-example="retry"]')!.click();
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); expect(host.querySelector('[data-example="display-status"]')?.textContent).toContain('display-byte limit');
    expect(fetch).toHaveBeenCalledTimes(20);
});

test('stable render diagnostics do not mutate the DOM on every deck frame', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]))));
    const host = document.createElement('div'); document.body.append(host); hosts.push(host);
    const instance = mountTestGlobeTerrainExample(host, {workerUrl: `${location.origin}/worker.js`}); instances.push(instance);
    await instance.ready; await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const properties = mocks.construct.mock.calls[0][0];
    if (!properties || typeof properties !== 'object' || !('onAfterRender' in properties) || typeof properties.onAfterRender !== 'function') throw new Error('Missing rendering callback');
    const target = host.querySelector('[data-example="display-status"]')!;
    const observer = new MutationObserver(() => {}); observer.observe(target, {subtree: true, childList: true, characterData: true});
    properties.onAfterRender(); properties.onAfterRender(); expect(observer.takeRecords()).toEqual([]); observer.disconnect();
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

test('styled globe draping preserves field identity during GPU-only relief changes and skips duplicate preview preparation', async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([1]))); vi.stubGlobal('fetch', fetch);
    const host = document.createElement('div'); document.body.append(host); hosts.push(host);
    const instance = mountTestGlobeTerrainExample(host, {workerUrl: `${location.origin}/worker.js`, basemap: {sources: {}}, parameters: new URLSearchParams('device=webgl')}); instances.push(instance);
    await instance.ready;
    await expect.poll(() => basemapMocks.construct.mock.lastCall?.[0].terrain?.grids.length).toBeGreaterThan(0);
    const field = basemapMocks.construct.mock.lastCall?.[0].terrain;
    const warm = fetch.mock.calls.length, previewCalls = mocks.layers.mock.calls.length;
    const slider = host.querySelector<HTMLInputElement>('[data-example="exaggeration"]');
    if (!slider) throw new Error('Missing exaggeration slider'); slider.value = '25'; slider.dispatchEvent(new Event('input'));
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    expect(basemapMocks.construct.mock.lastCall?.[0].terrain).toBe(field);
    expect(basemapMocks.construct.mock.lastCall?.[0].terrainExaggeration).toBe(25);
    expect(basemapMocks.construct.mock.lastCall?.[0].globeMaxElevation).toBe(300000);
    expect(mocks.layers.mock.calls.length).toBe(previewCalls); expect(fetch.mock.calls.length).toBe(warm);
    expect(host.querySelector('[data-example="preparation-status"]')?.textContent).toContain('paused');
    const properties = mocks.construct.mock.calls[0][0];
    if (!properties || typeof properties !== 'object' || !('onClick' in properties) || typeof properties.onClick !== 'function') throw new Error('Missing picking callback');
    properties.onClick({x: 100, y: 100});
    expect(basemapMocks.pick).toHaveBeenCalledWith({x: 100, y: 100});
    expect(host.querySelector('[data-example="terrain-hit"]')?.textContent).toContain('456.0');
    host.querySelector<HTMLButtonElement>('[data-device-type="webgpu"]')?.click();
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    expect(fetch.mock.calls.length).toBe(warm);
});

test('an unbounded whole-globe projection holds detail instead of forcing maximum-resolution work', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]))));
    const host = document.createElement('div'); document.body.append(host); hosts.push(host);
    const instance = mountTestGlobeTerrainExample(host, {workerUrl: `${location.origin}/worker.js`, basemap: {sources: {}}, parameters: new URLSearchParams('device=webgl')}); instances.push(instance);
    await instance.ready;
    await expect.poll(() => basemapMocks.construct.mock.lastCall?.[0].terrain?.grids.length).toBeGreaterThan(0);
    const resolution = basemapMocks.construct.mock.lastCall?.[0].terrain?.groundMeshResolution;
    const properties = mocks.construct.mock.calls[0][0];
    if (!properties || typeof properties !== 'object' || !('onViewStateChange' in properties) || typeof properties.onViewStateChange !== 'function') throw new Error('Missing view-state callback');
    mocks.viewportZoom = 10; properties.onViewStateChange({viewState: {longitude: 80, latitude: 25, zoom: 10}});
    await expect.poll(() => host.querySelector('[data-example="preparation-status"]')?.textContent).toContain('unbounded');
    expect(basemapMocks.construct.mock.lastCall?.[0].terrain?.groundMeshResolution).toBe(resolution);
});

test('retry re-admits a rejected styled field without refetching its warm source tiles', async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([1]))); vi.stubGlobal('fetch', fetch);
    const host = document.createElement('div'); document.body.append(host); hosts.push(host);
    const instance = mountTestGlobeTerrainExample(host, {workerUrl: `${location.origin}/worker.js`, basemap: {sources: {}}, parameters: new URLSearchParams('device=webgl')}); instances.push(instance);
    await instance.ready;
    await expect.poll(() => basemapMocks.construct.mock.lastCall?.[0].terrain?.grids.length).toBeGreaterThan(0);
    const properties = basemapMocks.construct.mock.lastCall?.[0], warm = fetch.mock.calls.length;
    if (!properties?.onSceneError) throw new Error('Missing scene error handler');
    Reflect.apply(properties.onSceneError, undefined, [new Error('resource admission')]);
    host.querySelector<HTMLButtonElement>('[data-example="retry"]')!.click();
    await expect.poll(() => basemapMocks.construct.mock.lastCall?.[0].terrain).not.toBe(properties.terrain);
    expect(fetch).toHaveBeenCalledTimes(warm);
});
