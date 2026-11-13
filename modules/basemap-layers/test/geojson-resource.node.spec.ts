// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {createGeoJsonResourceState, runGeoJsonResource} from '../src/geojson-resource';
import {decodeTile} from '../src/geojson-tiler';

test('GeoJSON resource keeps independent indexes and removes only the requested source', () => {
  const state = createGeoJsonResourceState();
  const feature = (name: string) => ({type: 'Feature', properties: {name}, geometry: {type: 'Point', coordinates: [0, 0]}});
  const options = {maxZoom: 0, extent: 4096, buffer: 0, tolerance: 0};
  runGeoJsonResource(state, {type: 'features', source: 1, features: [feature('first')]});
  runGeoJsonResource(state, {type: 'index', source: 1, options});
  runGeoJsonResource(state, {type: 'index', source: 2, data: {type: 'FeatureCollection', features: [feature('second')]}, options});
  const first = runGeoJsonResource(state, {type: 'tile', source: 1, request: 1, z: 0, x: 0, y: 0});
  const second = runGeoJsonResource(state, {type: 'tile', source: 2, request: 2, z: 0, x: 0, y: 0});
  expect(first && decodeTile(first)[0].properties).toMatchObject({name: 'first'});
  expect(second && decodeTile(second)[0].properties).toMatchObject({name: 'second'});
  runGeoJsonResource(state, {type: 'remove', source: 1});
  expect(() => runGeoJsonResource(state, {type: 'tile', source: 1, request: 3, z: 0, x: 0, y: 0})).toThrow('no index');
  expect(runGeoJsonResource(state, {type: 'tile', source: 2, request: 4, z: 0, x: 0, y: 0})).not.toBeNull();
});
