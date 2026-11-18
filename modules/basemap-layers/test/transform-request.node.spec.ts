// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/* eslint-disable import/no-extraneous-dependencies */
import {afterEach, describe, expect, test, vi} from 'vitest';
import {BasemapLayer} from '../src/basemap-layer';

const STYLE_URL = 'https://style.example.com/style.json';
const STYLE = {version: 8, sources: {}, layers: []};

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {'content-type': 'application/json'}
  });
}

/** A layer whose state updates in place, without a deck. */
function createLayer(props: Record<string, unknown>): any {
  const layer: any = new BasemapLayer({id: 'basemap', ...props} as any);
  layer.initializeState();
  layer.setState = (partial: Record<string, unknown>) => Object.assign(layer.state, partial);
  return layer;
}

/** Loads the layer's style and waits until it is resolved or has failed. */
async function loadStyle(layer: any): Promise<void> {
  layer.loadStyle(layer.props.style, layer.props.loadOptions, layer.props.transformRequest);
  await vi.waitFor(() => {
    if (!layer.state.resolvedStyle && !layer.state.loadError) {
      throw new Error('The style is still loading');
    }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the style request', () => {
  test('uses loadOptions.fetch and loadOptions.fetchOptions', async () => {
    const globalFetch = vi.fn(() => Promise.reject(new Error('global fetch')));
    vi.stubGlobal('fetch', globalFetch);
    const customFetch = vi.fn(async () => jsonResponse(STYLE));
    const layer = createLayer({
      style: STYLE_URL,
      loadOptions: {fetch: customFetch, fetchOptions: {headers: {Authorization: 'Bearer key'}}}
    });

    await loadStyle(layer);

    expect(layer.state.loadError).toBeNull();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(customFetch).toHaveBeenCalledTimes(1);
    const [url, init] = customFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(STYLE_URL);
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer key');
  });
});
