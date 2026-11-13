// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import {runTask} from '@math.gl/core-legacy-tasks/tasks';
import {TerrainDecodeTask, type TerrainTaskInput} from '../examples/terrain/terrain-task';
import {TerrainTaskPool} from '../examples/terrain/terrain-task-pool';
import {createTerrainFixture} from './terrain-fixture';

test('terrain task worker matches local decoding and preserves cached image bytes', async () => {
  const {bytes} = await createTerrainFixture();
  const original = bytes.slice(0);
  const input: TerrainTaskInput = {mode: 'grid', bytes, bounds: [0, 0, 0.01, 0.01], meshMaxError: 0, noData: 'opaque'};
  const workerUrl = `${location.origin}/examples/terrain/dist/terrain-task-worker.js`;
  for (const mode of ['grid', 'mesh'] as const) {
    const request = {...input, mode};
    const local = await runTask(TerrainDecodeTask, request, {execution: 'main-thread', inputOwnership: 'copy'});
    const worker = await runTask(TerrainDecodeTask, request, {
      execution: 'worker', 'tangram-terrain-decode': {workerUrl}, workerType: 'module', reuseWorkers: false, inputOwnership: 'copy'
    });
    expect(worker.grid).toEqual(local.grid);
    if (mode === 'mesh') expect(worker.mesh?.indices?.value).toEqual(local.mesh?.indices?.value);
    else expect(worker.mesh).toBeUndefined();
    expect(bytes).toEqual(original);
  }
});

test('the legacy terrain worker URL also accepts math.gl tasks', async () => {
  const {bytes} = await createTerrainFixture();
  const input: TerrainTaskInput = {mode: 'grid', bytes, bounds: [0, 0, 0.01, 0.01], meshMaxError: 0, noData: 'opaque'};
  const local = await runTask(TerrainDecodeTask, input, {execution: 'main-thread', inputOwnership: 'copy'});
  const result = await runTask(TerrainDecodeTask, input, {
    execution: 'worker', 'tangram-terrain-decode': {workerUrl: `${location.origin}/examples/terrain/dist/terrain-worker.js`},
    workerType: 'module', reuseWorkers: false, inputOwnership: 'copy'
  });
  expect(result).toEqual(local);
});

test('legacy terrain worker dispatches an early burst of task messages exactly once', async () => {
  const worker = new Worker(`${location.origin}/examples/terrain/dist/terrain-worker.js`, {type: 'module'});
  try {
    const replies: unknown[] = [];
    const received = new Promise<void>(resolve => worker.addEventListener('message', event => {
      if (event.data?.source === 'loaders.gl' && event.data.type === 'error') {
        replies.push(event.data);
        if (replies.length === 2) resolve();
      }
    }));
    const input = {mode: 'grid', bytes: new ArrayBuffer(8), bounds: [0, 0, 1, 1], meshMaxError: -1, noData: 'opaque'};
    for (let index = 0; index < 2; index++) worker.postMessage({source: 'loaders.gl', type: 'process', payload: {input, options: {}}});
    await received;
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(replies).toHaveLength(2);
  } finally {
    worker.terminate();
  }
});

test('the task pool reuses a worker, enforces capacity and preserves source bytes', async () => {
  const {bytes} = await createTerrainFixture();
  const original = bytes.slice(0);
  const bounds: [number, number, number, number] = [0, 0, 0.01, 0.01];
  const pool = new TerrainTaskPool(`${location.origin}/examples/terrain/dist/terrain-task-worker.js`, 1);
  try {
    const first = pool.decodeGrid(bytes, bounds, new AbortController().signal);
    await expect(pool.decodeGrid(bytes, bounds, new AbortController().signal)).rejects.toThrow('capacity');
    const result = await first;
    const next = await pool.decodeMesh(bytes, bounds, 0, new AbortController().signal);
    expect(next.grid).toEqual(result.grid);
    expect(bytes).toEqual(original);
    expect(pool.getStatistics()).toMatchObject({created: 1, completed: 2, active: 0, idle: 1});
  } finally {
    pool.destroy();
  }
  await expect(pool.decodeGrid(bytes, bounds, new AbortController().signal)).rejects.toMatchObject({name: 'AbortError'});
});

test('aborting an active task releases capacity without detaching its source', async () => {
  const {bytes} = await createTerrainFixture();
  const original = bytes.slice(0);
  const bounds: [number, number, number, number] = [0, 0, 0.01, 0.01];
  const pool = new TerrainTaskPool(`${location.origin}/examples/terrain/dist/terrain-task-worker.js`, 1);
  try {
    const controller = new AbortController();
    const pending = pool.decodeGrid(bytes, bounds, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({name: 'AbortError'});
    expect(bytes).toEqual(original);
    const recovered = await pool.decodeGrid(bytes, bounds, new AbortController().signal);
    expect(recovered.grid.heights.length).toBeGreaterThan(0);
    expect(pool.getStatistics()).toMatchObject({cancelled: 1, completed: 1, active: 0});
  } finally {
    pool.destroy();
  }
});

test('malformed task results retire the worker before it can be reused', async () => {
  const {bytes} = await createTerrainFixture();
  const workerUrl = URL.createObjectURL(new Blob([
    `self.onmessage = event => { if (event.data.type === 'process') self.postMessage({source: 'loaders.gl', type: 'done', payload: {result: {invalid: true}}}); };`
  ], {type: 'text/javascript'}));
  const pool = new TerrainTaskPool(workerUrl, 1);
  const bounds: [number, number, number, number] = [0, 0, 0.01, 0.01];
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      await expect(pool.decodeGrid(bytes, bounds, new AbortController().signal)).rejects.toThrow('Invalid terrain worker output');
      expect(pool.getStatistics()).toMatchObject({created: attempt, failed: attempt, idle: 0});
    }
  } finally {
    pool.destroy();
    URL.revokeObjectURL(workerUrl);
  }
});

test('retiring a bad worker does not interrupt another active slot', async () => {
  const workerUrl = URL.createObjectURL(new Blob([`
    self.onmessage = event => {
      if (event.data.type !== 'process') return;
      const input = event.data.payload.input;
      const invalid = new Uint8Array(input.bytes)[0] === 1;
      const result = invalid ? {} : {grid: {width: 2, height: 2, bounds: input.bounds,
        heights: new Float32Array([1, 2, 3, 4]), valid: new Uint8Array([1, 1, 1, 1]),
        registration: 'pixel-center', verticalDatum: 'unknown'}};
      setTimeout(() => self.postMessage({source: 'loaders.gl', type: 'done', payload: {result}}), invalid ? 0 : 50);
    };
  `], {type: 'text/javascript'}));
  const pool = new TerrainTaskPool(workerUrl, 2);
  const bounds: [number, number, number, number] = [0, 0, 1, 1];
  try {
    const failure = pool.decodeGrid(Uint8Array.from([1]).buffer, bounds, new AbortController().signal);
    const survivor = pool.decodeGrid(Uint8Array.from([2]).buffer, bounds, new AbortController().signal);
    await expect(failure).rejects.toThrow('Invalid terrain worker output');
    expect((await survivor).grid.heights).toEqual(new Float32Array([1, 2, 3, 4]));
    expect(pool.getStatistics()).toMatchObject({created: 2, failed: 1, completed: 1, idle: 1});
  } finally {
    pool.destroy();
    URL.revokeObjectURL(workerUrl);
  }
});

test('an abort during worker construction cancels the task and releases capacity', async () => {
  const {bytes} = await createTerrainFixture();
  const abort = new AbortController();
  const NativeWorker = globalThis.Worker;
  vi.stubGlobal('Worker', class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      abort.abort();
    }
  });
  const pool = new TerrainTaskPool(`${location.origin}/examples/terrain/dist/terrain-task-worker.js`, 1);
  try {
    await expect(pool.decodeGrid(bytes, [0, 0, 0.01, 0.01], abort.signal)).rejects.toMatchObject({name: 'AbortError'});
    expect(pool.getStatistics()).toMatchObject({active: 0, idle: 0, cancelled: 1});
  } finally {
    pool.destroy();
    vi.unstubAllGlobals();
  }
});

test('a nonresponsive task worker times out and is retired', async () => {
  const {bytes} = await createTerrainFixture();
  const workerUrl = URL.createObjectURL(new Blob(['self.onmessage = () => {};'], {type: 'text/javascript'}));
  const pool = new TerrainTaskPool(workerUrl, 1);
  vi.useFakeTimers();
  try {
    const pending = pool.decodeGrid(bytes, [0, 0, 0.01, 0.01], new AbortController().signal);
    const rejected = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(30000);
    await rejected;
    expect(pool.getStatistics()).toMatchObject({active: 0, idle: 0, failed: 1});
  } finally {
    vi.useRealTimers();
    pool.destroy();
    URL.revokeObjectURL(workerUrl);
  }
});
