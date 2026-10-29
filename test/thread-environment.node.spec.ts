// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import Thread from '../modules/tangram-renderer/src/utils/thread';
import log from '../modules/tangram-renderer/src/utils/log';

test('Node is neither a browser main thread nor a web worker', () => {
  expect(Thread).toEqual({is_worker: false, is_main: false});
  expect('window' in globalThis).toBe(false);
  expect('document' in globalThis).toBe(false);
});

test('server-side logging uses the console without a worker bridge', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect(await log('warn', 'server diagnostic')).toBe(true);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('server diagnostic'));
    expect(log.reset).toBeTypeOf('function');
  } finally {
    warning.mockRestore();
  }
});

test('a worker initializes its shims and handles broker messages', async () => {
  class TestWorkerScope {
    static [Symbol.hasInstance](value: unknown): boolean {
      return value === globalThis;
    }
  }

  let handleMessage: ((event: {data: unknown}) => void) | undefined;
  const postMessage = vi.fn();
  vi.stubGlobal('WorkerGlobalScope', TestWorkerScope);
  vi.stubGlobal('self', globalThis);
  vi.stubGlobal('addEventListener', (_type: string, handler: (event: {data: unknown}) => void) => {
    handleMessage = handler;
  });
  vi.stubGlobal('postMessage', postMessage);
  vi.resetModules();
  try {
    const {default: workerThread} = await import('../modules/tangram-renderer/src/utils/thread');
    await import('../modules/tangram-renderer/src/utils/log');
    const {default: broker} = await import('../modules/tangram-renderer/src/utils/worker_broker');
    expect(workerThread).toEqual({is_worker: true, is_main: false});
    expect(Reflect.get(Reflect.get(globalThis, 'window'), 'document')).toBe(
      Reflect.get(globalThis, 'document')
    );

    broker.addTarget('math', {double: (value: number) => value * 2});
    expect(handleMessage).toBeDefined();
    handleMessage?.({data: {type: 'main_send', message_id: 7, method: 'math.double', message: [3]}});
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({type: 'worker_reply', message_id: 7, message: 6}),
      []
    );
  } finally {
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'document');
    vi.unstubAllGlobals();
    vi.resetModules();
  }
});
