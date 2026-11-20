// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/* eslint-disable import/no-extraneous-dependencies */
import {describe, expect, test, vi} from 'vitest';
import {BasemapLayer} from '../src/basemap-layer';
import {MapStyleLoader, isResolvedBasemapStyle, resolveBasemapStyle} from '../src/map-style';

const STYLE_URL = 'https://example.com/styles/light/style.json';
const TILEJSON_URL = 'https://example.com/tiles.json';

/** A style with a TileJSON source and relative `sprite` and `glyphs` URLs. */
const STYLE = {
  version: 8,
  sprite: '../sprites/light',
  glyphs: '../fonts/{fontstack}/{range}.pbf',
  sources: {tiles: {type: 'vector', url: TILEJSON_URL}},
  layers: [{id: 'water', type: 'fill', source: 'tiles', 'source-layer': 'water'}]
};

/** A `fetch` that serves the style, the TileJSON and an empty sprite, and records each URL. */
function createFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === STYLE_URL) return Response.json(STYLE);
    if (url === TILEJSON_URL) {
      return Response.json({tiles: ['https://example.com/{z}/{x}/{y}.mvt'], maxzoom: 14});
    }
    if (url.endsWith('.json')) return Response.json({});
    return new Response(new Uint8Array(0));
  });
}

/** A basemap with `props`, set up and updated as deck.gl sets up a layer. */
function basemap(props: Record<string, unknown>): any {
  const layer: any = new BasemapLayer({id: 'basemap', ...props} as any);
  layer.context = {layerManager: {}};
  layer.initializeState();
  layer.setState = (partial: Record<string, unknown>) => Object.assign(layer.state, partial);
  layer.updateState({props: layer.props, oldProps: {style: null}, changeFlags: {}});
  return layer;
}

/** The URLs that `fetchFn` was called with. */
function getUrls(fetchFn: ReturnType<typeof createFetch>): string[] {
  return fetchFn.mock.calls.map(([input]) => String(input));
}

describe('resolved styles', () => {
  test('resolveBasemapStyle and MapStyleLoader brand their result; a copy is not branded', async () => {
    const fetch = createFetch();
    const resolved = await resolveBasemapStyle(STYLE as any, {fetch, baseUrl: STYLE_URL});
    expect(isResolvedBasemapStyle(resolved)).toBe(true);
    expect(isResolvedBasemapStyle(structuredClone(resolved))).toBe(false);
    expect(isResolvedBasemapStyle({...resolved})).toBe(false);
    expect(isResolvedBasemapStyle(STYLE)).toBe(false);
    expect(isResolvedBasemapStyle(null)).toBe(false);
    // The brand adds no field to the style.
    expect(Object.keys(resolved)).toEqual(Object.keys(structuredClone(resolved)));

    const loaded = await MapStyleLoader.parse(JSON.stringify(STYLE), {mapStyle: {fetch}}, {
      url: STYLE_URL
    } as any);
    expect(isResolvedBasemapStyle(loaded)).toBe(true);
  });

  test('BasemapLayer draws a resolved style at once, without fetching its sources again', async () => {
    const fetch = createFetch();
    const resolved = await resolveBasemapStyle(STYLE as any, {fetch, baseUrl: STYLE_URL});
    expect(getUrls(fetch)).toEqual([TILEJSON_URL]);
    fetch.mockClear();

    const layer = basemap({style: resolved, loadOptions: {fetch}});
    // No asynchronous load: the style is drawn from the first render.
    expect(layer.state.resolvedStyle).toBe(resolved);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(getUrls(fetch)).not.toContain(TILEJSON_URL);
  });

  test('an unresolved style object still resolves', async () => {
    const fetch = createFetch();
    const layer = basemap({style: structuredClone(STYLE), loadOptions: {fetch, baseUrl: STYLE_URL}});
    expect(layer.state.resolvedStyle).toBeNull();
    await vi.waitFor(() => expect(layer.state.resolvedStyle).not.toBeNull());
    expect(getUrls(fetch)).toContain(TILEJSON_URL);
    expect(isResolvedBasemapStyle(layer.state.resolvedStyle)).toBe(true);
  });

  test("relative sprite and glyphs URLs resolve against the resolved style's URL", async () => {
    const fetch = createFetch();
    const resolved = await MapStyleLoader.parse(JSON.stringify(STYLE), {mapStyle: {fetch}}, {
      url: STYLE_URL
    } as any);
    fetch.mockClear();
    // No `baseUrl` in loadOptions: the URL comes from the resolved style.
    const layer = basemap({style: resolved, loadOptions: {fetch}});
    await vi.waitFor(() => expect(getUrls(fetch).length).toBeGreaterThan(0));
    expect(getUrls(fetch).some(url => url.startsWith('https://example.com/styles/sprites/light')))
      .toBe(true);
    expect(layer.state.glyphs.url).toBe('https://example.com/styles/fonts/{fontstack}/{range}.pbf');
  });

  test('the resolved style is the one the layer was given, not a copy', async () => {
    const resolved = await resolveBasemapStyle(STYLE as any, {fetch: createFetch()});
    const layer = basemap({style: resolved});
    expect(layer.state.resolvedStyle).toBe(resolved);
    // A later resolution of the same object reuses it again.
    layer.loadStyle(resolved, null);
    expect(layer.state.resolvedStyle).toBe(resolved);
  });
});
