// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {mountTerrainExample} from '../examples/terrain/app';

const mocks = vi.hoisted(() => ({construct: vi.fn(), finalize: vi.fn(), setProps: vi.fn(),
    viewport: {id: 'terrain'}, pick: vi.fn(() => ({coordinate: [7, 46, 1234], triangleIndex: 1})),
    parse: vi.fn(async () => ({mesh: {indices: {value: new Uint32Array([0, 1, 2])}}}))}));
vi.mock('@deck.gl/core', () => ({
    Deck: class {
        constructor(properties: unknown) {mocks.construct(properties);}
        finalize = mocks.finalize; setProps = mocks.setProps;
        getViewports = () => [mocks.viewport];
    },
    MapView: class {}, LightingEffect: class {}, AmbientLight: class {}, DirectionalLight: class {}
}));
vi.mock('@deck.gl/geo-layers', () => ({TerrainLayer: class {}}));
vi.mock('@luma.gl/webgpu', () => ({webgpuAdapter: {}}));
vi.mock('../examples/terrain/load-terrain', () => ({getTerrainTileBounds: () => [0, 0, 1, 1], parseTerrainTile: mocks.parse}));
vi.mock('../examples/terrain/picking', () => ({pickTerrainSurface: mocks.pick}));

const hosts: HTMLElement[] = [];
const instances: ReturnType<typeof mountTerrainExample>[] = [];
function mount() {
    const host = document.createElement('div');
    host.style.width = '512px'; host.style.height = '320px';
    document.body.append(host); hosts.push(host);
    const parametersChanged = vi.fn();
    const instance = mountTerrainExample(host, {parameters: new URLSearchParams('device=webgl'), onParametersChange: parametersChanged});
    instances.push(instance);
    return {host, instance, parametersChanged};
}
beforeEach(() => {vi.clearAllMocks();});
afterEach(() => {instances.splice(0).forEach(instance => instance.destroy()); hosts.splice(0).forEach(host => host.remove()); vi.unstubAllGlobals();});

test('importing the runtime does not start a browser example', () => {
    expect(mocks.construct).not.toHaveBeenCalled();
});

test('early settings, click picking and device changes preserve cached bytes without navigation', async () => {
    let completeDownload: (response: Response) => void = () => {throw new Error('Download not initialized');};
    const download = new Promise<Response>(resolve => {completeDownload = resolve;});
    const fetchMock = vi.fn(() => download);
    vi.stubGlobal('fetch', fetchMock);
    const {host, instance, parametersChanged} = mount();
    const selector = host.querySelector<HTMLSelectElement>('[data-example="mesh-error"]')!;
    selector.value = '5'; selector.dispatchEvent(new Event('change'));
    expect(mocks.parse).not.toHaveBeenCalled();
    completeDownload(new Response(new Uint8Array([1, 2, 3])));
    await instance.ready;
    expect(mocks.construct).toHaveBeenCalledWith(expect.objectContaining({deviceProps: {type: 'webgl'}}));
    const properties = mocks.construct.mock.calls[0][0];
    if (!properties || typeof properties !== 'object' || !('onClick' in properties) || typeof properties.onClick !== 'function') throw new Error('Missing click handler');
    properties.onClick({x: 100, y: 80});
    expect(mocks.pick).toHaveBeenCalledWith(mocks.viewport, expect.any(Object), [100, 80]);
    expect(host.querySelector('[data-example="terrain-hit"]')!.textContent).toContain('1234.0 m (triangle 1)');
    expect(mocks.parse).toHaveBeenCalledWith(expect.any(ArrayBuffer), [0, 0, 1, 1], 5);
    host.querySelector<HTMLButtonElement>('[data-device-type="webgpu"]')!.click();
    expect(mocks.construct).toHaveBeenCalledTimes(2);
    expect(host.querySelector('.is-active')?.getAttribute('data-device-type')).toBe('webgpu');
    expect(parametersChanged.mock.calls[0][0].get('device')).toBe('webgpu');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mocks.parse).toHaveBeenCalledOnce();
    instance.destroy(); instance.destroy();
    expect(mocks.finalize).toHaveBeenCalledTimes(2);
    expect(host.children).toHaveLength(0);
    selector.dispatchEvent(new Event('change'));
    expect(mocks.parse).toHaveBeenCalledOnce();
});

test('navigation aborts pending downloads and prevents late replies reviving removed examples', async () => {
    let completeDownload: (response: Response) => void = () => {};
    const download = new Promise<Response>(resolve => {completeDownload = resolve;});
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => {signal = options.signal || undefined; return download;}));
    const {host, instance} = mount();
    instance.destroy();
    expect(signal?.aborted).toBe(true);
    completeDownload(new Response(new Uint8Array([1, 2, 3])));
    await instance.ready;
    expect(mocks.parse).not.toHaveBeenCalled();
    expect(host.children).toHaveLength(0);
    expect(mocks.finalize).toHaveBeenCalledOnce();
});

test('multiple mounts keep controls and cleanup independent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]))));
    const first = mount(), second = mount();
    await Promise.all([first.instance.ready, second.instance.ready]);
    first.host.querySelector<HTMLButtonElement>('.info-card-toggle')!.click();
    expect(first.host.querySelector('.info-card-collapsed')).not.toBeNull();
    expect(second.host.querySelector('.info-card-collapsed')).toBeNull();
    first.instance.destroy();
    expect(second.host.querySelector('[data-example="map"]')).not.toBeNull();
    expect(mocks.finalize).toHaveBeenCalledOnce();
});
