// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import {createProjectedExampleScene, getProjectedExampleTileZoom} from '../examples/projected/scene.js';
import {BLUE_MARBLE_URL} from '../examples/classic/app/nasa-basemap.js';
import {OPENFREEMAP_TILEJSON} from '../examples/classic/app/vector-providers.js';
import {getProjectedExampleBounds, getProjectedExampleDetailChoices} from '../examples/projected/detail.js';
import {countProjectedTileCoordinates} from '../modules/tangram-renderer/src/tile/tile_traversal_adapter';
import {createProjectedExampleProjectionEngine} from '../examples/projected/projection-engine.js';
import {HostProjectionEngineAdapter, getProjectedCoordinateOptions, PROJECTED_COMMON_SCALE} from '../modules/tangram-renderer/src/procedures/projected-coordinate-transform';
import {queryProjectedFeature} from '../examples/projected/feature-selection';

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

test.each(['equal-earth', 'albers', 'equirectangular', 'mercator', 'web-mercator'] as const)(
  'the example supplies an engine that compiles and reuses %s across projection switches', async type => {
    const engine = createProjectedExampleProjectionEngine();
    const compile = vi.spyOn(engine, 'createProjectionAsync');
    const adapter = new HostProjectionEngineAdapter(engine);
    const input = new Float64Array([-75, 40]);
    const first = await adapter.projectPositions(input, type);
    await adapter.projectPositions(input, 'equal-earth');
    expect(await adapter.projectPositions(input, type)).toEqual(first);
    expect(compile.mock.calls.filter(([options]) => options?.to === getProjectedCoordinateOptions(type).to)).toHaveLength(1);
    const expected = engine.createProjection(getProjectedCoordinateOptions(type)).projectSync([-75, 40]);
    expect(first[0]).toBeCloseTo(expected[0] * PROJECTED_COMMON_SCALE, 10);
    expect(first[1]).toBeCloseTo(expected[1] * PROJECTED_COMMON_SCALE, 10);
    expect(input).toEqual(new Float64Array([-75, 40]));
    adapter.dispose();
  }
);

test('projected vector example requests the source zoom where transportation starts', () => {
  const scene = createProjectedExampleScene(false);
  expect(getProjectedExampleTileZoom(false)).toBe(4);
  // A 512-pixel source would subtract one zoom, silently requesting road-free zoom 3.
  expect(scene.sources).toMatchObject({map: {tile_size: 256, max_zoom: 6, tilejson: OPENFREEMAP_TILEJSON}});
  expect(scene.layers).toMatchObject({roads: {data: {layer: 'transportation'},
    draw: {traffic: {width: [[4, '3px'], [6, '6px'], [8, '10px']], cap: 'round', join: 'round',
      outline: {width: [[4, '1px'], [8, '2px']]}}}}});
  expect(createProjectedExampleScene(false)).not.toBe(scene);
});

test('projected raster example retains lower-detail Blue Marble imagery', () => {
  expect(getProjectedExampleTileZoom(true)).toBe(2);
  expect(createProjectedExampleScene(true).sources).toMatchObject({blueMarble: {url: BLUE_MARBLE_URL}});
});

test.each([true, false])('imagery/vector %s includes curated noncolliding city annotations', raster => {
  const scene = createProjectedExampleScene(raster);
  const source = JSON.parse(decodeURIComponent(scene.sources.annotations.url.split(',')[1]));
  expect(source.features).toHaveLength(5);
  expect(source.features[0]).toMatchObject({geometry: {type: 'Point'}, properties: {name: 'New York'}});
  expect(scene.layers.annotations.draw.points).toMatchObject({collide: false, interactive: true,
    text: {collide: true, optional: true, text_source: 'name'}});
});

test('feature click results ignore obsolete navigation, scene replacement and disposal', async () => {
  const updateText = vi.fn();
  let current = true;
  let resolve: (result: {feature: {properties: {name: string}}}) => void = () => {};
  const pending = queryProjectedFeature(() => new Promise(complete => {resolve = complete;}), () => current, updateText);
  current = false;
  resolve({feature: {properties: {name: 'Old scene'}}});
  await pending;
  expect(updateText).not.toHaveBeenCalled();
  await queryProjectedFeature(async () => {throw new Error('Obsolete failure');}, () => false, updateText);
  expect(updateText).not.toHaveBeenCalled();
  await queryProjectedFeature(async () => ({feature: {properties: {name: 'New York'}}}), () => true, updateText);
  expect(updateText).toHaveBeenLastCalledWith('New York');
});

test('feature click text handles empty/custom payloads and both failure contracts', async () => {
  const updateText = vi.fn();
  for (const result of [undefined, {feature: null}, {feature: 'custom'}, {feature: {properties: {name: 5}}}]) {
    await queryProjectedFeature(async () => result, () => true, updateText);
    expect(updateText).toHaveBeenLastCalledWith('No interactive feature');
  }
  await queryProjectedFeature(async () => ({error: new Error('Readback failed')}), () => true, updateText);
  expect(updateText).toHaveBeenLastCalledWith('Selection failed: Readback failed');
  await queryProjectedFeature(async () => ({error: {message: 'Worker failed'}}), () => true, updateText);
  expect(updateText).toHaveBeenLastCalledWith('Selection failed: Worker failed');
  await queryProjectedFeature(async () => {throw 'Cancelled';}, () => true, updateText);
  expect(updateText).toHaveBeenLastCalledWith('Selection failed: Cancelled');
});
