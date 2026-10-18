// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {createBasemapBackground} from '../examples/deck/basemap-background';

test('map backgrounds are unlit noninteractive surface geometry, not a host framebuffer clear', () => {
  const background = createBasemapBackground('#f5f3ef');
  const source = background.sources.basemapBackground;
  const geometry = JSON.parse(decodeURIComponent(source.url.split(',')[1]));
  const ring = geometry.features[0].geometry.coordinates[0];
  expect(ring[0]).toEqual(ring.at(-1));
  expect(ring.map((point: number[]) => point[0])).toEqual([-180, 180, 180, -180, -180]);
  expect(Math.max(...ring.map((point: number[]) => Math.abs(point[1])))).toBeCloseTo(85.05112878);
  expect(source.max_zoom).toBe(14);
  expect(background.styles.basemapBackground).toEqual({base: 'polygons', lighting: false});
  expect(background.layers.basemapBackground.draw.basemapBackground).toEqual({order: 0, color: '#f5f3ef', interactive: false});
  expect(background).not.toHaveProperty('scene');
  expect(background).not.toHaveProperty('lights');
});

test('each scene receives independent background records and colors', () => {
  const streets = createBasemapBackground('#f5f3ef');
  const tron = createBasemapBackground('#08111f');
  streets.layers.basemapBackground.draw.basemapBackground.color = '#ff0000';
  expect(tron.layers.basemapBackground.draw.basemapBackground.color).toBe('#08111f');
  expect(streets.sources).not.toBe(tron.sources);
});
