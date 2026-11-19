// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {readFileSync} from 'node:fs';
import {describe, expect, test} from 'vitest';
import {BODY_BASEMAPS, type BodyBasemap, type BodyBasemapId} from '../src/bodies';

/**
 * The CRS code and the semi-major axis (metres) of each body. IAU 2015 values: the
 * pdssp/planet_crs_registry GML definitions at commit e25c0fb5 (data/gml/IAU_2015_<code>.xml).
 * Earth: the WGS 84 ellipsoid, EPSG:7030.
 */
const EXPECTED: Record<BodyBasemapId, {crs: string; radius: number}> = {
  mercury: {crs: 'IAU_2015:19900', radius: 2440530},
  venus: {crs: 'IAU_2015:29900', radius: 6051800},
  earth: {crs: 'EPSG:4326', radius: 6378137},
  moon: {crs: 'IAU_2015:30100', radius: 1737400},
  mars: {crs: 'IAU_2015:49900', radius: 3396190}
};

const NAMES = 'Names: IAU/USGS Gazetteer of Planetary Nomenclature (public domain).';

/** The attribution strings, character for character as the solar-system example shows them. */
const CREDITS: Record<BodyBasemapId, {raster?: string; vector: string}> = {
  mercury: {
    raster: 'MESSENGER MDIS: NASA/JHUAPL/Carnegie Institution of Washington (via NASA Mercury Trek).',
    vector: `4 km contours from the USGS MESSENGER global DEM 665 m v2 (public domain); crater rims from the gazetteer centres and diameters. ${NAMES}`
  },
  venus: {vector: `Crater rims from the gazetteer centres and diameters. ${NAMES}`},
  earth: {
    raster: 'NASA Blue Marble shaded relief and bathymetry (NASA GIBS).',
    vector: 'OpenFreeMap "liberty" style, © OpenMapTiles, data © OpenStreetMap contributors (ODbL).'
  },
  moon: {
    raster: 'LROC WAC: NASA/GSFC/Arizona State University (via NASA Moon Trek).',
    vector: `Maria, crater rim crests and basin rings: USGS Unified Geologic Map of the Moon 1:5M, Fortezzo et al. 2020 (CC0). ${NAMES}`
  },
  mars: {
    raster: 'Viking MDIM 2.1: NASA/JPL/USGS (via NASA Mars Trek).',
    vector: `Geologic units by age: USGS SIM 3292, Geologic Map of Mars, Tanaka et al. 2014 (public domain); crater rims from the gazetteer centres and diameters. ${NAMES}`
  }
};

/** The dataset licences, as the publishers state them. */
const DATASET_LICENCES: Record<string, string> = {
  'IAU/USGS Gazetteer of Planetary Nomenclature': 'Public domain',
  'USGS MESSENGER global DEM 665 m v2': 'US public domain ("please cite authors")',
  'USGS Unified Geologic Map of the Moon 1:5M (Fortezzo et al., 2020)': 'CC0 ("please cite authors")',
  'USGS SIM 3292, Geologic Map of Mars (Tanaka et al., 2014)': 'US public domain'
};

const IDS = Object.keys(EXPECTED) as BodyBasemapId[];
const entries = (): [BodyBasemapId, BodyBasemap][] => IDS.map(id => [id, BODY_BASEMAPS[id]]);

describe('BODY_BASEMAPS', () => {
  test('has exactly the five bodies, each under its own id', () => {
    expect(Object.keys(BODY_BASEMAPS).sort()).toEqual([...IDS].sort());
    for (const [id, body] of entries()) {
      expect(body.id).toBe(id);
      expect(body.label).toBe(id[0].toUpperCase() + id.slice(1));
    }
  });

  test.each(IDS)('%s has the CRS code and the semi-major axis of that CRS, in metres', id => {
    expect(BODY_BASEMAPS[id].crs).toBe(EXPECTED[id].crs);
    expect(BODY_BASEMAPS[id].radius).toBe(EXPECTED[id].radius);
    expect(BODY_BASEMAPS[id].radiusSource).toMatch(id === 'earth' ? /EPSG:7030/ : /IAU 2015/);
  });

  test.each(IDS)('%s keeps the exact credits', id => {
    const body = BODY_BASEMAPS[id];
    expect(body.raster?.credit).toBe(CREDITS[id].raster);
    expect(body.vector.credit).toBe(CREDITS[id].vector);
  });

  test('every raster source has a licence and a usable template', () => {
    for (const [id, body] of entries()) {
      if (!body.raster) {
        expect(id).toBe('venus');
        continue;
      }
      expect(body.raster.licence).toBe('NASA, no restriction');
      expect(body.raster.tiles).toMatch(/^https:\/\//);
      for (const placeholder of ['{z}', '{x}', '{y}']) {
        expect(body.raster.tiles.split(placeholder)).toHaveLength(2);
      }
      expect(body.raster.tiles).not.toMatch(/\{(row|col)\}/);
      expect(body.raster.grid).toBe(id === 'earth' ? 'web-mercator' : 'geographic');
      expect(body.raster.label.length).toBeGreaterThan(0);
    }
  });

  test('every vector source names its licence', () => {
    for (const [id, body] of entries()) {
      const vector = body.vector;
      switch (vector.type) {
        case 'style':
          expect(id).toBe('earth');
          expect(vector.url).toBe('https://tiles.openfreemap.org/styles/liberty');
          expect(vector.licence).toBe('Data © OpenStreetMap contributors (ODbL), © OpenMapTiles');
          break;
        case 'datasets':
          expect(vector.datasets.map(dataset => dataset.label)).toContain(
            'IAU/USGS Gazetteer of Planetary Nomenclature'
          );
          for (const dataset of vector.datasets) {
            expect(dataset.licence).toBe(DATASET_LICENCES[dataset.label]);
            expect(dataset.url).toMatch(/^https:\/\//);
          }
          break;
        default:
          throw new Error(`unknown vector source ${(vector as {type: string}).type}`);
      }
    }
    expect(BODY_BASEMAPS.venus.vector).toMatchObject({type: 'datasets'});
    expect(BODY_BASEMAPS.moon.vector.type === 'datasets' && BODY_BASEMAPS.moon.vector.datasets).toHaveLength(2);
  });

  test('is frozen at every depth', () => {
    const unfrozen: string[] = [];
    const visit = (value: unknown, path: string) => {
      if (value && typeof value === 'object') {
        if (!Object.isFrozen(value)) unfrozen.push(path);
        for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`);
      }
    };
    visit(BODY_BASEMAPS, 'BODY_BASEMAPS');
    expect(unfrozen).toEqual([]);
    expect(() => {
      (BODY_BASEMAPS.moon as {radius: number}).radius = 1;
    }).toThrow(TypeError);
    expect(() => {
      (BODY_BASEMAPS.mars.raster as {credit: string}).credit = '';
    }).toThrow(TypeError);
    expect(BODY_BASEMAPS.moon.radius).toBe(1737400);
  });

  test('the entry imports nothing, so it adds no dependency to a bundle', () => {
    const source = readFileSync(new URL('../src/bodies.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(source).not.toMatch(/\bimport\b|\brequire\s*\(/);
  });

  test('the package exports the entry and builds its declarations and bundles', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(packageJson.exports['./bodies']).toEqual({
      types: './dist/types/bodies.d.ts',
      require: './dist/bodies.cjs',
      import: './dist/bodies.js',
      default: './dist/bodies.js'
    });
    expect(packageJson.scripts['build:types']).toMatch(/\sbodies\.ts(\s|$)/);
    expect(packageJson.scripts['build:bundle']).toContain('src/bodies.ts --env=dev --format=esm --output=dist/bodies.js');
    expect(packageJson.scripts['build:bundle']).toContain('src/bodies.ts --env=dev --format=cjs --output=dist/bodies.cjs');
  });
});
