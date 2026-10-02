// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {CARTO_ATTRIBUTION, createAttributionFragment, getConfiguredAttributions, updateAttribution} from '../examples/classic/app/attribution.js';

test('OpenFreeMap credit HTML retains required labels/links and remains replaceable', () => {
    const element = document.createElement('p');
    const openFreeMap = '<a href="https://openfreemap.org">OpenFreeMap</a> <a href="https://www.openmaptiles.org/">&copy; OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
    updateAttribution(element, [openFreeMap, openFreeMap]);
    expect(element.textContent).toBe('OpenFreeMap © OpenMapTiles Data from OpenStreetMap');
    expect(element.querySelectorAll('a')).toHaveLength(3);
    expect(element.querySelectorAll('a[rel="noopener noreferrer"]')).toHaveLength(3);
    updateAttribution(element, [CARTO_ATTRIBUTION]);
    expect(element.textContent).toContain('CARTO');
    expect(element.textContent).not.toContain('OpenMapTiles');
    updateAttribution(element, []);
    expect(element.childNodes).toHaveLength(0);
});

test('source HTML cannot inject scripts, handlers, styles, images or active URL schemes', () => {
    const element = document.createElement('div');
    element.append(createAttributionFragment([
        '<script>throw Error("bad")</script><style>body{display:none}</style><iframe src="https://bad.example"></iframe>' +
        '<img src=x onerror="alert(1)"><b style="display:none">Visible</b>' +
        '<a href="javascript:alert(1)" onclick="alert(1)">Unsafe</a>' +
        '<a href="data:text/html,bad">Data</a><a href="/relative">Relative</a>' +
        '<a href="https://safe.example" style="display:none" onmouseover="alert(1)">Safe</a>'
    ]));
    expect(element.textContent).toBe('VisibleUnsafeDataRelativeSafe');
    expect(element.querySelectorAll('*')).toHaveLength(1);
    expect(element.querySelector('a')?.href).toBe('https://safe.example/');
    expect(element.querySelector('a')?.getAttribute('style')).toBeNull();
    expect(element.querySelector('a')?.getAttribute('onmouseover')).toBeNull();
});

test('explicit scene credits are available during loading and do not invent provider attribution', () => {
    expect(getConfiguredAttributions({sources: {
        first: {attribution: '© Provider'}, second: {attribution: ' © Provider '}, third: {attribution: 1}
    }})).toEqual(['© Provider']);
    expect(getConfiguredAttributions({sources: {first: {url: 'https://unknown.example'}}})).toEqual([]);
    expect(getConfiguredAttributions(null)).toEqual([]);
});
