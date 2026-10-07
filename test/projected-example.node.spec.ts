// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {createProjectedExampleScene, getProjectedExampleTileZoom} from '../examples/projected/scene.js';
import {BLUE_MARBLE_URL} from '../examples/classic/app/nasa-basemap.js';
import {OPENFREEMAP_TILEJSON} from '../examples/classic/app/vector-providers.js';
import {getProjectedExampleBounds, getProjectedExampleDetailChoices} from '../examples/projected/detail.js';
import {countProjectedTileCoordinates} from '../modules/tangram-renderer/src/tile/tile_traversal_adapter';

test('detail controls guard full-world loading and allow finer regional coverage', () => {
  expect(getProjectedExampleBounds(true)).toEqual([-170, 5, -40, 75]);
  for (const raster of [true, false]) {
    const world = getProjectedExampleDetailChoices(raster, false, countProjectedTileCoordinates);
    const region = getProjectedExampleDetailChoices(raster, true, countProjectedTileCoordinates);
    expect(world.find(choice => choice.zoom === 4)).toEqual({zoom: 4, tiles: 256, disabled: false});
    expect(world.find(choice => choice.zoom === 5)).toEqual({zoom: 5, tiles: 1024, disabled: true});
    expect(region.find(choice => choice.zoom === 5)).toMatchObject({disabled: false});
    expect(region.filter(choice => !choice.disabled).every(choice => choice.tiles <= 256)).toBe(true);
    expect(world.every(choice => raster || choice.zoom >= 4)).toBe(true);
  }
});

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
