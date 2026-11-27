// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, beforeAll, describe, expect, test} from 'vitest';
import {
  _CustomProjectionViewport as CustomProjectionViewport,
  WebMercatorViewport
} from '@deck.gl/core';
import {projectionEngine} from '@math.gl/geospatial/projection';
import {filterRowsOnDrawnTiles, MVTLabelLayer} from '../src/mvt-label-layer';
import {isPositionDrawn} from '../src/projected-viewport';

type CRS = ConstructorParameters<typeof CustomProjectionViewport>[0]['crs'];

let utm: CRS;
let southPolar: CRS;

beforeAll(async () => {
  utm = await projectionEngine.getCRS('EPSG:32632');
  southPolar = await projectionEngine.getCRS(
    '+proj=stere +lat_0=-90 +lat_ts=-71 +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs'
  );
});

/** A view using UTM zone 32N, whose rendering extent spans 21°W to 39°E. */
const createUtmViewport = () =>
  new CustomProjectionViewport({crs: utm, center: [9, 50, 0], zoom: 4, width: 1000, height: 700});

const point = (name: string, coordinates: number[]) => ({
  type: 'Feature',
  properties: {name},
  geometry: {type: 'Point', coordinates}
});

function createLayer(viewport: unknown) {
  const layer = new MVTLabelLayer({
    id: 'labels',
    config: {labels: true},
    zoom: 4,
    styleLayer: {layout: {'text-field': '{name}'}}
  });
  layer.context = {viewport} as never;
  return layer;
}

const getNames = (rows: unknown[]) =>
  (rows as {__source: {object: {properties: {name: string}}}}[]).map(
    row => row.__source.object.properties.name
  );

describe('labels in a projected view', () => {
  // math.gl draws a position outside the area of use of a projection on the edge of that area.
  const features = [
    point('Stuttgart', [9.18, 48.78]),
    point('Tbilisi', [44.79, 41.72]),
    point('Reykjavík', [-21.94, 64.15]),
    point('Hamburg', [9.99, 53.55]),
    point('Recife', [-34.88, -8.05])
  ];

  test('a label outside the area of use of the projection has no row', () => {
    const rows = createLayer(createUtmViewport()).getLabelData(features as never, true);
    expect(getNames(rows)).toEqual(['Stuttgart', 'Hamburg']);
  });

  test('a Web Mercator view keeps every label', () => {
    const viewport = new WebMercatorViewport({longitude: 9, latitude: 50, zoom: 4, width: 1000, height: 700});
    expect(getNames(createLayer(viewport).getLabelData(features as never, true))).toHaveLength(5);
    expect(getNames(createLayer(undefined).getLabelData(features as never, true))).toHaveLength(5);
    // Only a projected view is checked: a view of another kind that returns other positions
    // keeps its labels.
    const other = {projectionMode: 1, projectPosition: () => [0, 0, 0], unprojectPosition: () => [0, 0, 0]};
    expect(getNames(createLayer(other).getLabelData(features as never, true))).toHaveLength(5);
  });

  test('the rows of a tile depend on the projection of the view', () => {
    const projected = createLayer(createUtmViewport()).getAnchorKey(true);
    const map = createLayer(new WebMercatorViewport({width: 8, height: 8})).getAnchorKey(true);
    expect(projected).not.toBe(map);
    expect(projected).toContain('EPSG:32632');
    expect(map).not.toContain('EPSG:32632');
  });
});

describe('isPositionDrawn', () => {
  test('is true where the projection draws the position at its own place', () => {
    const viewport = createUtmViewport();
    expect(isPositionDrawn(viewport, [9.18, 48.78])).toBe(true);
    expect(isPositionDrawn(viewport, [-20.999, -85])).toBe(true);
    expect(isPositionDrawn(viewport, [38.999, 85])).toBe(true);
    // Positions beyond either longitude limit are moved to the edge.
    expect(isPositionDrawn(viewport, [44.79, 41.72])).toBe(false);
    expect(isPositionDrawn(viewport, [-21.001, -85])).toBe(false);
    expect(isPositionDrawn(viewport, [39.001, 85])).toBe(false);
  });

  test('is false where the projection has no position or fails', () => {
    const none = {projectPosition: () => [Number.NaN, 0, 0], unprojectPosition: () => [Number.NaN, 0, 0]};
    expect(isPositionDrawn(none, [9, 50])).toBe(false);
    const failing = {
      projectPosition: () => {
        throw new Error('assertion failed');
      },
      unprojectPosition: () => [9, 50, 0]
    };
    expect(isPositionDrawn(failing, [9, 50])).toBe(false);
    // A longitude a turn away is the same position.
    const turned = {projectPosition: (p: number[]) => p, unprojectPosition: (p: number[]) => [p[0] + 360, p[1], 0]};
    expect(isPositionDrawn(turned, [9, 50])).toBe(true);
  });
});

describe('the label anchors of the tiles of a projected view', () => {
  /**
   * The rows of a south polar view of zoom 1 tiles 1/0/1 (west, south) and 1/1/1 (east, south),
   * whose features hold a place in each, and one in the north, on no drawn tile.
   */
  function getRowNames(): string[] {
    const viewport = new CustomProjectionViewport({
      crs: southPolar,
      center: [0, -90, 0],
      zoom: 0,
      width: 1000,
      height: 700
    });
    const state: Record<string, any> = {};
    const layer = new MVTLabelLayer({
      id: 'labels',
      config: {labels: true},
      zoom: 1,
      styleLayer: {layout: {'text-field': '{name}'}},
      tiles: [
        {
          index: {x: 0, y: 1, z: 1},
          // Low zoom tiles hold labels of places far outside them. Cape Town is on the other tile.
          features: [
            point('Santiago', [-70.67, -33.45]),
            point('Cape Town', [18.42, -33.92]),
            point('North America', [-99.7, 45.2])
          ],
          tile: {id: '0-1-1'}
        },
        {index: {x: 1, y: 1, z: 1}, features: [point('Perth', [115.86, -31.95])], tile: {id: '1-1-1'}}
      ]
    } as never);
    (layer as any).context = {viewport};
    (layer as any).state = state;
    (layer as any).setState = (partial: Record<string, any>) => Object.assign(state, partial);
    layer.updateState({changeFlags: {}} as never);
    return getNames(state.labelData);
  }

  test('an anchor on another drawn tile is kept, and one on no drawn tile is left out', () => {
    expect(getRowNames()).toEqual(['Santiago', 'Cape Town', 'Perth']);
  });
});

describe('filterRowsOnDrawnTiles', () => {
  const row = (name: string, position: number[]) => ({name, position}) as never;
  const tile = (x: number, y: number, z: number) => ({index: {x, y, z}, features: []}) as never;

  test('looks an anchor up at each drawn zoom, across the antimeridian too', () => {
    // 2/0/2 is south of the equator from -180 to -90; 1/1/1 is south of it from 0 to 180.
    const tiles = [tile(0, 2, 2), tile(1, 1, 1)];
    const rows = [
      row('in 2/0/2', [-120, -30]),
      row('in 1/1/1', [100, -30]),
      row('in 2/1/2, not drawn', [-60, -30]),
      row('north', [100, 30]),
      row('in 1/1/1, a turn east', [460, -30])
    ];
    expect(filterRowsOnDrawnTiles(tiles, rows).map((r: any) => r.name)).toEqual([
      'in 2/0/2',
      'in 1/1/1',
      'in 1/1/1, a turn east'
    ]);
  });
});
