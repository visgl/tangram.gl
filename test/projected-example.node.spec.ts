// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {createProjectedExampleScene, getProjectedExampleTileZoom} from '../examples/projected/scene.js';
import {BLUE_MARBLE_URL} from '../examples/classic/app/nasa-basemap.js';
import {OPENFREEMAP_TILEJSON} from '../examples/classic/app/vector-providers.js';

test('projected vector example requests the source zoom where transportation starts', () => {
  const scene = createProjectedExampleScene(false);
  expect(getProjectedExampleTileZoom(false)).toBe(4);
  // A 512-pixel source would subtract one zoom, silently requesting road-free zoom 3.
  expect(scene.sources).toMatchObject({map: {tile_size: 256, max_zoom: 6, tilejson: OPENFREEMAP_TILEJSON}});
  expect(scene.layers).toMatchObject({roads: {data: {layer: 'transportation'},
    draw: {lines: {width: '150000m', cap: 'round', join: 'round'}}}});
  expect(createProjectedExampleScene(false)).not.toBe(scene);
});

test('projected raster example retains lower-detail Blue Marble imagery', () => {
  expect(getProjectedExampleTileZoom(true)).toBe(2);
  expect(createProjectedExampleScene(true).sources).toMatchObject({blueMarble: {url: BLUE_MARBLE_URL}});
});
