// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';
import {describe, expect, test} from 'vitest';
import {generateTile} from '../examples/layers/basemap-made-up-world/world/tile';
import {buildWorld, heightAt} from '../examples/layers/basemap-made-up-world/world/world';

/** The part of a decoded `@mapbox/vector-tile` layer that the tests read. */
type DecodedLayer = {
  length: number;
  feature(index: number): {
    type: number;
    properties: Record<string, unknown>;
    toGeoJSON(x: number, y: number, z: number): {geometry: {type: string}};
  };
};

const decodeLayers = (bytes: Uint8Array) =>
  new VectorTile(new Pbf(bytes)).layers as Record<string, DecodedLayer>;

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

const TILES: [number, number, number][] = [
  [0, 0, 0],
  [2, 1, 1],
  [5, 9, 13],
  [9, 300, 190],
  [12, 2500, 1700]
];

describe('made-up world example', () => {
  test('the same seed gives the same tile bytes, from two separate builds', () => {
    const a = buildWorld({seed: 42});
    const b = buildWorld({seed: 42});
    for (const [z, x, y] of TILES) {
      const tileA = generateTile(a, z, x, y);
      expect(tileA.length, `tile ${z}/${x}/${y}`).toBeGreaterThan(0);
      expect(sameBytes(tileA, generateTile(b, z, x, y)), `tile ${z}/${x}/${y}`).toBe(true);
    }
  });

  test('two seeds give different tiles', () => {
    const a = buildWorld({seed: 42});
    const b = buildWorld({seed: 7});
    for (const [z, x, y] of TILES.slice(0, 3)) {
      expect(sameBytes(generateTile(a, z, x, y), generateTile(b, z, x, y)), `tile ${z}/${x}/${y}`).toBe(
        false
      );
    }
  });

  test('another sea level gives different tiles', () => {
    const a = buildWorld({seed: 42, seaLevel: 0});
    const b = buildWorld({seed: 42, seaLevel: 0.1});
    expect(sameBytes(generateTile(a, 2, 1, 1), generateTile(b, 2, 1, 1))).toBe(false);
  });

  test('the terrain has no seam at the antimeridian', () => {
    const world = buildWorld({seed: 42});
    for (const latitude of [-60, -10, 0, 33, 70]) {
      expect(heightAt(world, 179.9999, latitude)).toBeCloseTo(heightAt(world, -180.0001, latitude), 3);
      expect(heightAt(world, 12.3, latitude)).toBeCloseTo(heightAt(world, 12.3 + 360, latitude), 6);
    }
  });

  test('tiles decode as vector tiles with OpenMapTiles source layers', () => {
    const layers = decodeLayers(generateTile(buildWorld({seed: 42}), 2, 1, 1));
    expect(Object.keys(layers)).toEqual(
      expect.arrayContaining(['water', 'waterway', 'landcover', 'place', 'water_name'])
    );
    const classes = new Set<string>();
    for (let index = 0; index < layers.water.length; index++) {
      const feature = layers.water.feature(index);
      expect(feature.type).toBe(3);
      classes.add(String(feature.properties.class));
      expect(['Polygon', 'MultiPolygon']).toContain(feature.toGeoJSON(1, 1, 2).geometry.type);
    }
    expect(classes.has('ocean')).toBe(true);
    const place = layers.place.feature(0);
    expect(typeof place.properties.name).toBe('string');
    expect(['city', 'town', 'village']).toContain(place.properties.class);
  });
});
