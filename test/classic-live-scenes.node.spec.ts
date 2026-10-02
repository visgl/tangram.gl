// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {readFileSync} from 'node:fs';
import {describe, expect, test} from 'vitest';
import {DEFAULT_SCENE, SCENE_OPTIONS, getPreviewBasemapUrl} from '../examples/classic/app/scene-catalog.js';
import {OPENFREEMAP_TILEJSON} from '../examples/classic/app/vector-providers.js';
import {parseSceneYamlLegacy} from '../modules/tangram-renderer/src/procedures/scene-yaml-legacy';
import mergeObjects from '../modules/tangram-renderer/src/utils/merge';

/** Read a checked-in classic scene without depending on generated package bundles. */
function readScene(name: string) {
  return parseSceneYamlLegacy(readFileSync(new URL(`../examples/classic/styles/${name}`, import.meta.url), 'utf8'));
}

describe('classic live style choices', () => {
  test('starts with full TRON and routes both live choices through their compatibility wrapper', () => {
    expect(DEFAULT_SCENE).toBe('styles/tron.yaml');
    expect(SCENE_OPTIONS.slice(0, 2)).toEqual([
      {label: 'TRON (OpenFreeMap)', value: 'styles/tron.yaml'},
      {label: 'Crosshatch (OpenFreeMap)', value: 'styles/crosshatch.yaml'}
    ]);
    for (const name of ['tron.yaml', 'crosshatch.yaml']) {
      expect(readScene(name).import.at(-1)).toBe('openmaptiles-mapzen-compat.yaml');
    }
    expect(SCENE_OPTIONS.some(option => option.value.endsWith('.zip'))).toBe(false);
    expect(new Set(SCENE_OPTIONS.map(option => option.value)).size).toBe(SCENE_OPTIONS.length);
  });

  test.each(['mapzen', 'tilezen'])('replaces inherited Nextzen URL and credentials for %s without losing the tile transform', name => {
    const inherited: {sources: Record<string, Record<string, unknown>>} = {sources: {[name]: {
      type: 'MVT',
      url: 'https://tile.nextzen.org/tilezen/vector/v1/all/{z}/{x}/{y}.mvt',
      url_params: {api_key: 'global.api_key'}
    }}};
    const merged = mergeObjects(inherited, readScene('openmaptiles-mapzen-compat.yaml'));
    const source = merged.sources[name];
    expect(source.url).toBe('');
    expect(source.url_params).toBeNull();
    expect(source.tilejson).toBe(OPENFREEMAP_TILEJSON);
    expect(source.max_zoom).toBe(14);
    expect(source.transform).toContain('transformOpenMapTilesToMapzen(data)');
    expect(source.attribution).toContain('OpenStreetMap');
    expect(source.attribution).toContain('OpenMapTiles');
  });

  test.each(SCENE_OPTIONS.filter(option => !option.label.includes('preview')))('$label does not add a hidden CARTO raster layer', option => {
    expect(getPreviewBasemapUrl(option.value)).toBeNull();
    expect(getPreviewBasemapUrl(`https://example.com/tangram.gl/examples/classic/${option.value}`)).toBeNull();
  });

  test.each([
    ['local-tron.yaml', 'dark_all'],
    ['local-basemap.yaml', 'light_all'],
    ['crosshatch-preview.yaml', 'light_all']
  ])('retains raster context only for %s', (name, style) => {
    expect(getPreviewBasemapUrl(`styles/${name}`)).toContain(`/${style}/`);
    expect(getPreviewBasemapUrl(`https://example.com/styles/${name}?v=1#map`)).toContain(`/${style}/`);
  });

  test('does not mistake unrelated URLs or inline scenes for local previews', () => {
    expect(getPreviewBasemapUrl('https://example.com/custom.yaml?scene=styles/local-tron.yaml')).toBeNull();
    expect(getPreviewBasemapUrl({sources: {}})).toBeNull();
    expect(getPreviewBasemapUrl(null)).toBeNull();
  });
});
