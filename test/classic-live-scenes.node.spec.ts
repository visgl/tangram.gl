// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {readFileSync} from 'node:fs';
import {posix} from 'node:path';
import {describe, expect, test} from 'vitest';
import {DEFAULT_SCENE, SCENE_OPTIONS, SCENE_ALIASES, SCENE_DESCRIPTIONS, getSceneOverview} from '../examples/classic/app/scene-catalog.js';
import {OPENFREEMAP_ATTRIBUTION, OPENFREEMAP_TILEJSON} from '../examples/classic/app/vector-providers.js';
import {parseSceneYamlLegacy} from '../modules/tangram-renderer/src/procedures/scene-yaml-legacy';
import mergeObjects from '../modules/tangram-renderer/src/utils/merge';

/** Read a checked-in classic scene without depending on generated package bundles. */
function readScene(name: string) {
  return parseSceneYamlLegacy(readFileSync(new URL(`../examples/classic/styles/${name}`, import.meta.url), 'utf8'));
}

/** Merge local scene imports without requesting hosted style archives or remote tiles. */
function readImportedScene(name: string): ReturnType<typeof readScene> {
  const scene = readScene(name);
  let inherited: ReturnType<typeof readScene> = {};
  const imports = typeof scene.import === 'string' ? [scene.import] : scene.import || [];
  for (const imported of imports) {
    if (!imported.startsWith('https://') && imported.endsWith('.yaml')) {
      const importedName = posix.join(posix.dirname(name), imported);
      inherited = mergeObjects(inherited, readImportedScene(importedName));
    }
  }
  return mergeObjects(inherited, scene);
}

describe('classic live style choices', () => {
  test('every selectable scene exists, parses and has an explanatory card', () => {
    for (const option of SCENE_OPTIONS) {
      expect(readScene(option.value.replace('styles/', ''))).toBeTypeOf('object');
      expect(SCENE_DESCRIPTIONS[option.value]).toBeTypeOf('string');
      expect(SCENE_DESCRIPTIONS[option.value].length).toBeGreaterThan(40);
    }
  });

  test.each(['local-basemap.yaml', 'local-tron.yaml', 'crosshatch-preview.yaml',
    'rainbow-buildings.yaml', 'popup-buildings.yaml'])('frames the finite or building example %s at street level', name => {
    expect(getSceneOverview(`https://example.com/styles/${name}?v=1`)).toEqual([16, 40.705, -74.009]);
  });

  test.each(Object.entries(SCENE_ALIASES))('preserves the old link %s as a vector-style alias', (legacy, canonical) => {
    expect(readScene(legacy.replace('styles/', '')).import).toBe(canonical.replace('styles/', ''));
    expect(SCENE_OPTIONS.some(option => option.value === canonical)).toBe(true);
  });
  test('shares one Albers projection block between state fills and borders', () => {
    const scene = readScene('projection-morph.yaml');
    expect(scene.styles['projection-morph']).toMatchObject({base: 'polygons', mix: 'albers-projection'});
    expect(scene.styles['state-borders']).toMatchObject({base: 'lines', mix: 'albers-projection'});
    expect(scene.styles['albers-projection'].shaders.blocks.position).toContain('latlon2albers');
    expect(scene.styles['albers-projection'].animated).toBe(true);
    expect(scene.styles['albers-projection'].shaders.blocks.global).toContain('u_time');
    expect(scene.styles['albers-projection'].shaders.defines.MORPH_PERIOD).toBe(12);
    expect(scene.sources.states.url).toBe('../data/us-states-10m.json');
  });
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
    expect(source.attribution).toBe(OPENFREEMAP_ATTRIBUTION);
  });

  test.each(SCENE_OPTIONS.filter(option => !option.value.endsWith('projection-morph.yaml')))('$label uses OpenFreeMap vector tiles and provider credits', option => {
    const scene = readImportedScene(option.value.replace('styles/', ''));
    for (const name of ['mapzen', 'tilezen']) {
      expect(scene.sources[name]).toMatchObject({type: 'MVT', url: '', url_params: null, tilejson: OPENFREEMAP_TILEJSON});
      expect(scene.sources[name].attribution).toContain('OpenFreeMap');
      expect(scene.sources[name].attribution).toContain('OpenMapTiles');
      expect(scene.sources[name].attribution).toContain('OpenStreetMap');
    }
    for (const source of Object.values(scene.sources) as Record<string, unknown>[]) {
      expect(String(source.url || '')).not.toMatch(/basemaps\.cartocdn\.com|tile\.openstreetmap\.org/);
    }
  });

  test.each([
    'local-tron.yaml', 'local-basemap.yaml', 'crosshatch-preview.yaml'
  ])('keeps the finite fixture above the vector basemap in %s', name => {
    const scene = readImportedScene(name);
    expect(scene.sources.preview.type).toBe('GeoJSON');
    // Hosted style archives are deliberately not fetched by this hermetic test.
    // Fixture-only layers must not shadow their imported basemap layer names.
    expect(Object.keys(readScene(name).layers)).toEqual(['preview-land', 'preview-buildings', 'preview-roads']);
    for (const layer of ['preview-land', 'preview-buildings', 'preview-roads']) {
      expect(scene.layers[layer].data.source).toBe('preview');
    }
    const landStyle = Object.keys(scene.layers['preview-land'].draw)[0];
    expect(scene.styles[landStyle].blend).toBe('overlay');
  });

  test('does not mount a second Leaflet raster basemap behind the renderer', () => {
    const main = readFileSync(new URL('../examples/classic/main.js', import.meta.url), 'utf8');
    expect(main).not.toContain('L.tileLayer(');
    expect(main).not.toContain('getPreviewBasemapUrl');
  });

  test('the crosshatch overlay imports its texture archive directly', () => {
    expect(readScene('crosshatch-preview.yaml').import).toEqual(readScene('crosshatch.yaml').import);
    expect(readScene('crosshatch-preview.yaml').styles['preview-crosshatch']).toBeDefined();
  });
});
