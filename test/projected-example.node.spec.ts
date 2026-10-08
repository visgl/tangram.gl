// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import {createProjectedExampleScene, getProjectedExampleTileZoom} from '../examples/projected/scene.js';
import {BLUE_MARBLE_URL} from '../examples/classic/app/nasa-basemap.js';
import {OPENFREEMAP_TILEJSON} from '../examples/classic/app/vector-providers.js';
import {createProjectedExampleProjectionEngine} from '../examples/projected/projection-engine.js';
import {HostProjectionEngineAdapter, getProjectedCoordinateOptions, PROJECTED_COMMON_SCALE} from '../modules/tangram-renderer/src/procedures/projected-coordinate-transform';

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
    draw: {lines: {width: '150000m', cap: 'round', join: 'round'}}}});
  expect(createProjectedExampleScene(false)).not.toBe(scene);
});

test('projected raster example retains lower-detail Blue Marble imagery', () => {
  expect(getProjectedExampleTileZoom(true)).toBe(2);
  expect(createProjectedExampleScene(true).sources).toMatchObject({blueMarble: {url: BLUE_MARBLE_URL}});
});
