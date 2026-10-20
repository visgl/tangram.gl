// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {transformSync} from 'esbuild';
import {createExpression} from '@maplibre/maplibre-gl-style-spec';
import {compileFunctionString} from '../modules/tangram-renderer/src/utils/functions';
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
  const evaluate = compileHeightCallback(openMapTilesBuildingExtrusion.toString());
  expect(evaluate({feature: {properties}})).toEqual(expected);
  const reference = createComparisonStyle('tron', 'mapPerspective').layers.find(layer => layer.id === 'buildings');
  if (reference?.type !== 'fill-extrusion') throw new Error('Missing reference building style');
  const keys: readonly ('fill-extrusion-base' | 'fill-extrusion-height')[] = ['fill-extrusion-base', 'fill-extrusion-height'];
  for (const [index, key] of keys.entries()) {
    const expression = createExpression(reference.paint?.[key], `layers.buildings.paint.${key}`);
    if (expression.result !== 'success') throw new Error(JSON.stringify(expression.value));
    expect(expression.value.evaluate({zoom: 15}, {type: 3, properties})).toEqual(expected[index]);
  }
});

test.each([false, true])('height callback survives worker serialization; minified=%s', minified => {
  const original = openMapTilesBuildingExtrusion.toString();
  const source = minified ? transformSync(original, {minify: true}).code : original;
  const evaluate = compileHeightCallback(source);
  expect(evaluate({feature: {properties: {render_height: 120, render_min_height: 20}}})).toEqual([20, 120]);
});

/** Exercise the feature binding used by the worker without importing browser-only scene machinery in Node. */
function compileHeightCallback(source: string) {
  const evaluate = compileFunctionString(source, body => `var feature = context.feature.properties;\n${body}`);
  if (typeof evaluate !== 'function') throw new Error('Height callback did not compile');
  return evaluate;
}
