// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {STREETS_BUILDING_MIN_ZOOM, STREETS_COLORS, STREETS_PLACE_LABELS} from '../examples/deck/streets-cartography';
import {createStreetsScene} from '../examples/deck/streets-scene';

const vectorSource = {type: 'MVT', url: 'https://example.test/{z}/{x}/{y}.pbf', max_zoom: 14};

test('Streets scene takes its source and font from the caller and keeps the example cartography', () => {
  const scene = createStreetsScene({vectorSource, fontUrl: 'https://example.test/montserrat.woff'});
  expect(scene.sources.basemap).toBe(vectorSource);
  expect(scene.fonts).toEqual({[STREETS_PLACE_LABELS.family]: {url: 'https://example.test/montserrat.woff'}});
  expect(scene.scene.background.color).toBe(STREETS_COLORS.background);
  expect(scene.layers.buildings).toMatchObject({filter: {$zoom: {min: STREETS_BUILDING_MIN_ZOOM}}});
  expect(scene.layers.places).toMatchObject({data: {source: 'basemap', layer: 'place'}, draw: {text: {
    text_source: 'name',
    font: {family: STREETS_PLACE_LABELS.family, size: [[6, '11px'], [12, '14px']], fill: STREETS_PLACE_LABELS.fill,
      stroke: {color: STREETS_PLACE_LABELS.stroke, width: STREETS_PLACE_LABELS.strokeWidth}}
  }}});
  expect((scene.layers.places as {draw: {text: Record<string, unknown>}}).draw.text).not.toHaveProperty('interactive');
});

test('Streets scene drops place names, or makes them pickable for label read-back', () => {
  expect(createStreetsScene({vectorSource, fontUrl: 'font.woff', labels: false}).layers).not.toHaveProperty('places');
  const scene = createStreetsScene({vectorSource, fontUrl: 'font.woff', interactiveLabels: true});
  expect(scene.layers.places).toMatchObject({draw: {text: {interactive: true}}});
});
