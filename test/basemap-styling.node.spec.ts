// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {createUnlitVectorStyles, openMapTilesBuildingExtrusion} from '../examples/deck/basemap-styling';
import {createBlueMarbleScene} from '../examples/classic/app/nasa-basemap.js';
import {createComparisonStyle} from '../examples/deck/comparison-style';

test('cartographic vectors and pre-shaded imagery explicitly opt out of scene lighting', () => {
  expect(createUnlitVectorStyles()).toEqual({
    'basemap-polygons': {base: 'polygons', lighting: false}, 'basemap-lines': {base: 'lines', lighting: false}
  });
  expect(createUnlitVectorStyles()['basemap-polygons']).not.toBe(createUnlitVectorStyles()['basemap-polygons']);
  expect(createBlueMarbleScene().styles.blueMarble).toEqual({base: 'raster', lighting: false});
});

test.each([
  {properties: {render_height: 120, render_min_height: 25, height: 10}, expected: [25, 120]},
  {properties: {render_height: '120.5', render_min_height: '25'}, expected: [25, 120.5]},
  {properties: {height: 42, min_height: 7}, expected: [7, 42]},
  {properties: {render_height: 0, render_min_height: 0, height: 42}, expected: [0, 0]},
  {properties: {render_height: 'bad', height: 42, render_min_height: null, min_height: 7}, expected: [7, 42]},
  {properties: {render_height: Infinity, render_min_height: NaN}, expected: [0, 20]},
  {properties: {render_height: '', render_min_height: false}, expected: [0, 20]},
  {properties: {}, expected: [0, 20]}
])('worker-safe building height normalization: $properties', ({properties, expected}) => {
  expect(openMapTilesBuildingExtrusion({feature: {properties}})).toEqual(expected);
});

test('reference buildings use the same height aliases, bases and fallback', () => {
  const reference = createComparisonStyle('tron', 'mapPerspective');
  const buildings = reference.layers.find(layer => layer.id === 'buildings');
  expect(buildings?.type).toBe('fill-extrusion');
  if (buildings?.type !== 'fill-extrusion') throw new Error('Missing reference building style');
  expect(buildings.paint?.['fill-extrusion-base']).toEqual(
    ['to-number', ['coalesce', ['get', 'render_min_height'], ['get', 'min_height'], 0], 0]);
  expect(buildings.paint?.['fill-extrusion-height']).toEqual(
    ['to-number', ['coalesce', ['get', 'render_height'], ['get', 'height'], 20], 20]);
});
