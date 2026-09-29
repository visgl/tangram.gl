// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

describe('renderer runtime support', () => {
  let Task;
  let subscribeMixin;
  let debounce;
  let getExtension;
  let debugSettings;
  let mergeDebugSettings;
  let MediaCapture;

  beforeAll(async () => {
    globalThis.self = globalThis;
    globalThis.self.addEventListener = () => {};
    ({default: Task} = await import('../modules/tangram-renderer/src/utils/task.js'));
    ({default: subscribeMixin} = await import('../modules/tangram-renderer/src/utils/subscribe.ts'));
    ({default: debounce} = await import('../modules/tangram-renderer/src/utils/debounce.ts'));
    ({default: getExtension} = await import('../modules/tangram-renderer/src/gl/extensions.ts'));
    ({default: debugSettings, mergeDebugSettings} = await import('../modules/tangram-renderer/src/utils/debug_settings.js'));
    ({default: MediaCapture} = await import('../modules/tangram-renderer/src/utils/media_capture.js'));
  });

  beforeEach(() => {
    Task.queue.length = 0;
    Task.start_time = null;
    Task.state = {};
  });

  it('schedules, pauses, finishes, cancels and removes tasks', async () => {
    const calls = [];
    const task = {run: currentTask => {calls.push(currentTask.stats.calls); return true;}};
    const promise = Task.add(task);
    expect(task.id).toBeGreaterThanOrEqual(0);
    expect(calls).toEqual([1]);
    expect(Task.queue).toContain(task);
    await Task.finish(task, 'done');
    expect(await promise).toBe('done');
    expect(Task.queue).not.toContain(task);

    const paused = {pause: 1, run: vi.fn(() => true)};
    Task.add(paused);
    Task.process(paused);
    expect(paused.run).toHaveBeenCalledTimes(1);
    const skipped = {user_moving_view: false, run: vi.fn(() => true)};
    Task.setState({user_moving_view: true});
    Task.process(skipped);
    expect(skipped.run).not.toHaveBeenCalled();

    const cancellable = {cancel: vi.fn(() => 'cancelled'), run: () => false};
    const cancelledPromise = Task.add(cancellable);
    Task.cancel(cancellable);
    expect(await cancelledPromise).toBe('cancelled');
    Task.add({...cancellable, tile_id: 'tile'});
    Task.removeForTile('tile');
    expect(Task.queue.some(queuedTask => queuedTask.tile_id === 'tile')).toBe(false);
  });

  it('processes task queues within frame budgets and exposes continuation state', () => {
    const task = {max_time: 1, pause_factor: 2, run: currentTask => {currentTask.elapsed = 10; return false;}};
    Task.add(task);
    Task.processAll();
    expect(task.pause).toBe(2);
    task.start_time = performance.now() - 10;
    Task.start_time = performance.now() - 10;
    expect(Task.shouldContinue(task)).toBe(false);
    Task.process(task);
    expect(task.pause).toBe(1);
    Task.remove(task);
    expect(Task.queue).not.toContain(task);
  });

  it('mixes event subscriptions without duplicate listeners', () => {
    const target = subscribeMixin({});
    const listener = {change: vi.fn(), other: 'not a function'};
    target.subscribe(listener);
    target.subscribe(listener);
    expect(target.hasSubscribersFor('change')).toBe(true);
    target.trigger('change', 1, 2);
    expect(listener.change).toHaveBeenCalledWith(1, 2);
    target.trigger('other');
    target.unsubscribe(listener);
    expect(target.hasSubscribersFor('change')).toBe(false);
    target.unsubscribe(listener);
    target.subscribe(listener);
    target.unsubscribeAll();
    expect(target.hasSubscribersFor('change')).toBe(false);
  });

  it('debounces calls and preserves receiver and latest arguments', () => {
    vi.useFakeTimers();
    const calls = [];
    const target = {value: 4, call: debounce(function call(value) {calls.push(this.value + value);}, 20)};
    target.call(1);
    target.call(2);
    vi.advanceTimersByTime(19);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual([6]);
    vi.useRealTimers();
  });

  it('caches WebGL extensions per context and name', () => {
    const calls = [];
    const extension = {name: 'oes'};
    const gl = {getExtension: name => {calls.push(name); return name === 'OES_element_index_uint' ? extension : undefined;}};
    expect(getExtension(gl, 'OES_element_index_uint')).toBe(extension);
    expect(getExtension(gl, 'OES_element_index_uint')).toBe(extension);
    expect(calls).toEqual(['OES_element_index_uint']);
    expect(getExtension(gl, 'WEBGL_debug_renderer_info')).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it('merges debug flags', () => {
    const originalWireframe = debugSettings.wireframe;
    mergeDebugSettings({wireframe: !originalWireframe});
    expect(debugSettings.wireframe).toBe(!originalWireframe);
    mergeDebugSettings({wireframe: originalWireframe});
  });

  it('reports unsupported media capture without browser APIs', async () => {
    globalThis.self.postMessage = () => {};
    const capture = new MediaCapture();
    const originalWindow = globalThis.window;
    Reflect.deleteProperty(globalThis, 'window');
    try {
      expect(capture.startVideoCapture()).toBe(false);
    } finally {
      globalThis.window = originalWindow;
    }
    expect(await capture.stopVideoCapture()).toEqual({});
    const canvas = {width: 1, height: 1};
    capture.setCanvas(canvas, {});
    const screenshot = capture.screenshot();
    expect(capture.screenshot()).toBe(screenshot);
    expect(capture.queue_screenshot.background).toBeUndefined();
  });
});
