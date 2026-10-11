// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';

test('terrain document fills its iframe and responds to viewport resizing without GPU or network tiles', async () => {
    const sourceUrl = new URL('/examples/terrain/index.html', location.href);
    const response = await fetch(sourceUrl);
    expect(response.ok).toBe(true);
    const source = new DOMParser().parseFromString(await response.text(), 'text/html');
    // Exercise real layout/styles without executing the app, Vite or CDN scripts.
    for (const script of source.querySelectorAll('script')) script.remove();
    const base = source.createElement('base');
    base.href = new URL('.', sourceUrl).href;
    source.head.prepend(base);
    const frame = document.createElement('iframe');
    frame.style.width = '512px'; frame.style.height = '320px';
    const loaded = new Promise<void>(resolve => {frame.onload = () => resolve();});
    frame.srcdoc = source.documentElement.outerHTML;
    document.body.append(frame);
    try {
        await loaded;
        const map = frame.contentDocument!.getElementById('terrain-map')!;
        expect(map.getBoundingClientRect().width).toBe(512);
        expect(map.getBoundingClientRect().height).toBe(320);
        frame.style.width = '320px'; frame.style.height = '240px';
        await expect.poll(() => map.getBoundingClientRect().width).toBe(320);
        expect(map.getBoundingClientRect().height).toBe(240);
    } finally {
        frame.remove();
    }
});
