// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, describe, expect, it, test, vi} from 'vitest';
import {injectApiKey} from '../examples/classic/app/key.js';
import {getViewFromUrl, initializeUrlSync} from '../examples/classic/app/url.js';
import {getSceneOverview} from '../examples/classic/app/scene-catalog.js';

afterEach(() => vi.unstubAllGlobals());

test.each([
  ['', 'styles/projection-morph.yaml', [4, 39, -96]],
  ['#12.5/40.7/-74', 'styles/projection-morph.yaml', [12.5, 40.7, -74]],
  ['#12/40', 'styles/projection-morph.yaml', [4, 39, -96]],
  ['', 'styles/tron.yaml', [16, 40.70531887544228, -74.00976419448853]]
])('starts %s / %s at the intended view and retains it after layer init', (hash, sceneUrl, view) => {
  vi.stubGlobal('window', {clearTimeout, setTimeout});
  const map = {on: vi.fn(), off: vi.fn(), setView: vi.fn()};
  const layer = {on: vi.fn(), off: vi.fn()};
  const cleanup = initializeUrlSync({map, layer, sceneUrl, location: {hash}});
  expect(map.setView).toHaveBeenCalledExactlyOnceWith(view.slice(1), view[0]);
  layer.on.mock.calls[0][1]();
  expect(map.setView).toHaveBeenLastCalledWith(view.slice(1), view[0]);
  cleanup();
  expect(map.off).toHaveBeenCalledWith('move', map.on.mock.calls[0][1]);
  expect(layer.off).toHaveBeenCalledWith('init', layer.on.mock.calls[0][1]);
});

test('recognizes Albers asset URLs without applying its overview to other scenes', () => {
  expect(getSceneOverview('https://example.test/tangram.gl/examples/classic/styles/projection-morph.yaml?v=1')).toEqual([4, 39, -96]);
  expect(getSceneOverview('styles/tron.yaml?scene=styles/projection-morph.yaml')).toBeNull();
  expect(getSceneOverview({sources: {}})).toBeNull();
});

describe('classic example modules', () => {
  it('parses complete map hashes and rejects incomplete hashes', () => {
    expect(getViewFromUrl('#12.5/40.7/-74')).toEqual([12.5, 40.7, -74]);
    expect(getViewFromUrl('#12.5/40.7')).toBeNull();
    expect(getViewFromUrl('#zoom/40.7/-74')).toBeNull();
  });

  it('injects an API key only into compatible scene fields', () => {
    const config = {
      global: {api_key: ''},
      sources: {
        vector: {url: 'https://tile.nextzen.org/tilezen/vector/v1/all/{z}/{x}/{y}.mvt'},
        raster: {url: 'https://example.com/{z}/{x}/{y}.png'}
      }
    };

    injectApiKey(config, 'runtime-key');

    expect(config.global.api_key).toBe('runtime-key');
    expect(config.sources.vector.url_params.api_key).toBe('runtime-key');
    expect(config.sources.raster.url_params).toBeUndefined();
  });
});
