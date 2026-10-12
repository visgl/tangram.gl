// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, expect, test, vi} from 'vitest';
import {decodeTerrainInWorker} from '../examples/terrain/worker-client';
import {TerrainDecoderPool} from '../examples/terrain/decoder-pool';
import {createTerrainStreamFixture} from './terrain-stream-fixture';

/** Deterministic worker transport; parser conformance uses a real worker separately. */
class TestWorker extends EventTarget {
  /** Last instance belongs only to this test. */
  static current: TestWorker;
  /** Each test owns its construction log. */
  static instances: TestWorker[] = [];
  /** Observe ownership release on every settlement path. */
  terminate = vi.fn();
  /** Observe the copied payload and transfer list. */
  postMessage = vi.fn<(message: {requestId: number; mode: string; bytes: ArrayBuffer}, transfers: ArrayBuffer[]) => void>();
  /** Capture construction without starting an actual worker. */
  constructor() {super(); TestWorker.current = this; TestWorker.instances.push(this);}
}
const pools: TerrainDecoderPool[] = [];
afterEach(() => {pools.splice(0).forEach(pool => pool.destroy()); TestWorker.instances = []; vi.unstubAllGlobals(); vi.useRealTimers();});

/** Echo the active correlation key; callers may deliberately supply stale keys. */
function reply(worker: TestWorker, data: unknown = {grid: createTerrainStreamFixture().grid}, requestId = worker.postMessage.mock.lastCall![0].requestId): void {
  worker.dispatchEvent(new MessageEvent('message', {data: {requestId, type: 'result', data, decodeMs: 5}}));
}

test.each([{type: 'result', data: {}}, {}, {type: 'error', message: 'decode failed'}])('malformed/error replies reject and terminate the owned worker: %j', response => {
  vi.stubGlobal('Worker', TestWorker);
  const bytes = new ArrayBuffer(8), signal = new AbortController();
  const pending = decodeTerrainInWorker('/terrain-worker.js', bytes, [0, 0, 1, 1], 20, signal.signal);
  const worker = TestWorker.current;
  const sent = worker.postMessage.mock.calls[0];
  expect(sent[0].bytes).not.toBe(bytes); expect(sent[1]).toEqual([sent[0].bytes]);
  worker.dispatchEvent(new MessageEvent('message', {data: {...response, requestId: sent[0].requestId}}));
  expect(worker.terminate).toHaveBeenCalledOnce();
  signal.abort(); expect(worker.terminate).toHaveBeenCalledOnce();
  return expect(pending).rejects.toThrow();
});

test('decode timeout settles and releases the worker instead of leaving readiness pending', async () => {
  vi.useFakeTimers(); vi.stubGlobal('Worker', TestWorker);
  const pending = decodeTerrainInWorker('/terrain-worker.js', new ArrayBuffer(8), [0, 0, 1, 1], 20, new AbortController().signal);
  const result = expect(pending).rejects.toThrow('timed out');
  vi.advanceTimersByTime(30000); await result;
  expect(TestWorker.current.terminate).toHaveBeenCalledOnce();
});

test('warm requests retain one worker, detach input copies and ignore duplicated old replies', async () => {
  vi.stubGlobal('Worker', TestWorker);
  const pool = new TerrainDecoderPool('/terrain-worker.js', 1); pools.push(pool);
  expect(TestWorker.instances).toHaveLength(0);
  const bytes = new ArrayBuffer(8), signal = new AbortController().signal;
  const first = pool.decodeGrid(bytes, [0, 0, 1, 1], signal), worker = TestWorker.current;
  const firstId = worker.postMessage.mock.lastCall![0].requestId;
  reply(worker); await first;
  expect(worker.terminate).not.toHaveBeenCalled(); expect(pool.getStatistics()).toMatchObject({created: 1, completed: 1, idle: 1, lastDecodeMs: 5});
  const second = pool.decodeGrid(bytes, [0, 0, 1, 1], signal);
  reply(worker, {grid: createTerrainStreamFixture().grid}, firstId);
  expect(pool.getStatistics()).toMatchObject({completed: 1, active: 1});
  reply(worker); await second;
  expect(TestWorker.instances).toHaveLength(1); expect(bytes.byteLength).toBe(8);
  expect(worker.postMessage.mock.lastCall![0].bytes).not.toBe(bytes);
  expect(pool.getStatistics().lastRoundTripMs).toBeGreaterThanOrEqual(0);
  const snapshot = pool.getStatistics(); snapshot.created = 99;
  expect(pool.getStatistics().created).toBe(1);
  pool.destroy(); pool.destroy(); expect(worker.terminate).toHaveBeenCalledOnce();
});

test('capacity rejects excess jobs without another queue; cancellation replaces only the running worker', async () => {
  vi.stubGlobal('Worker', TestWorker);
  const pool = new TerrainDecoderPool('/terrain-worker.js', 2); pools.push(pool);
  const firstAbort = new AbortController(), secondAbort = new AbortController();
  const first = pool.decodeGrid(new ArrayBuffer(8), [0, 0, 1, 1], firstAbort.signal), firstWorker = TestWorker.current;
  const cancelled = expect(first).rejects.toMatchObject({name: 'AbortError'});
  const second = pool.decodeGrid(new ArrayBuffer(8), [0, 0, 1, 1], secondAbort.signal), secondWorker = TestWorker.current;
  await expect(pool.decodeGrid(new ArrayBuffer(8), [0, 0, 1, 1], new AbortController().signal)).rejects.toThrow('capacity');
  expect(TestWorker.instances).toHaveLength(2); firstAbort.abort(); await cancelled;
  expect(firstWorker.terminate).toHaveBeenCalledOnce(); expect(secondWorker.terminate).not.toHaveBeenCalled();
  const replacement = pool.decodeGrid(new ArrayBuffer(8), [0, 0, 1, 1], new AbortController().signal), replacementWorker = TestWorker.current;
  reply(firstWorker); expect(pool.getStatistics().active).toBe(2);
  reply(replacementWorker); await replacement; reply(secondWorker); await second;
  expect(pool.getStatistics()).toMatchObject({created: 3, completed: 2, cancelled: 1, active: 0, idle: 2});
  pool.destroy(); expect(replacementWorker.terminate).toHaveBeenCalledOnce(); expect(secondWorker.terminate).toHaveBeenCalledOnce();
  await expect(pool.decodeGrid(new ArrayBuffer(8), [0, 0, 1, 1], new AbortController().signal)).rejects.toMatchObject({name: 'AbortError'});
});

test.each(['error', 'messageerror', 'invalid-result', 'wrong-mode'])('failed %s transport is retired rather than reused', async reason => {
  vi.stubGlobal('Worker', TestWorker);
  const pool = new TerrainDecoderPool('/terrain-worker.js', 1); pools.push(pool);
  const pending = pool.decodeGrid(new ArrayBuffer(8), [0, 0, 1, 1], new AbortController().signal), worker = TestWorker.current;
  const result = expect(pending).rejects.toThrow();
  if (reason === 'error') worker.dispatchEvent(new ErrorEvent('error', {message: 'Worker failed', cancelable: true}));
  else if (reason === 'messageerror') worker.dispatchEvent(new Event('messageerror'));
  else if (reason === 'wrong-mode') reply(worker, createTerrainStreamFixture());
  else reply(worker, {grid: {}});
  await result; expect(worker.terminate).toHaveBeenCalledOnce(); expect(pool.getStatistics().failed).toBe(1);
  const recovered = pool.decodeGrid(new ArrayBuffer(8), [0, 0, 1, 1], new AbortController().signal);
  reply(TestWorker.current); await recovered;
  expect(pool.getStatistics()).toMatchObject({created: 2, completed: 1, idle: 1});
});

test('pool teardown cancels active jobs, and invalid source metadata allocates no workers', async () => {
  vi.stubGlobal('Worker', TestWorker);
  for (const capacity of [0, 5, NaN, 1.5]) expect(() => new TerrainDecoderPool('/terrain-worker.js', capacity)).toThrow('capacity');
  expect(() => new TerrainDecoderPool('https://other.invalid/worker.js')).toThrow('same-origin');
  const pool = new TerrainDecoderPool('/terrain-worker.js'); pools.push(pool);
  await expect(pool.decodeGrid(new ArrayBuffer(8 * 1024 * 1024 + 1), [0, 0, 1, 1], new AbortController().signal)).rejects.toThrow('byte limit');
  await expect(pool.decodeGrid(new ArrayBuffer(8), [0, 0, 1, 90], new AbortController().signal)).rejects.toThrow('bounds');
  await expect(pool.decodeMesh(new ArrayBuffer(8), [0, 0, 1, 1], -1, new AbortController().signal)).rejects.toThrow('non-negative');
  expect(TestWorker.instances).toHaveLength(0);
  const pending = pool.decodeGrid(new ArrayBuffer(8), [0, 0, 1, 1], new AbortController().signal);
  const result = expect(pending).rejects.toMatchObject({name: 'AbortError'});
  pool.destroy(); await result;
  expect(TestWorker.current.terminate).toHaveBeenCalledOnce(); expect(pool.getStatistics()).toMatchObject({active: 0, idle: 0, cancelled: 1});
});

test('an abort during worker construction is observed before copying or dispatching the job', async () => {
  const abort = new AbortController();
  vi.stubGlobal('Worker', class extends TestWorker {constructor() {super(); abort.abort();}});
  const pool = new TerrainDecoderPool('/terrain-worker.js'); pools.push(pool);
  await expect(pool.decodeGrid(new ArrayBuffer(8), [0, 0, 1, 1], abort.signal)).rejects.toMatchObject({name: 'AbortError'});
  expect(TestWorker.current.postMessage).not.toHaveBeenCalled(); expect(TestWorker.current.terminate).toHaveBeenCalledOnce();
  expect(pool.getStatistics()).toMatchObject({active: 0, idle: 0, cancelled: 1});
});
