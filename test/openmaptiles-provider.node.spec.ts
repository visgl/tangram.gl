// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect, test} from 'vitest';
import {MVTWriter} from '@loaders.gl/mvt';
import {parseMvtWithLegacy} from '../modules/tangram-renderer/src/procedures/mvt-legacy';

test('OpenMapTiles tile properties survive MVT decoding and the classic Tilezen compatibility transform', () => {
  // Authored, tiny fixtures: no downloaded tile data or live-service dependency.
  const layers = [
    {name: 'transportation', geometry: {type: 'LineString', coordinates: [[0.1, 0.2], [0.7, 0.8]]},
      properties: {class: 'motorway', brunnel: 'bridge', ref: 'I-1'}},
    {name: 'building', geometry: {type: 'Polygon', coordinates: [[[0.2, 0.2], [0.2, 0.4], [0.4, 0.4], [0.4, 0.2], [0.2, 0.2]]]},
      properties: {render_height: 45, render_min_height: 12}},
    {name: 'place', geometry: {type: 'Point', coordinates: [0.5, 0.5]},
      properties: {class: 'city', name: 'Fixture City', rank: 1}}
  ];
  const chunks = layers.map((layer, index) => new Uint8Array(MVTWriter.encodeSync({
    type: 'FeatureCollection', features: [{type: 'Feature', id: index + 1,
      geometry: layer.geometry, properties: layer.properties}]
  }, {mvt: {layerName: layer.name, extent: 4096}})));
  const tile = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    tile.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const decoded = parseMvtWithLegacy(tile);
  const context = {self: {transformOpenMapTilesToMapzen: (_data: typeof decoded): unknown => undefined}};
  runInNewContext(readFileSync(new URL('../examples/classic/app/openmaptiles-mapzen-compat.js', import.meta.url), 'utf8'), context);
  const transformed = context.self.transformOpenMapTilesToMapzen(decoded);
  expect(transformed).toMatchObject({
    roads: {features: [{id: 1, properties: {kind: 'highway', is_bridge: true, shield_text: 'I-1'}}]},
    buildings: {features: [{id: 2, properties: {height: 45, min_height: 12}}]},
    places: {features: [{id: 3, properties: {kind: 'city', name: 'Fixture City'}}]}
  });
  // The transform must not rewrite the decoder's cached feature properties.
  expect(decoded.building.features[0].properties).not.toHaveProperty('height');
});
