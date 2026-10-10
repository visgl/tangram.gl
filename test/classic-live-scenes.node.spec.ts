// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {readFileSync} from 'node:fs';
import {posix} from 'node:path';
import {describe, expect, test} from 'vitest';
import {DEFAULT_SCENE, SCENE_OPTIONS, SCENE_ALIASES, SCENE_DESCRIPTIONS, getSceneOverview} from '../examples/classic/app/scene-catalog.js';
import {OPENFREEMAP_ATTRIBUTION, OPENFREEMAP_TILEJSON} from '../examples/classic/app/vector-providers.js';
import {BLUE_MARBLE_URL, BLUE_MARBLE_ATTRIBUTION, createBlueMarbleScene} from '../examples/classic/app/nasa-basemap.js';
import {parseSceneYamlLegacy} from '../modules/tangram-renderer/src/procedures/scene-yaml-legacy';
import mergeObjects from '../modules/tangram-renderer/src/utils/merge';
import {getPropertyPath} from '../modules/tangram-renderer/src/utils/props';
import type {SceneDefinition} from '../modules/tangram-renderer/src/scene/scene-resource-types';

/** Read a checked-in classic scene without depending on generated package bundles. */
function readScene(name: string): SceneDefinition {
  return parseSceneYamlLegacy(readFileSync(new URL(`../examples/classic/styles/${name}`, import.meta.url), 'utf8')) as SceneDefinition;
}

/** Read dynamic scene fields without assigning a uniform shape to different styles. */
function sceneValue(scene: SceneDefinition, path: string): unknown {
  return getPropertyPath(scene, path.split('.'));
}

test('the selectable classic NASA scene agrees with the shared basemap definition and opens at world scale', () => {
  const scene = readScene('nasa-blue-marble.yaml');
  expect(sceneValue(scene, 'sources.blueMarble')).toEqual({type: 'Raster', url: BLUE_MARBLE_URL,
    max_zoom: 8, attribution: BLUE_MARBLE_ATTRIBUTION});
  expect(scene.layers).toEqual(createBlueMarbleScene().layers);
  expect(SCENE_OPTIONS.some(option => option.value === 'styles/nasa-blue-marble.yaml')).toBe(true);
  expect(getSceneOverview('styles/nasa-blue-marble.yaml')).toEqual([2, 0, 0]);
});

test.each(['examples/deck/index.html', 'examples/webxr/index.html', 'website/src/components/DeckExample.js',
  'website/src/components/WebXRExample.js'])('the %s basemap controls offer NASA and no longer offer CARTO', pathname => {
  const source = readFileSync(new URL(`../${pathname}`, import.meta.url), 'utf8');
  expect(source).toContain('<option value="blueMarbleRaster">NASA Blue Marble</option>');
  expect(source).not.toContain('<option value="carto">');
  expect(source).not.toContain('<option value="positronRaster">');
});

/** Require a fixture's dynamic object before enumerating its keys. */
function sceneRecord(scene: SceneDefinition, path: string): object {
  const value = sceneValue(scene, path);
  if (!value || typeof value !== 'object') throw new Error(`Missing fixture object: ${path}`);
  return value;
}

/** Merge local scene imports without requesting hosted style archives or remote tiles. */
function readImportedScene(name: string): ReturnType<typeof readScene> {
  const scene = readScene(name);
  let inherited: ReturnType<typeof readScene> = {};
  const imports = typeof scene.import === 'string' ? [scene.import] : Array.isArray(scene.import) ? scene.import : [];
  for (const imported of imports) {
    if (typeof imported === 'string' && !imported.startsWith('https://') && imported.endsWith('.yaml')) {
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
    expect(sceneValue(scene, 'styles.projection-morph')).toMatchObject({base: 'polygons', mix: 'albers-projection'});
    expect(sceneValue(scene, 'styles.state-borders')).toMatchObject({base: 'lines', mix: 'albers-projection'});
    expect(sceneValue(scene, 'styles.albers-projection.shaders.blocks.position')).toContain('latlon2albers');
    expect(sceneValue(scene, 'styles.albers-projection.animated')).toBe(true);
    expect(sceneValue(scene, 'styles.albers-projection.shaders.blocks.global')).toContain('u_time');
    expect(sceneValue(scene, 'styles.albers-projection.shaders.defines.MORPH_PERIOD')).toBe(12);
    expect(sceneValue(scene, 'sources.states.url')).toBe('../data/us-states-10m.json');
  });
  test('starts with full TRON and routes both live choices through their compatibility wrapper', () => {
    expect(DEFAULT_SCENE).toBe('styles/tron.yaml');
    expect(SCENE_OPTIONS.slice(0, 2)).toEqual([
      {label: 'TRON (OpenFreeMap)', value: 'styles/tron.yaml'},
      {label: 'Crosshatch (OpenFreeMap)', value: 'styles/crosshatch.yaml'}
    ]);
    for (const name of ['tron.yaml', 'crosshatch.yaml']) {
      const imports = readScene(name).import;
      expect(Array.isArray(imports) ? imports.at(-1) : imports).toBe('openmaptiles-mapzen-compat.yaml');
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

  // The standalone terrain POC uses its own OpenFreeMap overlay source, tested separately below.
  test.each(SCENE_OPTIONS.filter(option => !['projection-morph.yaml', 'nasa-blue-marble.yaml', 'mapterhorn.yaml'].some(name => option.value.endsWith(name))))('$label uses OpenFreeMap vector tiles and provider credits', option => {
    const scene = readImportedScene(option.value.replace('styles/', ''));
    for (const name of ['mapzen', 'tilezen']) {
      expect(sceneValue(scene, `sources.${name}`)).toMatchObject({type: 'MVT', url: '', url_params: null, tilejson: OPENFREEMAP_TILEJSON});
      expect(sceneValue(scene, `sources.${name}.attribution`)).toContain('OpenFreeMap');
      expect(sceneValue(scene, `sources.${name}.attribution`)).toContain('OpenMapTiles');
      expect(sceneValue(scene, `sources.${name}.attribution`)).toContain('OpenStreetMap');
    }
    for (const source of Object.values(scene.sources!)) {
      expect(String(source.url || '')).not.toMatch(/basemaps\.cartocdn\.com|tile\.openstreetmap\.org/);
    }
  });

  test.each([
    'local-tron.yaml', 'local-basemap.yaml', 'crosshatch-preview.yaml'
  ])('keeps the finite fixture above the vector basemap in %s', name => {
    const scene = readImportedScene(name);
    expect(sceneValue(scene, 'sources.preview.type')).toBe('GeoJSON');
    // Hosted style archives are deliberately not fetched by this hermetic test.
    // Fixture-only layers must not shadow their imported basemap layer names.
    expect(Object.keys(sceneRecord(readScene(name), 'layers'))).toEqual(['preview-land', 'preview-buildings', 'preview-roads']);
    for (const layer of ['preview-land', 'preview-buildings', 'preview-roads']) {
      expect(sceneValue(scene, `layers.${layer}.data.source`)).toBe('preview');
    }
    const landStyle = Object.keys(sceneRecord(scene, 'layers.preview-land.draw'))[0];
    expect(sceneValue(scene, `styles.${landStyle}.blend`)).toBe('overlay');
  });

  test('does not mount a second Leaflet raster basemap behind the renderer', () => {
    const main = readFileSync(new URL('../examples/classic/main.js', import.meta.url), 'utf8');
    expect(main).not.toContain('L.tileLayer(');
    expect(main).not.toContain('getPreviewBasemapUrl');
  });

  test('the crosshatch overlay reuses its canonical scene wrapper', () => {
    expect(readScene('crosshatch-preview.yaml').import).toBe('crosshatch.yaml');
    expect(sceneValue(readScene('crosshatch-preview.yaml'), 'styles.preview-crosshatch')).toBeDefined();
  });
});
