// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {terrainMarkup} from '../examples/terrain/view';
import {projectedMarkup} from '../examples/projected/view.js';

test.each([['terrain', terrainMarkup], ['projected', projectedMarkup]])('%s mounts fill their host and resize without an iframe', async (name, markup) => {
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet'; stylesheet.href = '/examples/mounted-example.css';
    const loaded = new Promise<void>((resolve, reject) => {stylesheet.onload = () => resolve(); stylesheet.onerror = () => reject(new Error('Example stylesheet failed'));});
    document.head.append(stylesheet);
    const host = document.createElement('div');
    host.style.width = '512px'; host.style.height = '320px';
    const root = document.createElement('div');
    root.className = `mounted-example ${name}-example`; root.innerHTML = markup;
    host.append(root); document.body.append(host);
    try {
        await loaded;
        const map = root.querySelector<HTMLElement>('[data-example="map"]')!;
        expect(map.getBoundingClientRect().width).toBe(512);
        expect(map.getBoundingClientRect().height).toBe(320);
        host.style.width = '320px'; host.style.height = '240px';
        await expect.poll(() => map.getBoundingClientRect().width).toBe(320);
        expect(map.getBoundingClientRect().height).toBe(240);
        expect(root.querySelector('iframe')).toBeNull();
        expect(root.querySelector('[id]')).toBeNull();
    } finally {host.remove(); stylesheet.remove();}
});
