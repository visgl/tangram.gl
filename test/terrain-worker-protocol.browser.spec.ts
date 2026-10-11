// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, expect, test, vi} from 'vitest';
import {decodeTerrainInWorker} from '../examples/terrain/worker-client';

/** Deterministic worker transport; parser conformance uses a real worker separately. */
class TestWorker extends EventTarget {
  /** Last instance belongs only to this test. */
  static current: TestWorker;
  /** Observe ownership release on every settlement path. */
  terminate = vi.fn();
  /** Observe the copied payload and transfer list. */
  postMessage = vi.fn<(message: {bytes: ArrayBuffer}, transfers: ArrayBuffer[]) => void>();
  /** Capture construction without starting an actual worker. */
  constructor() {super(); TestWorker.current = this;}
}
afterEach(() => {vi.unstubAllGlobals(); vi.useRealTimers();});

test.each([{type: 'result', data: {}}, {}, {type: 'error', message: 'decode failed'}])('malformed/error replies reject and terminate the owned worker: %j', response => {
  vi.stubGlobal('Worker', TestWorker);
  const bytes = new ArrayBuffer(8), signal = new AbortController();
  const pending = decodeTerrainInWorker('/terrain-worker.js', bytes, [0, 0, 1, 1], 20, signal.signal);
  const worker = TestWorker.current;
  const sent = worker.postMessage.mock.calls[0];
  expect(sent[0].bytes).not.toBe(bytes); expect(sent[1]).toEqual([sent[0].bytes]);
  worker.dispatchEvent(new MessageEvent('message', {data: response}));
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
