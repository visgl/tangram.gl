// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {mountTerrainExample} from '../examples/terrain/app';
import type {TerrainTileCoordinate} from '../examples/terrain/tile-selection';
import {createTerrainImageSource} from '../examples/terrain/terrain-source';

const mocks = vi.hoisted(() => {
    const selected: {tiles: TerrainTileCoordinate[] | null} = {tiles: null};
    return {selected, build: vi.fn((data: object) => ({loaded: data, renderMesh: 'mesh' in data ? data.mesh : null})), construct: vi.fn(), finalize: vi.fn(), setProps: vi.fn(),
    viewport: {id: 'terrain'}, anchor: vi.fn<() => number | null>(() => null), pick: vi.fn(() => ({coordinate: [7, 46, 1234], triangleIndex: 1, rayParameter: 0.5})),
    parse: vi.fn(async () => ({mesh: {indices: {value: new Uint32Array([0, 1, 2])}, attributes: {}}, grid: {width: 2, height: 2, bounds: [0, 0, 2, 2], heights: new Float32Array(4), valid: new Uint8Array(4)}}))};
});
vi.mock('@deck.gl/core', async importOriginal => ({
    WebMercatorViewport: (await importOriginal<typeof import('@deck.gl/core')>()).WebMercatorViewport,
    Deck: class {
        constructor(properties: unknown) {mocks.construct(properties);}
        finalize = mocks.finalize; setProps = mocks.setProps;
        getViewports = () => [mocks.viewport];
    },
    MapView: class {}, LightingEffect: class {}, AmbientLight: class {}, DirectionalLight: class {}
}));
vi.mock('@deck.gl/geo-layers', () => ({TerrainLayer: class {}}));
vi.mock('@luma.gl/webgpu', () => ({webgpuAdapter: {}}));
vi.mock('../examples/terrain/worker-client', () => ({decodeTerrainInWorker: mocks.parse}));
vi.mock('../examples/terrain/terrain-mesh', async importOriginal => ({...(await importOriginal<typeof import('../examples/terrain/terrain-mesh')>()), buildTerrainRenderMesh: mocks.build}));
vi.mock('../examples/terrain/ground-following', () => ({sampleTerrainAnchor: mocks.anchor}));
vi.mock('../examples/terrain/tile-selection', async importOriginal => {
    const source = await importOriginal<typeof import('../examples/terrain/tile-selection')>();
    return {...source, getTerrainTileBounds: () => [0, 0, 1, 1], selectTerrainTiles: (...viewArguments: Parameters<typeof source.selectTerrainTiles>) => mocks.selected.tiles || source.selectTerrainTiles(...viewArguments)};
});
vi.mock('../examples/terrain/picking', () => ({TerrainScreenQuery: class {pick = mocks.pick;}}));

const hosts: HTMLElement[] = [];
const instances: ReturnType<typeof mountTerrainExample>[] = [];
function mount() {
    const host = document.createElement('div');
    host.style.width = '512px'; host.style.height = '320px';
    document.body.append(host); hosts.push(host);
    const parametersChanged = vi.fn();
    const instance = mountTerrainExample(host, {workerUrl: `${location.origin}/terrain-worker.js`, maxVisibleTiles: 1, parameters: new URLSearchParams('device=webgl'), onParametersChange: parametersChanged});
    instances.push(instance);
    return {host, instance, parametersChanged};
}
beforeEach(() => {vi.clearAllMocks(); mocks.anchor.mockReturnValue(null); mocks.selected.tiles = null;});
afterEach(() => {instances.splice(0).forEach(instance => instance.destroy()); hosts.splice(0).forEach(host => host.remove()); vi.unstubAllGlobals();});

test('importing the runtime does not start a browser example', () => {
    expect(mocks.construct).not.toHaveBeenCalled();
});

test('terrain following updates one controlled target, holds missing elevations and restores free navigation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]))));
    const {host, instance} = mount(); await instance.ready;
    mocks.anchor.mockReturnValue(1484);
    const follow = host.querySelector<HTMLInputElement>('[data-example="follow-terrain"]')!;
    follow.checked = true; follow.dispatchEvent(new Event('change'));
    expect(mocks.setProps).toHaveBeenLastCalledWith({viewState: expect.objectContaining({position: [0, 0, 1484]})});
    expect(mocks.anchor).toHaveBeenLastCalledWith(expect.any(Array), expect.any(Array), 250);
    mocks.anchor.mockReturnValue(null);
    const properties = mocks.construct.mock.calls[0][0];
    if (!properties || typeof properties !== 'object' || !('onViewStateChange' in properties) || typeof properties.onViewStateChange !== 'function') throw new Error('Missing navigation handler');
    properties.onViewStateChange({viewState: {longitude: 7, latitude: 46, zoom: 11.7, pitch: 60, bearing: -25}});
    expect(mocks.setProps).toHaveBeenLastCalledWith({viewState: expect.objectContaining({position: [0, 0, 1484], longitude: 7})});
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    expect(host.querySelector('[data-example="status"]')?.textContent).toContain('waiting — height held');
    follow.checked = false; follow.dispatchEvent(new Event('change'));
    expect(mocks.setProps).toHaveBeenLastCalledWith({viewState: expect.objectContaining({position: [0, 0, 2500]})});
    const calls = mocks.anchor.mock.calls.length;
    instance.destroy(); follow.dispatchEvent(new Event('change'));
    expect(mocks.anchor).toHaveBeenCalledTimes(calls);
});

test('early settings, click picking and device changes preserve cached bytes without navigation', async () => {
    let completeDownload: (response: Response) => void = () => {throw new Error('Download not initialized');};
    const download = new Promise<Response>(resolve => {completeDownload = resolve;});
    const fetchMock = vi.fn(() => download.then(response => response.clone()));
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
    expect(mocks.pick).toHaveBeenCalledWith(mocks.viewport, [100, 80]);
    expect(host.querySelector('[data-example="terrain-hit"]')!.textContent).toContain('1234.0 m (triangle 1)');
    expect(mocks.parse).toHaveBeenCalledWith(expect.stringContaining('terrain-worker.js'), expect.any(ArrayBuffer), [0, 0, 1, 1], 5, expect.any(AbortSignal), 'opaque');
    const downloads = fetchMock.mock.calls.length;
    const decodes = mocks.parse.mock.calls.length;
    host.querySelector<HTMLButtonElement>('[data-device-type="webgpu"]')!.click();
    expect(mocks.construct).toHaveBeenCalledTimes(2);
    expect(host.querySelector('.is-active')?.getAttribute('data-device-type')).toBe('webgpu');
    expect(parametersChanged.mock.calls[0][0].get('device')).toBe('webgpu');
    expect(fetchMock).toHaveBeenCalledTimes(downloads);
    expect(mocks.parse).toHaveBeenCalledTimes(decodes);
    instance.destroy(); instance.destroy();
    expect(mocks.finalize).toHaveBeenCalledTimes(2);
    expect(host.children).toHaveLength(0);
    selector.dispatchEvent(new Event('change'));
    expect(mocks.parse).toHaveBeenCalledTimes(decodes);
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

test('reprioritizing the same tiles preserves reconstructed mesh identities and warm acquisitions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]))));
    mocks.selected.tiles = [{zoom: 2, column: 2, row: 2}, {zoom: 2, column: 3, row: 2}, {zoom: 2, column: 2, row: 3}];
    const {instance} = mount(); await instance.ready;
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const builds = mocks.build.mock.calls.length, decodes = mocks.parse.mock.calls.length;
    mocks.selected.tiles.reverse();
    const properties = mocks.construct.mock.calls[0][0];
    if (!properties || typeof properties !== 'object' || !('onViewStateChange' in properties) || typeof properties.onViewStateChange !== 'function') throw new Error('Missing navigation handler');
    properties.onViewStateChange({viewState: {longitude: 0.5, latitude: 0.5, zoom: 11.7, pitch: 60, bearing: -25}});
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    expect(mocks.build).toHaveBeenCalledTimes(builds);
    expect(mocks.parse).toHaveBeenCalledTimes(decodes);
});

test('injected source owns attribution, no-data and acquisition independently of device/detail controls', async () => {
    const host = document.createElement('div'); document.body.append(host); hosts.push(host);
    const fetch = vi.fn(async () => new Response(new Uint8Array([1])));
    const source = createTerrainImageSource({id: 'custom', minZoom: 3, maxZoom: 3, noData: 'alpha-zero', urlTemplate: 'https://fixture.test/{z}/{x}/{y}', credits: [{label: '<script>literal</script>', url: 'https://fixture.test/license'}], fetch});
    const instance = mountTerrainExample(host, {workerUrl: `${location.origin}/worker.js`, source, maxVisibleTiles: 1}); instances.push(instance);
    await instance.ready;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mocks.parse).toHaveBeenCalledWith(expect.any(String), expect.any(ArrayBuffer), expect.any(Array), expect.any(Number), expect.any(AbortSignal), 'alpha-zero');
    const attribution = host.querySelector('[data-example="attribution"]')!;
    expect(attribution.textContent).toContain('<script>literal</script>'); expect(attribution.querySelector('script')).toBeNull();
    expect(attribution.querySelector('a')?.href).toBe('https://fixture.test/license');
    expect(host.querySelector('[data-example="status"]')?.textContent).toContain('data z3');
    const before = mocks.parse.mock.calls.length;
    const selector = host.querySelector<HTMLSelectElement>('[data-example="tile-detail"]')!;
    selector.value = '256'; selector.dispatchEvent(new Event('change'));
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    expect(mocks.parse).toHaveBeenCalledTimes(before);
});
