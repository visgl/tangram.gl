// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {mountProjectedExample} from '../examples/projected/app.js';

const mocks = vi.hoisted(() => ({construct: vi.fn(), finalize: vi.fn(), setProps: vi.fn(), dispose: vi.fn(),
    prepare: vi.fn((_scene, _projection, workerUrl) => ({sources: {}, workerUrl})),
    reproject: vi.fn(async () => ({viewState: {target: [0, 0, 0], zoom: 1}}))}));
vi.mock('@deck.gl/core', () => ({
    Deck: class {
        constructor(properties: unknown) {mocks.construct(properties);}
        setProps = mocks.setProps; finalize = mocks.finalize;
        getViewports = () => [{width: 512, height: 320}];
    }, OrthographicView: class {}
}));
vi.mock('@luma.gl/webgpu', () => ({webgpuAdapter: {}}));
vi.mock('@tangram.gl/tangram-renderer/core', () => ({countProjectedTileCoordinates: () => 64}));
vi.mock('@tangram.gl/tangram-layers/experimental/projected-basemaps', () => ({
    createProjectedBasemapScene: mocks.prepare, ProjectedBasemapLayer: class {},
    ProjectedBasemapNavigation: class {dispose = mocks.dispose; reprojectViewState = mocks.reproject;},
    selectProjectedTileDetail: vi.fn()
}));
vi.mock('../examples/projected/projection-engine.js', () => ({createProjectedExampleProjectionEngine: () => ({})}));
vi.mock('../examples/projected/scene.js', () => ({createProjectedExampleScene: () => ({}), getProjectedExampleTileZoom: () => 2}));
vi.mock('../examples/classic/app/attribution.js', () => ({getConfiguredAttributions: () => [], updateAttribution: vi.fn()}));

const mounts: {host: HTMLElement; instance: ReturnType<typeof mountProjectedExample>}[] = [];
function mount() {
    const host = document.createElement('div'); document.body.append(host);
    const onParametersChange = vi.fn();
    const instance = mountProjectedExample(host, {parameters: new URLSearchParams('device=webgl'),
        workerUrl: 'http://localhost/tangram.gl/modules/projected-worker.js', onParametersChange});
    mounts.push({host, instance});
    return {host, instance, onParametersChange};
}
beforeEach(() => {vi.clearAllMocks();});
afterEach(() => {mounts.splice(0).forEach(({host, instance}) => {instance.destroy(); host.remove();});});

test('projected runtime is inert on import and accepts a host-owned worker URL', async () => {
    expect(mocks.construct).not.toHaveBeenCalled();
    const {host, instance, onParametersChange} = mount();
    await instance.ready;
    expect(mocks.prepare).toHaveBeenCalledWith({}, expect.any(Object), 'http://localhost/tangram.gl/modules/projected-worker.js');
    expect(mocks.construct).toHaveBeenCalledWith(expect.objectContaining({parent: host.querySelector('[data-example="map"]')}));
    expect(onParametersChange.mock.calls[0][0].get('projection')).toBe('equal-earth');
    instance.destroy(); instance.destroy();
    expect(mocks.dispose).toHaveBeenCalledOnce(); expect(mocks.finalize).toHaveBeenCalledOnce();
    expect(host.children).toHaveLength(0);
});

test('projection changes retain the source scene and update host routing instead of navigating', async () => {
    const {host, instance, onParametersChange} = mount();
    await instance.ready;
    const selector = host.querySelector<HTMLSelectElement>('[data-example="projection"]')!;
    selector.value = 'equirectangular'; selector.dispatchEvent(new Event('change'));
    await expect.poll(() => onParametersChange.mock.calls.at(-1)?.[0].get('projection')).toBe('equirectangular');
    expect(mocks.prepare).toHaveBeenCalledOnce(); expect(mocks.construct).toHaveBeenCalledOnce();
    expect(mocks.finalize).not.toHaveBeenCalled();
    host.querySelector<HTMLButtonElement>('[data-device="webgpu"]')!.click();
    expect(mocks.construct).toHaveBeenCalledTimes(2);
    expect(onParametersChange.mock.calls.at(-1)?.[0].get('device')).toBe('webgpu');
    expect(host.querySelector('[data-device].is-active')?.getAttribute('data-device')).toBe('webgpu');
});

test('late projection replies and detached controls cannot update a destroyed mount', async () => {
    let finish: (value: {viewState: {target: number[]; zoom: number}}) => void = () => {};
    mocks.reproject.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
    const {host, instance, onParametersChange} = mount();
    await instance.ready;
    const selector = host.querySelector<HTMLSelectElement>('[data-example="projection"]')!;
    selector.value = 'albers'; selector.dispatchEvent(new Event('change'));
    instance.destroy();
    const updates = mocks.setProps.mock.calls.length;
    finish({viewState: {target: [0, 0, 0], zoom: 0}});
    await Promise.resolve(); await Promise.resolve();
    expect(mocks.setProps).toHaveBeenCalledTimes(updates);
    expect(onParametersChange).toHaveBeenCalledOnce();
    selector.dispatchEvent(new Event('change'));
    expect(mocks.reproject).toHaveBeenCalledOnce();
});

test('two projected mounts have separate tabs, disclosures and cleanup', async () => {
    const first = mount(), second = mount();
    await Promise.all([first.instance.ready, second.instance.ready]);
    first.host.querySelector<HTMLButtonElement>('[data-example-tab="about"]')!.click();
    expect(first.host.querySelector<HTMLElement>('[data-example-tab-panel="about"]')!.hidden).toBe(false);
    expect(second.host.querySelector<HTMLElement>('[data-example-tab-panel="about"]')!.hidden).toBe(true);
    first.instance.destroy();
    expect(second.host.querySelector('[data-example="map"]')).not.toBeNull();
    expect(mocks.dispose).toHaveBeenCalledOnce();
});
