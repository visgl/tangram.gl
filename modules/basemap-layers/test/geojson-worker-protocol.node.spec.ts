// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, expect, test, vi} from 'vitest';
import type {GeoJsonWorkerRequest} from '../src/geojson-worker';

afterEach(() => vi.unstubAllGlobals());

test('legacy worker protocol batches, indexes, transfers tiles and releases source state', async () => {
  let receive!: (event: {data: GeoJsonWorkerRequest}) => void;
  const postMessage = vi.fn();
  vi.stubGlobal('addEventListener', (_type: string, listener: typeof receive) => {receive = listener;});
  vi.stubGlobal('postMessage', postMessage);
  await import('../src/geojson-worker');
  const send = (data: GeoJsonWorkerRequest) => receive({data});
  const feature = {type: 'Feature', properties: {name: 'point'}, geometry: {type: 'Point', coordinates: [0, 0]}};
  send({type: 'features', source: 1, features: [feature]});
  send({type: 'features', source: 1, features: [feature]});
  send({type: 'index', source: 1, options: {}});
  send({type: 'tile', source: 1, request: 10, z: 0, x: 0, y: 0});
  const [response, transfer] = postMessage.mock.calls.at(-1)!;
  expect(response.request).toBe(10);
  expect(response.tile.positions.length).toBeGreaterThan(0);
  expect(transfer).toEqual([response.tile.positions.buffer, response.tile.lengths.buffer]);
  send({type: 'remove', source: 1});
  send({type: 'tile', source: 1, request: 11, z: 0, x: 0, y: 0});
  expect(postMessage).toHaveBeenLastCalledWith({request: 11, error: 'GeoJSON source has no index'}, []);
  send({type: 'index', source: 2, data: {type: 'FeatureCollection', features: [null]}, options: {}});
  send({type: 'tile', source: 2, request: 12, z: 0, x: 0, y: 0});
  expect(postMessage.mock.calls.at(-1)![0]).toMatchObject({request: 12, error: expect.any(String)});
  send({type: 'features', source: 3, features: [feature]});
  send({type: 'remove', source: 3});
  send({type: 'index', source: 3, options: {}});
  send({type: 'tile', source: 3, request: 13, z: 0, x: 0, y: 0});
  expect(postMessage.mock.calls.at(-1)![0].tile.positions).toHaveLength(0);
});
