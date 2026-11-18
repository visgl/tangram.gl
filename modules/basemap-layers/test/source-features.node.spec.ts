// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test, vi} from 'vitest';
import {BasemapLayer} from '../src/basemap-layer';
import {querySourceFeaturesInTiles, type QueriedTile} from '../src/source-features';

const VECTOR = {type: 'vector', tiles: ['https://tiles.example.com/{z}/{x}/{y}.mvt']};
const GEOJSON = {type: 'geojson', data: {type: 'FeatureCollection', features: []}};

function point(layerName: string | null, coordinates: number[], props = {}, id?: unknown) {
  return {
    type: 'Feature',
    ...(id === undefined ? {} : {id}),
    properties: layerName === null ? {...props} : {layerName, ...props},
    geometry: {type: 'Point', coordinates}
  };
}

function tile(x: number, y: number, z: number, content: unknown, isLoaded = true): QueriedTile {
  return {index: {x, y, z}, isLoaded, content};
}

describe('querySourceFeaturesInTiles', () => {
  test('returns the features of one source layer in longitude and latitude', () => {
    const tiles = [
      tile(1, 0, 1, [
        point('place', [0.5, 0.5], {name: 'A'}, 7),
        point('road', [0.5, 0.5], {name: 'R'}),
        point('place', [0, 1], {name: 'B'})
      ])
    ];
    const features = querySourceFeaturesInTiles(tiles, 'carto', VECTOR, {sourceLayer: 'place'});
    expect(features.map(f => f.properties)).toEqual([{name: 'A'}, {name: 'B'}]);
    expect(features[0]).toMatchObject({
      type: 'Feature',
      id: 7,
      source: 'carto',
      sourceLayer: 'place',
      tile: {x: 1, y: 0, z: 1}
    });
    // The center of tile 1/1/0 is at 90E, 66.51N; its bottom-left corner at 0, 0.
    const [lng, lat] = features[0].geometry.coordinates as number[];
    expect(lng).toBeCloseTo(90, 9);
    expect(lat).toBeCloseTo(66.51326, 4);
    const [lng0, lat0] = features[1].geometry.coordinates as number[];
    expect(lng0).toBeCloseTo(0, 9);
    expect(lat0).toBeCloseTo(0, 9);
    expect('id' in features[1]).toBe(false);
  });

  test('converts every position of lines and polygons, and keeps extra values', () => {
    const polygon = {
      type: 'Feature',
      properties: {layerName: 'water'},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0, 5],
            [1, 0, 5],
            [1, 1, 5],
            [0, 0, 5]
          ]
        ]
      }
    };
    const [feature] = querySourceFeaturesInTiles([tile(0, 0, 0, [polygon])], 'carto', VECTOR, {
      sourceLayer: 'water'
    });
    const ring = (feature.geometry.coordinates as number[][][])[0];
    expect(ring[0][0]).toBeCloseTo(-180, 9);
    expect(ring[0][1]).toBeCloseTo(85.0511287, 6);
    expect(ring[2][0]).toBeCloseTo(180, 9);
    expect(ring[2][1]).toBeCloseTo(-85.0511287, 6);
    expect(ring[0][2]).toBe(5);
    // The tile content is not changed.
    expect(polygon.geometry.coordinates[0][1]).toEqual([1, 0, 5]);
  });

  test('a vector source without a source layer returns no features, as in MapLibre', () => {
    const tiles = [tile(0, 0, 0, [point('place', [0.5, 0.5]), point(null, [0.5, 0.5])])];
    expect(querySourceFeaturesInTiles(tiles, 'carto', VECTOR)).toEqual([]);
    expect(querySourceFeaturesInTiles(tiles, 'carto', VECTOR, {sourceLayer: ''})).toEqual([]);
  });

  test('a geojson source ignores the source layer', () => {
    const tiles = [tile(0, 0, 0, [point(null, [0.5, 0.5], {name: 'A'}, 3)])];
    for (const options of [{}, {sourceLayer: 'anything'}]) {
      const features = querySourceFeaturesInTiles(tiles, 'points', GEOJSON, options);
      expect(features).toHaveLength(1);
      expect(features[0]).toMatchObject({id: 3, properties: {name: 'A'}, source: 'points'});
      expect('sourceLayer' in features[0]).toBe(false);
    }
  });

  test('applies a style-spec filter, with the zoom of the tile', () => {
    const content = [
      point('place', [0.2, 0.2], {rank: 1}),
      point('place', [0.4, 0.4], {rank: 5}),
      {
        type: 'Feature',
        properties: {layerName: 'place', rank: 1},
        geometry: {
          type: 'LineString',
          coordinates: [
            [0, 0],
            [1, 1]
          ]
        }
      }
    ];
    const query = (filter: unknown[], z = 3) =>
      querySourceFeaturesInTiles([tile(0, 0, z, content)], 'carto', VECTOR, {
        sourceLayer: 'place',
        filter
      });
    expect(query(['<', ['get', 'rank'], 3])).toHaveLength(2);
    expect(query(['all', ['<', ['get', 'rank'], 3], ['==', ['geometry-type'], 'Point']])).toHaveLength(1);
    // The decoder's own `layerName` property is not visible to the filter.
    expect(query(['has', 'layerName'])).toHaveLength(0);
    expect(query(['==', ['zoom'], 3], 3)).toHaveLength(3);
    expect(query(['==', ['zoom'], 3], 4)).toHaveLength(0);
  });

  test('an invalid filter matches no features', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tiles = [tile(0, 0, 0, [point('place', [0.5, 0.5])])];
    expect(
      querySourceFeaturesInTiles(tiles, 'carto', VECTOR, {
        sourceLayer: 'place',
        filter: ['no-such-operator', 1]
      })
    ).toEqual([]);
    warn.mockRestore();
  });

  test('reads a tile once, also as a copy of the world, and skips tiles that have not loaded', () => {
    const content = [point('place', [0.5, 0.5], {}, 1)];
    const tiles = [
      tile(1, 1, 1, content),
      tile(1, 1, 1, content),
      // Tile 1/-1/1 of the copy of the world to the west is tile 1/1/1.
      tile(-1, 1, 1, content),
      tile(0, 1, 1, [point('place', [0.5, 0.5], {}, 2)], false),
      tile(0, 0, 1, null)
    ];
    const features = querySourceFeaturesInTiles(tiles, 'carto', VECTOR, {sourceLayer: 'place'});
    expect(features.map(f => f.tile)).toEqual([{x: 1, y: 1, z: 1}]);
    expect((features[0].geometry.coordinates as number[])[0]).toBeCloseTo(90, 9);
  });

  test('a feature in two tiles is returned once per tile, as in MapLibre', () => {
    const tiles = [
      tile(1, 0, 1, [point('place', [0.999, 0.5], {}, 9)]),
      tile(0, 0, 1, [point('place', [0.001, 0.5], {}, 9)])
    ];
    const features = querySourceFeaturesInTiles(tiles, 'carto', VECTOR, {sourceLayer: 'place'});
    // Tiles are read in order of zoom, row and column.
    expect(features.map(f => [f.id, f.tile.x])).toEqual([
      [9, 0],
      [9, 1]
    ]);
  });

  test('takes the id from promoteId, as a name or a name per source layer', () => {
    const tiles = [tile(0, 0, 0, [point('place', [0.5, 0.5], {osm: 'n1', flag: true}, 4)])];
    const query = (promoteId: unknown) =>
      querySourceFeaturesInTiles(tiles, 'carto', {...VECTOR, promoteId}, {sourceLayer: 'place'})[0];
    expect(query(undefined).id).toBe(4);
    expect(query('osm').id).toBe('n1');
    expect(query({place: 'osm'}).id).toBe('n1');
    expect(query('flag').id).toBe(1);
    // A source layer without a name has no id, as in MapLibre.
    expect('id' in query({road: 'osm'})).toBe(false);
  });
});

describe('BasemapLayer.querySourceFeatures', () => {
  function layerWithTiles(sources: Record<string, any>, visibleTiles: QueriedTile[]) {
    const layer = new BasemapLayer({id: 'basemap', style: null} as any);
    layer.initializeState();
    layer.state.resolvedStyle = {version: 8, sources, layers: []} as any;
    for (const source of Object.values(sources)) {
      layer.state.tilesets.set(source, {visibleTiles} as any);
    }
    return layer;
  }

  test("reads the drawn tiles of the source's tileset", () => {
    const carto = {...VECTOR};
    const layer = layerWithTiles({carto}, [tile(0, 0, 0, [point('place', [0.5, 0.5], {n: 1})])]);
    expect(layer.querySourceFeatures('carto', {sourceLayer: 'place'})).toMatchObject([
      {source: 'carto', sourceLayer: 'place', properties: {n: 1}}
    ]);
  });

  test('an unknown source, a raster source, or no style returns no features', () => {
    const raster = {type: 'raster', tiles: ['https://tiles.example.com/{z}/{x}/{y}.png']};
    const layer = layerWithTiles({raster}, [tile(0, 0, 0, [point('place', [0.5, 0.5])])]);
    expect(layer.querySourceFeatures('raster', {sourceLayer: 'place'})).toEqual([]);
    expect(layer.querySourceFeatures('missing', {sourceLayer: 'place'})).toEqual([]);
    const empty = new BasemapLayer({id: 'empty', style: null} as any);
    expect(empty.querySourceFeatures('carto', {sourceLayer: 'place'})).toEqual([]);
    empty.initializeState();
    expect(empty.querySourceFeatures('carto', {sourceLayer: 'place'})).toEqual([]);
  });
});
