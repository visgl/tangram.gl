// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, it, vi} from 'vitest';
import {createThorDeckAdapter, startThorGestures} from '../examples/webxr/thor-adapter.js';

describe('Thor WebXR example adapter', () => {
  it('loads the installed Thor module without a JavaScript CDN or webcam permission', async () => {
    const {Thor} = await import('thor.gl');
    expect(Thor).toBeTypeOf('function');
  });

  it('uses the logical center-eye viewport for picking', () => {
    const unproject = vi.fn(() => [-74, 40.7]);
    const presentation = {
      eventManager: {},
      getViewState: () => ({longitude: -74, latitude: 40.7}),
      createFrame: () => ({logicalViewport: {unproject}})
    };
    const canvas = {width: 800, height: 600};
    const adapter = createThorDeckAdapter({presentation, canvas});
    expect(adapter.pickObject({x: 320, y: 240})).toEqual({
      coordinate: [-74, 40.7],
      x: 320,
      y: 240
    });
    expect(unproject).toHaveBeenCalledWith([320, 240]);
  });

  it('keeps Thor optional and translates its signals to interaction intents', async () => {
    const listeners = new Map();
    const start = vi.fn();
    const stop = vi.fn();
    class FakeThor {
      on(name, callback) {
        listeners.set(name, callback);
      }
      start = start;
      stop = stop;
    }
    const dispatchInteractionIntent = vi.fn();
    const presentation = {
      eventManager: {},
      getViewState: () => ({}),
      createFrame: () => ({logicalViewport: {}}),
      dispatchInteractionIntent
    };
    const controller = await startThorGestures({
      presentation,
      canvas: {width: 1, height: 1},
      loadThor: async () => ({Thor: FakeThor})
    });
    listeners.get('fist')({confidence: 1});
    expect(start).toHaveBeenCalledOnce();
    expect(dispatchInteractionIntent).toHaveBeenCalledWith({
      type: 'signal',
      action: 'fist',
      data: {confidence: 1}
    });
    controller.stop();
    expect(stop).toHaveBeenCalledOnce();
  });
});
