// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import {TaskRunner} from '@math.gl/tasks';
import {GeoJsonTask} from '../src/geojson-task';

const {install} = vi.hoisted(() => ({install: vi.fn(async () => {})}));
vi.mock('@math.gl/tasks', async importOriginal => ({
  ...await importOriginal<typeof import('@math.gl/tasks')>(),
  initializeTaskWorker: install
}));

test('resource handler copies retained tile results and returns request errors', async () => {
  const {installGeoJsonTaskHandler} = await import('../src/geojson-task-handler');
  await installGeoJsonTaskHandler();
  expect(install).toHaveBeenCalledExactlyOnceWith(GeoJsonTask);
  const runner = new TaskRunner();
  const task = await runner.initializeTask(GeoJsonTask, {}, {execution: 'main-thread'});
  try {
    await task.runTask({type: 'index', source: 1, data: {
      type: 'Feature', properties: {name: 'point'}, geometry: {type: 'Point', coordinates: [0, 0]}
    }, options: {}});
    const request = {type: 'tile' as const, source: 1, request: 1, z: 0, x: 0, y: 0};
    const first = await task.runTask(request, {outputOwnership: 'copy'});
    const second = await task.runTask(request, {outputOwnership: 'copy'});
    expect(first).toEqual(second);
    if (!('tile' in first) || !first.tile || !('tile' in second) || !second.tile) throw new Error('Expected tile results');
    expect(first.tile.positions.buffer).not.toBe(second.tile.positions.buffer);
    structuredClone(first.tile, {transfer: [first.tile.positions.buffer, first.tile.lengths.buffer]});
    expect(await task.runTask(request, {outputOwnership: 'copy'})).toEqual(second);
    expect(await task.runTask({...request, source: 2})).toEqual({error: 'GeoJSON source has no index'});
  } finally {
    await runner.close();
  }
});
