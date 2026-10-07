// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test, vi} from 'vitest';
import {WebXRInputAdapter, setWebXRSessionWithFallback}
  from '@vis.gl/tangram-layers/experimental/webxr';

describe('WebXR reference-space negotiation', () => {
  test('tries local-floor first and falls back only when unsupported', async () => {
    const session = {};
    const manager = {setSession: vi.fn().mockRejectedValueOnce(new DOMException('Unsupported', 'NotSupportedError'))
      .mockResolvedValueOnce(undefined)};
    expect(await setWebXRSessionWithFallback(manager, session)).toBe('local');
    expect(manager.setSession.mock.calls).toEqual([
      [session, {referenceSpaceType: 'local-floor'}], [session, {referenceSpaceType: 'local'}]
    ]);
  });

  test('returns the preferred space without requesting another one', async () => {
    const manager = {setSession: vi.fn().mockResolvedValue(undefined)};
    expect(await setWebXRSessionWithFallback(manager, {}, ['bounded-floor', 'local'])).toBe('bounded-floor');
    expect(manager.setSession).toHaveBeenCalledTimes(1);
  });

  test.each([new Error('Session ended'), new DOMException('Denied', 'SecurityError')])
    ('propagates %s without retrying or hiding the cause', async error => {
      const manager = {setSession: vi.fn().mockRejectedValue(error)};
      await expect(setWebXRSessionWithFallback(manager, {})).rejects.toBe(error);
      expect(manager.setSession).toHaveBeenCalledTimes(1);
    });

  test('preserves the last unsupported-space error after exhausting fallbacks', async () => {
    const error = new DOMException('No local space', 'NotSupportedError');
    const manager = {setSession: vi.fn().mockRejectedValue(error)};
    await expect(setWebXRSessionWithFallback(manager, {})).rejects.toBe(error);
    expect(manager.setSession).toHaveBeenCalledTimes(2);
  });

  test('rejects an empty preference list without touching the session', async () => {
    const manager = {setSession: vi.fn()};
    await expect(setWebXRSessionWithFallback(manager, {}, [])).rejects.toThrow('No requested WebXR reference space');
    expect(manager.setSession).not.toHaveBeenCalled();
  });
});

describe('WebXR gamepad navigation boundaries', () => {
  test.each([undefined, null, {axes: []}, {axes: [1]}, {axes: [0.1, -0.1]}])
    ('ignores absent, incomplete, or deadzone input: %j', gamepad => {
      expect(new WebXRInputAdapter().update([{index: 0, gamepad}])).toEqual([]);
    });

  test('supports two-axis controllers and independent movement/turn deadzones', () => {
    const adapter = new WebXRInputAdapter({moveDeadzone: 0.2, turnDeadzone: 0.6, moveSpeed: 2, turnSpeed: 90});
    expect(adapter.update([{index: 0, gamepad: {axes: [0.2, -0.5]}}], 0.5))
      .toEqual([{type: 'navigate', action: 'move', delta: [0.2, 0.5], handedness: undefined}]);
    expect(adapter.update([{index: 1, handedness: 'right', gamepad: {axes: [0.59, 1]}}])).toEqual([]);
    expect(adapter.update([{index: 1, handedness: 'right', gamepad: {axes: [-0.6, 1]}}], 0.5))
      .toEqual([{type: 'navigate', action: 'turn', delta: [-45], handedness: 'right'}]);
  });

  test('uses default elapsed time and clamps negative elapsed time to zero', () => {
    const adapter = new WebXRInputAdapter();
    const input = [{index: 0, gamepad: {axes: [1, -1]}}];
    expect(adapter.update(input)).toEqual([{type: 'navigate', action: 'move', delta: [1 / 60, 1 / 60], handedness: undefined}]);
    expect(adapter.update(input, -1)).toEqual([{type: 'navigate', action: 'move', delta: [0, 0], handedness: undefined}]);
  });
});
