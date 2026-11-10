// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import type {GeoJsonResourceState} from '../src/geojson-resource';
import type {GeoJsonWorkerRequest} from '../src/geojson-worker';
import type {GeoJsonTaskResult} from '../src/geojson-task';

const {install} = vi.hoisted(() => ({install: vi.fn(async (_handler: {
  initialize: () => GeoJsonResourceState;
  run: (state: GeoJsonResourceState, request: GeoJsonWorkerRequest) => GeoJsonTaskResult;
}) => {})}));
vi.mock('@math.gl/core/tasks', () => ({createResourceWorker: install}));

test('resource handler copies retained tile results and returns request errors', async () => {
  const {installGeoJsonTaskHandler} = await import('../src/geojson-task-handler');
  await installGeoJsonTaskHandler();
  const handler = install.mock.calls[0][0];
  const state = handler.initialize();
  handler.run(state, {type: 'index', source: 1, data: {
    type: 'Feature', properties: {name: 'point'}, geometry: {type: 'Point', coordinates: [0, 0]}
  }, options: {}});
  const request = {type: 'tile' as const, source: 1, request: 1, z: 0, x: 0, y: 0};
  const first = handler.run(state, request);
  const second = handler.run(state, request);
  expect(first).toEqual(second);
  if (!('tile' in first) || !first.tile || !('tile' in second) || !second.tile) throw new Error('Expected tile results');
  expect(first.tile.positions.buffer).not.toBe(second.tile.positions.buffer);
  structuredClone(first.tile, {transfer: [first.tile.positions.buffer, first.tile.lengths.buffer]});
  expect(handler.run(state, request)).toEqual(second);
  expect(handler.run(state, {...request, source: 2})).toEqual({error: 'GeoJSON source has no index'});
});
