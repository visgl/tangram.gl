// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test, vi} from 'vitest';
import {finishBackendTest} from './backend-paint-tests';

const saveFailure = new Error('the frame could not be saved');
const rejectSave = () => Promise.reject(saveFailure);

describe('finishBackendTest', () => {
  test('a failed save still releases the Deck instance', async () => {
    const release = vi.fn();
    await expect(
      finishBackendTest({errors: [], frame: 'frame', name: 'test', saveFrame: rejectSave, release})
    ).rejects.toBe(saveFailure);
    expect(release).toHaveBeenCalledOnce();
  });

  test('a failed save does not hide the error assertion', async () => {
    const release = vi.fn();
    const result = finishBackendTest({
      errors: ['shader compile failed'],
      frame: 'frame',
      name: 'test',
      saveFrame: rejectSave,
      release
    });
    await expect(result).rejects.toThrow(/shader compile failed/);
    expect(release).toHaveBeenCalledOnce();
  });

  test('a frame is saved and the Deck instance released when the test passes', async () => {
    const release = vi.fn();
    const saveFrame = vi.fn(() => Promise.resolve());
    await finishBackendTest({errors: [], frame: 'frame', name: 'test', saveFrame, release});
    expect(saveFrame).toHaveBeenCalledWith('test', 'frame');
    expect(release).toHaveBeenCalledOnce();
  });

  test('errors fail the test after the frame is saved', async () => {
    const release = vi.fn();
    const saveFrame = vi.fn(() => Promise.resolve());
    await expect(
      finishBackendTest({errors: ['lost context'], frame: 'frame', name: 'test', saveFrame, release})
    ).rejects.toThrow(/lost context/);
    expect(saveFrame).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
});
