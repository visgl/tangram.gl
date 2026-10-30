// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';

test('detects a real browser worker and installs its document shim', async () => {
  const worker = new Worker(new URL('./fixtures/thread-environment.worker.ts', import.meta.url), {
    type: 'module'
  });
  try {
    const result = await new Promise<{thread: {is_worker: boolean; is_main: boolean}; hasDocumentShim: boolean}>(
      (resolve, reject) => {
        worker.onmessage = event => resolve(event.data);
        worker.onerror = event => reject(new Error(event.message));
      }
    );
    expect(result.thread).toEqual({is_worker: true, is_main: false});
    expect(result.hasDocumentShim).toBe(true);
  } finally {
    worker.terminate();
  }
});
