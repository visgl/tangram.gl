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
