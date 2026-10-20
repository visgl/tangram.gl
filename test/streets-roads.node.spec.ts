// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {transformSync} from 'esbuild';
import {createExpression, featureFilter, type LineLayerSpecification} from '@maplibre/maplibre-gl-style-spec';
import {compileFunctionString} from '../modules/tangram-renderer/src/utils/functions';
import {createStreetsRoadRules, getStreetsRoadOrder} from '../examples/deck/streets-cartography';
import {createComparisonStyle} from '../examples/deck/comparison-style';

test.each([false, true])('road order survives worker serialization; minified=%s', minified => {
  const source = minified ? transformSync(getStreetsRoadOrder.toString(), {minify: true}).code : getStreetsRoadOrder.toString();
  const evaluate = compileFunctionString(source, body => `var feature = context.feature.properties;\n${body}`);
  if (typeof evaluate !== 'function') throw new Error('Road order did not compile');
  const order = (properties: Record<string, unknown>) => evaluate({feature: {properties}});
  expect(order({class: 'primary'})).toBe(134);
  expect(order({class: 'service'})).toBe(130);
  expect(order({class: 'service', brunnel: 'bridge'})).toBe(146);
  expect(order({class: 'motorway', brunnel: 'tunnel'})).toBe(120);
  expect(order({class: 'primary', layer: '2', brunnel: 'tunnel'})).toBe(166);
  expect(order({class: 'primary', layer: -100})).toBe(54);
  expect(order({class: 'primary', layer: 100})).toBe(214);
  expect(order({class: 'unknown', layer: 'invalid'})).toBe(128);
});

test('road rules retain authored cartography and are independently owned by each scene', () => {
  const first = createStreetsRoadRules(), second = createStreetsRoadRules();
  expect(first.draw.lines.order).toBe(getStreetsRoadOrder);
  expect(first.draw.lines.style).toBe('basemap-lines');
  expect(first.major.filter.class).toEqual(['motorway', 'trunk', 'primary', 'secondary']);
  first.major.filter.class.pop(); first.draw.lines.width[0][1] = '99px';
  expect(second.major.filter.class).toHaveLength(4);
  expect(second.draw.lines.width[0][1]).toBe('0.5px');
});

test('reference grades follow Tangram grade precedence without replacing its ordering callback', () => {
  const layers = createComparisonStyle('streetsVector', 'mapFlat').layers.filter((layer): layer is LineLayerSpecification =>
    layer.type === 'line' && layer['source-layer'] === 'transportation');
  const filters = layers.map(layer => ({layer, filter: featureFilter(layer.filter, `layers.${layer.id}.filter`)}));
  const evaluate = compileFunctionString(getStreetsRoadOrder.toString(), body => `var feature = context.feature.properties;\n${body}`);
  if (typeof evaluate !== 'function') throw new Error('Road order did not compile');
  const cases: Record<string, unknown>[] = [
    {}, {class: 'primary'}, {class: 'service', brunnel: 'bridge'}, {class: 'motorway', brunnel: 'tunnel'},
    {class: 'service', layer: 0, brunnel: 'bridge'}, {class: 'primary', layer: '2', brunnel: 'tunnel'},
    {class: 'primary', layer: -100}, {class: 'motorway', layer: 100}, {class: 'tertiary', layer: 2.5},
    {class: 'minor', layer: -2.5}, {class: 'track', layer: false}, {class: 'unknown', layer: 'invalid'},
    {class: 'path', layer: Infinity}, {class: 'secondary', layer: null}
  ];
  for (const properties of cases) {
    const order = evaluate({feature: {properties}});
    if (typeof order !== 'number') throw new Error('Expected a numeric road order');
    const grade = Math.floor((order - 128) / 16);
    const selected = filters.filter(({filter}) => filter.filter({zoom: 15}, {type: 2, properties}));
    expect(selected.map(({layer}) => layer.id), JSON.stringify(properties)).toEqual([
      `roads-grade-${grade}-outline`, `roads-grade-${grade}`
    ]);
    for (const {layer} of selected) {
      if (layer.type !== 'line') throw new Error('Expected a road line');
      const sort = createExpression(layer.layout?.['line-sort-key'], `layers.${layer.id}.layout.line-sort-key`);
      if (sort.result !== 'success') throw new Error(JSON.stringify(sort.value));
      expect(sort.value.evaluate({zoom: 15}, {type: 2, properties})).toBe(order - 128 - grade * 16);
    }
  }
});
