// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {LngLat} from 'maplibre-gl';
import {createComparisonCameraOptions} from '../examples/deck/comparison-camera';

test.each(['mapFlat', 'mapPerspective', 'globe'])('%s constrains the explicit shared domain, not viewport coverage', viewMode => {
  const options = createComparisonCameraOptions({longitude: 370, latitude: 80, zoom: 0, pitch: 80}, viewMode,
    (longitude, latitude) => new LngLat(longitude, latitude));
  expect(options).toMatchObject({center: [370, 80], zoom: 0, minZoom: 0, maxZoom: 20,
    pitch: viewMode === 'mapPerspective' ? 50 : 0, maxPitch: viewMode === 'mapPerspective' ? 50 : 0});
  if (!options.transformConstrain) throw new Error('Missing shared camera constraint');
  const center = new LngLat(370, 80);
  expect(options.transformConstrain(center, 0)).toEqual({center, zoom: 0});
  const pole = new LngLat(-370, 90);
  const constrained = options.transformConstrain(pole, 30);
  expect(constrained.center.lng).toBe(-370);
  expect(constrained.center.lat).toBeCloseTo(85.0511287798);
  expect(constrained.zoom).toBe(20);
  expect(pole.lat).toBe(90);
  expect(options.transformConstrain(new LngLat(0, -90), -1)).toEqual({center: new LngLat(0, -85.0511287798), zoom: 0});
});
