// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';

const mocks = vi.hoisted(() => ({finalize: vi.fn(), destroyCard: vi.fn(), setProps: vi.fn(),
    parse: vi.fn(async () => ({mesh: {indices: {value: new Uint32Array([0, 1, 2])}}}))}));
vi.mock('@deck.gl/core', () => ({
    Deck: class {finalize = mocks.finalize; setProps = mocks.setProps;},
    MapView: class {}, LightingEffect: class {}, AmbientLight: class {}, DirectionalLight: class {}
}));
vi.mock('@deck.gl/geo-layers', () => ({TerrainLayer: class {}}));
vi.mock('@luma.gl/webgpu', () => ({webgpuAdapter: {}}));
vi.mock('../examples/deck/info-card.js', () => ({createCollapsibleInfoCard: () => mocks.destroyCard}));
vi.mock('../examples/terrain/load-terrain', () => ({getTerrainTileBounds: () => [0, 0, 1, 1], parseTerrainTile: mocks.parse}));
vi.mock('../examples/terrain/picking', () => ({pickTerrainSurface: vi.fn()}));

test('early settings, selected-device styling and bfcache restoration retain a live example', async () => {
    const content = document.createElement('div');
    content.innerHTML = `<p id="status"></p><output id="terrain-hit"></output>
        <select id="mesh-error"><option value="20">20</option><option value="5">5</option></select>
        <input id="wireframe" type="checkbox"><div id="terrain-map"></div><aside id="controls"></aside>
        <button data-device-type="webgl"></button><button data-device-type="webgpu"></button>`;
    document.body.append(content);
    let completeDownload: (response: Response) => void = () => {throw new Error('Download not initialized');};
    const download = new Promise<Response>(resolve => {completeDownload = resolve;});
    const fetchMock = vi.fn(() => download);
    vi.stubGlobal('fetch', fetchMock);
    try {
        const initialization = import('../examples/terrain/app');
        await expect.poll(() => fetchMock.mock.calls.length).toBe(1);
        const selector = content.querySelector<HTMLSelectElement>('#mesh-error')!;
        selector.value = '5'; selector.dispatchEvent(new Event('change'));
        expect(mocks.parse).not.toHaveBeenCalled();
        expect(content.querySelector('#status')!.textContent).toBe('Loading Mapterhorn elevation…');
        completeDownload(new Response(new Uint8Array([1, 2, 3])));
        await initialization;
        expect(mocks.parse).toHaveBeenCalledWith(expect.any(ArrayBuffer), [0, 0, 1, 1], 5);
        expect(content.querySelectorAll('.is-active')).toHaveLength(1);
        expect(content.querySelector('.is-active')?.getAttribute('aria-selected')).toBe('true');
        window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}));
        window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true}));
        expect(mocks.finalize).not.toHaveBeenCalled();
        selector.value = '20'; selector.dispatchEvent(new Event('change'));
        await expect.poll(() => mocks.parse.mock.calls.length).toBe(2);
        window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: false}));
        expect(mocks.finalize).toHaveBeenCalledOnce();
        expect(mocks.destroyCard).toHaveBeenCalledOnce();
        window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: false}));
        expect(mocks.finalize).toHaveBeenCalledOnce();
    } finally {
        window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: false}));
        vi.unstubAllGlobals(); content.remove();
    }
});
