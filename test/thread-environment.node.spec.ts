// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import Thread from '../modules/tangram-renderer/src/utils/thread';

test('Node is neither a browser main thread nor a web worker', () => {
  expect(Thread).toEqual({is_worker: false, is_main: false});
  expect('window' in globalThis).toBe(false);
  expect('document' in globalThis).toBe(false);
});
