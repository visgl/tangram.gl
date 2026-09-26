// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {MVTWriter} from '@loaders.gl/mvt';
import {parseSceneYamlLegacy} from '../modules/tangram-renderer/src/procedures/scene-yaml-legacy.js';
import {parseSceneYamlWithLoaders} from '../modules/tangram-renderer/src/procedures/scene-yaml-loaders.js';
import {parseMvtWithLegacy} from '../modules/tangram-renderer/src/procedures/mvt-legacy.js';
import {parseMvtWithLoaders} from '../modules/tangram-renderer/src/procedures/mvt-loaders.js';
import {
  projectLngLatToMetersLegacy,
  unprojectMetersToLngLatLegacy
} from '../modules/tangram-renderer/src/procedures/web-mercator-legacy.js';
import {
  projectLngLatToMetersWithMath,
  unprojectMetersToLngLatWithMath
} from '../modules/tangram-renderer/src/procedures/web-mercator-math.js';
import Geo from '../modules/tangram-renderer/src/utils/geo.js';

const CLASSIC_EXAMPLES_DIRECTORY = join(process.cwd(), 'examples/classic');
const EXPECTED_YAML_GAPS = new Map<string, RegExp>([
  ['scene.yaml', /Unexpected trailing content/i],
  ['openmaptiles-mapzen-compat.yaml', /alias/i]
]);

function listYamlFiles(directory: string): string[] {
  return readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== 'dist') {
      return listYamlFiles(path);
    }
    return entry.isFile() && entry.name.endsWith('.yaml') ? [path] : [];
  });
}

describe('vis.gl procedure conformance', () => {
  describe('YAML scene parsing', () => {
    it.each(listYamlFiles(CLASSIC_EXAMPLES_DIRECTORY))(
      'matches the legacy parser for %s',
      filePath => {
        const source = readFileSync(filePath, 'utf8');
        const legacyResult = parseSceneYamlLegacy(source);
        const expectedGap = EXPECTED_YAML_GAPS.get(filePath.split('/').at(-1) || '');
        if (expectedGap) {
          expect(() => parseSceneYamlWithLoaders(source)).toThrow(expectedGap);
        } else {
          expect(parseSceneYamlWithLoaders(source)).toEqual(legacyResult);
        }
      }
    );

    it('documents the loaders.gl anchor and alias compatibility gap', () => {
      const source = 'palette: &palette\n  road: cyan\ncopy: *palette\n';
      expect(parseSceneYamlLegacy(source)).toEqual({
        palette: {road: 'cyan'},
        copy: {road: 'cyan'}
      });
      expect(() => parseSceneYamlWithLoaders(source)).toThrow(/alias/i);
    });

    it('documents the loaders.gl comma-containing plain scalar compatibility gap', () => {
      const source = 'fill: rgba(136, 45, 23, 0.9)\n';
      expect(parseSceneYamlLegacy(source)).toEqual({fill: 'rgba(136, 45, 23, 0.9)'});
      expect(() => parseSceneYamlWithLoaders(source)).toThrow(/trailing content/i);
    });
  });

  describe('MVT parsing', () => {
    const source = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 7,
          geometry: {type: 'Point', coordinates: [0.25, 0.5]},
          properties: {name: 'point', metadata: '{"active":true}'}
        },
        {
          type: 'Feature',
          id: 8,
          geometry: {
            type: 'LineString',
            coordinates: [
              [0.125, 0.25],
              [0.75, 0.875]
            ]
          },
          properties: {name: 'line'}
        },
        {
          type: 'Feature',
          id: 9,
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [0.25, 0.25],
                [0.25, 0.75],
                [0.75, 0.75],
                [0.75, 0.25],
                [0.25, 0.25]
              ]
            ]
          },
          properties: {name: 'polygon'}
        }
      ]
    };
    const tile = MVTWriter.encodeSync(source, {mvt: {layerName: 'roads', extent: 4096}});

    it('matches geometry, layer grouping, feature IDs and properties', () => {
      expect(parseMvtWithLoaders(tile)).toEqual(parseMvtWithLegacy(tile));
    });

    it('matches Tangram parse_json behavior', () => {
      expect(parseMvtWithLoaders(tile, {parseJson: true})).toEqual(
        parseMvtWithLegacy(tile, {parseJson: true})
      );
      expect(parseMvtWithLoaders(tile, {parseJson: ['metadata']})).toEqual(
        parseMvtWithLegacy(tile, {parseJson: ['metadata']})
      );
    });
  });

  describe('Web Mercator projection', () => {
    const locations: Array<[number, number]> = [
      [0, 0],
      [-74.009764, 40.705327],
      [179.9, 10],
      [-122.4194, 85],
      [-180, 0],
      [180, 0],
      [0, -85.051129],
      [0, 85.051129],
      [45, -89.9],
      [-45, 89.9]
    ];

    it.each(locations)('math.gl matches Tangram at [%d, %d]', (longitude, latitude) => {
      const coordinates: [number, number] = [longitude, latitude];
      const legacyMeters = projectLngLatToMetersLegacy(coordinates);
      const mathMeters = projectLngLatToMetersWithMath(coordinates);
      expect(mathMeters[0]).toBeCloseTo(legacyMeters[0], 7);
      expect(mathMeters[1]).toBeCloseTo(legacyMeters[1], 7);

      const legacyLngLat = unprojectMetersToLngLatLegacy(legacyMeters);
      const mathLngLat = unprojectMetersToLngLatWithMath(mathMeters);
      expect(mathLngLat[0]).toBeCloseTo(legacyLngLat[0], 10);
      expect(mathLngLat[1]).toBeCloseTo(legacyLngLat[1], 10);
    });

    it('preserves Tangram north-positive projected Y', () => {
      expect(projectLngLatToMetersWithMath([0, 40])[1]).toBeGreaterThan(0);
      expect(projectLngLatToMetersWithMath([0, -40])[1]).toBeLessThan(0);
    });

    it('uses math.gl in the production API while preserving in-place identity', () => {
      const coordinates = [-74.009764, 40.705327];
      const projected = Geo.latLngToMeters(coordinates);
      expect(projected).toBe(coordinates);
      expect(projected[0]).toBeCloseTo(projectLngLatToMetersLegacy([-74.009764, 40.705327])[0], 7);
      expect(projected[1]).toBeCloseTo(projectLngLatToMetersLegacy([-74.009764, 40.705327])[1], 7);
      expect(Geo.metersToLatLng(projected)).toBe(coordinates);
    });

    it.each([0, 8, 16, 22])('preserves tile selection at zoom %d', zoom => {
      for (const coordinates of locations) {
        const legacyMeters = projectLngLatToMetersLegacy(coordinates);
        const productionCoordinates: number[] = [...coordinates];
        Geo.latLngToMeters(productionCoordinates);
        expect(Geo.tileForMeters(productionCoordinates, zoom)).toEqual(Geo.tileForMeters(legacyMeters, zoom));
      }
    });
  });
});
