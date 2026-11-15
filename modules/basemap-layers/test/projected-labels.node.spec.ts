// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {beforeAll, describe, expect, test} from 'vitest';
import {
  _CustomProjectionViewport as CustomProjectionViewport,
  WebMercatorViewport
} from '@deck.gl/core';
import {projectionEngine} from '@math.gl/geospatial/projection';
import {MVTLabelLayer} from '../src/mvt-label-layer';
import {isPositionDrawn} from '../src/projected-viewport';

type CRS = ConstructorParameters<typeof CustomProjectionViewport>[0]['crs'];

let utm: CRS;

beforeAll(async () => {
  utm = await projectionEngine.getCRS('EPSG:32632');
});

/** A view of UTM zone 32N, which spans longitudes 6 to 12, zoomed out past the zone. */
const createZoneViewport = () =>
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
    point('Kyiv', [30.52, 50.45]),
    point('Dublin', [-6.26, 53.35]),
    point('Hamburg', [9.99, 53.55]),
    point('Lagos', [3.38, 6.52])
  ];

  test('a label outside the area of use of the projection has no row', () => {
    const rows = createLayer(createZoneViewport()).getLabelData(features as never, true);
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
    const projected = createLayer(createZoneViewport()).getAnchorKey(true);
    const map = createLayer(new WebMercatorViewport({width: 8, height: 8})).getAnchorKey(true);
    expect(projected).not.toBe(map);
    expect(projected).toContain('EPSG:32632');
    expect(map).not.toContain('EPSG:32632');
  });
});

describe('isPositionDrawn', () => {
  test('is true where the projection draws the position at its own place', () => {
    const viewport = createZoneViewport();
    expect(isPositionDrawn(viewport, [9.18, 48.78])).toBe(true);
    expect(isPositionDrawn(viewport, [6.001, 1])).toBe(true);
    expect(isPositionDrawn(viewport, [11.999, 83])).toBe(true);
    // Outside the zone: moved to its edge.
    expect(isPositionDrawn(viewport, [30.52, 50.45])).toBe(false);
    expect(isPositionDrawn(viewport, [12.01, 50])).toBe(false);
    expect(isPositionDrawn(viewport, [9, -10])).toBe(false);
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
