// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {readFileSync, statSync} from 'node:fs';
import {expect, test} from 'vitest';
import {parseSceneYamlLegacy} from '../modules/tangram-renderer/src/procedures/scene-yaml-legacy';
import {getPropertyPath} from '../modules/tangram-renderer/src/utils/props';
import {SCENE_OPTIONS, getSceneOverview} from '../examples/classic/app/scene-catalog.js';

/** Parse the real POC definition without fetching any public service. */
const scene = parseSceneYamlLegacy(readFileSync(new URL('../examples/classic/styles/mapterhorn.yaml', import.meta.url), 'utf8'));
if (!scene || typeof scene !== 'object') throw new Error('Missing terrain scene fixture');

test('terrain POC configures Terrarium WebP heights separately from OpenFreeMap vector overlays', () => {
  expect(getPropertyPath(scene, ['sources', 'elevation'])).toEqual({type: 'Raster',
    url: 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp', tile_size: 512, max_zoom: 12,
    filtering: 'nearest', attribution: '<a href="https://mapterhorn.com/attribution">© Mapterhorn</a>'});
  expect(getPropertyPath(scene, ['sources', 'basemap', 'tilejson'])).toBe('https://tiles.openfreemap.org/planet');
  expect(getPropertyPath(scene, ['sources', 'basemap', 'attribution'])).toContain('OpenStreetMap');
  expect(getPropertyPath(scene, ['styles', 'mapterhorn-hillshade', 'base'])).toBe('raster');
  expect(getPropertyPath(scene, ['styles', 'mapterhorn-hillshade', 'lighting'])).toBe(false);
  expect(getPropertyPath(scene, ['styles', 'mapterhorn-hillshade', 'shaders', 'defines', 'TANGRAM_WORLD_POSITION_WRAP'])).toBe(false);
  expect(getPropertyPath(scene, ['styles', 'mapterhorn-hillshade', 'shaders', 'blocks', 'global'])).toContain('vec3(256., 1., 1. / 256.)');
  expect(getPropertyPath(scene, ['sources', 'normals'])).toBeUndefined();
  expect(SCENE_OPTIONS.some(option => option.value === 'styles/mapterhorn.yaml')).toBe(true);
  expect(getSceneOverview('styles/mapterhorn.yaml')).toEqual([10, 46.6, 8.0]);
});

test('overview credits use local official assets and preserve project links and map attribution guidance', () => {
  const overview = readFileSync(new URL('../docs/README.md', import.meta.url), 'utf8');
  const provenance = readFileSync(new URL('../website/static/img/credits/README.md', import.meta.url), 'utf8');
  for (const [name, filename] of [['Tangram', 'tangram.png'], ['Mapzen', 'mapzen.png'],
    ['OpenFreeMap', 'openfreemap.jpg'], ['Mapterhorn', 'mapterhorn.png']]) {
    expect(overview).toContain(`alt="${name}"`);
    expect(overview).toContain(`/tangram.gl/img/credits/${filename}`);
    expect(statSync(new URL(`../website/static/img/credits/${filename}`, import.meta.url)).size).toBeGreaterThan(100);
    expect(provenance).toContain(filename);
  }
  expect(overview).toContain('do not replace');
  expect(overview).toContain('developer-guide/tile-providers.md');
});
