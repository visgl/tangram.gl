// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, expect, test, vi} from 'vitest';
import {mountGlobeTerrainExample} from '../examples/terrain/globe-app';
import {createTerrainStreamFixture} from './terrain-stream-fixture';
import {createTerrainImageSource} from '../examples/terrain/terrain-source';

const mocks = vi.hoisted(() => ({construct: vi.fn(), setProps: vi.fn(), finalize: vi.fn(), layers: vi.fn(), pick: vi.fn(() => ({coordinate: [80, 25, 1234]}))}));
vi.mock('@deck.gl/core', async original => {
    const module = await original<typeof import('@deck.gl/core')>();
    return {...module, Deck: class {
        constructor(props: unknown) {mocks.construct(props);}
        setProps = mocks.setProps; finalize = mocks.finalize;
        getViewports = () => [new module._GlobeViewport({width: 512, height: 320, longitude: 80, latitude: 25, zoom: 1})];
    }};
});
vi.mock('@vis.gl/tangram-layers/experimental/terrain', () => ({getGlobeScreenRatio: () => 1, GlobeTerrainLayer: class {
    constructor(props: unknown) {mocks.layers(props);}
    pickTerrain = mocks.pick;
}}));
vi.mock('../examples/terrain/worker-client', () => ({decodeTerrainInWorker: vi.fn(async () => createTerrainStreamFixture())}));
const hosts: HTMLElement[] = [], instances: ReturnType<typeof mountGlobeTerrainExample>[] = [];
afterEach(() => {instances.splice(0).forEach(instance => instance.destroy()); hosts.splice(0).forEach(host => host.remove()); vi.unstubAllGlobals(); vi.clearAllMocks();});

test('mount keeps global bytes warm across camera/settings/device changes and owns teardown', async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([1]))); vi.stubGlobal('fetch', fetch);
    const host = document.createElement('div'); document.body.append(host); hosts.push(host);
    const changed = vi.fn();
    const instance = mountGlobeTerrainExample(host, {workerUrl: `${location.origin}/worker.js`, parameters: new URLSearchParams('device=webgl'), onParametersChange: changed}); instances.push(instance);
    await instance.ready;
    expect(fetch).toHaveBeenCalledTimes(20); // Four z1 parents and sixteen global z2 tiles.
    expect(mocks.layers).toHaveBeenLastCalledWith(expect.objectContaining({globeTerrainExaggeration: 100, data: expect.any(Array)}));
    expect(host.querySelector('[data-example="status"]')?.textContent).toContain('16 tiles');
    expect(host.querySelector('[data-example="status"]')?.textContent).toContain('100.0×');
    expect(host.querySelector('[data-example="attribution"]')?.textContent).toContain('Mapterhorn');
    const maximum = host.querySelector<HTMLInputElement>('[data-example="exaggeration"]')!;
    maximum.value = '50'; maximum.dispatchEvent(new Event('change'));
    const wireframe = host.querySelector<HTMLInputElement>('[data-example="wireframe"]')!; wireframe.checked = true; wireframe.dispatchEvent(new Event('change'));
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    expect(mocks.layers).toHaveBeenLastCalledWith(expect.objectContaining({globeTerrainExaggeration: 50, wireframe: true}));
    expect(changed).toHaveBeenCalled();
    maximum.value = '0'; maximum.dispatchEvent(new Event('change')); expect(maximum.value).toBe('50');
    const properties = mocks.construct.mock.calls[0][0];
    if (!properties || typeof properties !== 'object' || !('onViewStateChange' in properties) || typeof properties.onViewStateChange !== 'function' || !('onClick' in properties) || typeof properties.onClick !== 'function') throw new Error('Missing navigation/picking callback');
    properties.onViewStateChange({viewState: {longitude: 100, latitude: 20, zoom: 4}});
    properties.onClick({x: 256, y: 160});
    expect(host.querySelector('[data-example="terrain-hit"]')?.textContent).toContain('1234.0 physical m');
    host.querySelector<HTMLButtonElement>('[data-device-type="webgpu"]')!.click();
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    expect(mocks.finalize).toHaveBeenCalledTimes(1); expect(mocks.construct).toHaveBeenCalledTimes(2); expect(fetch).toHaveBeenCalledTimes(20);
    instance.destroy(); instance.destroy(); maximum.dispatchEvent(new Event('change'));
    expect(mocks.finalize).toHaveBeenCalledTimes(2); expect(host.children).toHaveLength(0);
});

test('invalid hosts reject before allocation; failed tile requests report retry and remain bounded', async () => {
    const host = document.createElement('div'); hosts.push(host);
    expect(() => mountGlobeTerrainExample(host, {workerUrl: 'https://example.invalid/worker.js'})).toThrow('same-origin');
    expect(() => mountGlobeTerrainExample(host, {workerUrl: `${location.origin}/worker.js`, source: createTerrainImageSource({id: 'local', urlTemplate: `${location.origin}/{z}/{x}/{y}`, minZoom: 3, credits: [{label: 'local', url: location.origin}]})})).toThrow('zooms');
    expect(host.children).toHaveLength(0);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', {status: 503})));
    const instance = mountGlobeTerrainExample(host, {workerUrl: `${location.origin}/worker.js`, parameters: new URLSearchParams('exaggeration=invalid')}); instances.push(instance);
    await instance.ready;
    expect(host.querySelector('[data-example="status"]')?.textContent).toContain('failed');
    expect(host.querySelector<HTMLInputElement>('[data-example="exaggeration"]')?.value).toBe('100');
});
