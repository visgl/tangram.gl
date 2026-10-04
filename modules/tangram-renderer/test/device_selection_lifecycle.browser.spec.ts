// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, expect, test, vi} from 'vitest';
import type {Device} from '@luma.gl/core';
import FeatureSelection from '../src/selection/selection';
import Scene from '../src/scene/classic_scene';
import WorkerBroker from '../src/utils/worker_broker';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

/** Inspection surface for fields in the not-yet-typed legacy lifecycle. */
type SelectionState = FeatureSelection & {feature: unknown; read_delay_timer: ReturnType<typeof setTimeout> | null;
  _lock_fn: () => boolean};
/** Existing worker response contract used by these lifecycle fixtures. */
type SelectionReply = {id: number; feature: {name: string}};

/** Create controllable asynchronous readback through the public device surface. */
function createSelection(bytes = new Uint8Array([7, 0, 0, 0])) {
  const staging = {destroy: vi.fn(), readAsync: vi.fn(async () => bytes)};
  const texture = {format: 'rgba8unorm', dimension: '2d', samples: 1, width: 256, height: 256};
  const framebuffer = {colorAttachments: [{texture}], destroy: vi.fn()};
  const encoder = {copyTextureToBuffer: vi.fn(), finish: vi.fn(() => ({})), destroy: vi.fn()};
  const device = {type: 'webgl', createFramebuffer: vi.fn(() => framebuffer),
    createBuffer: vi.fn(() => staging), createCommandEncoder: vi.fn(() => encoder), submit: vi.fn()};
  const worker = {};
  const selection = new FeatureSelection({}, [worker], () => false, device as unknown as Device) as SelectionState;
  const broker = WorkerBroker as {postMessage: (...arguments_: unknown[]) => Promise<SelectionReply>};
  const lookup = vi.spyOn(broker, 'postMessage').mockResolvedValue({id: 0, feature: {name: 'building'}});
  return {selection, staging, framebuffer, encoder, lookup, worker};
}

test('device readback looks up the unchanged RGB/worker key and releases its staging buffer', async () => {
  const fixture = createSelection();
  const pending = fixture.selection.getFeatureAt({x: 0.5, y: 0.5}, {radius: undefined});
  await fixture.selection.readDeviceRequests();
  expect(await pending).toMatchObject({feature: {name: 'building'}, changed: true});
  expect(fixture.lookup).toHaveBeenCalledWith(fixture.worker, 'self.getFeatureSelection', {id: 0, key: 7});
  expect(fixture.staging.destroy).toHaveBeenCalledTimes(1);
  expect(fixture.selection.hasPendingRequests()).toBe(false);
  fixture.selection.destroy();
});

test.each([255, 3])('background/reserved or absent worker %s resolves without hanging', async workerId => {
  const fixture = createSelection(new Uint8Array([7, 0, 0, workerId]));
  const pending = fixture.selection.getFeatureAt({x: 0.5, y: 0.5}, {radius: undefined});
  await fixture.selection.readDeviceRequests();
  expect(await pending).toMatchObject({changed: false});
  expect(fixture.lookup).not.toHaveBeenCalled();
  fixture.selection.destroy();
});

test.each(['readback', 'worker'])('%s failure rejects the request and permits a later request', async phase => {
  const fixture = createSelection();
  if (phase === 'readback') fixture.staging.readAsync.mockRejectedValueOnce(new Error('readback failed'));
  else fixture.lookup.mockRejectedValueOnce(new Error('worker failed'));
  const pending = expect(fixture.selection.getFeatureAt({x: 0.5, y: 0.5}, {radius: undefined})).rejects.toThrow(`${phase} failed`);
  await fixture.selection.readDeviceRequests();
  await pending;
  expect(fixture.selection.hasPendingRequests()).toBe(false);
  fixture.lookup.mockResolvedValue({id: 1, feature: {name: 'building'}});
  const recovered = fixture.selection.getFeatureAt({x: 0.5, y: 0.5}, {radius: undefined});
  await fixture.selection.readDeviceRequests();
  expect(await recovered).toMatchObject({feature: {name: 'building'}});
  expect(fixture.staging.destroy).toHaveBeenCalledTimes(2);
  fixture.selection.destroy();
});

test('Scene.getFeatureAt preserves its public error-result contract on device readback failure', async () => {
  const fixture = createSelection();
  const error = new Error('device mapping failed');
  fixture.staging.readAsync.mockRejectedValueOnce(error);
  const scene = {initialized: true, portable_rendering: false, selection_feature_count: 1,
    selection: fixture.selection, view: {size: {css: {width: 256, height: 256}}}};
  const pending = Scene.prototype.getFeatureAt.call(scene, {x: 128, y: 128});
  await fixture.selection.readDeviceRequests();
  expect(await pending).toEqual({error});
  fixture.selection.destroy();
});

test.each(['clear', 'destroy'])('%s during mapping ignores late pixels and prevents duplicate reads', async action => {
  const fixture = createSelection();
  let resolveRead!: (bytes: Uint8Array<ArrayBuffer>) => void;
  fixture.staging.readAsync.mockImplementation(() => new Promise(resolve => { resolveRead = resolve; }));
  const rejected = expect(fixture.selection.getFeatureAt({x: 0.5, y: 0.5}, {radius: undefined})).rejects.toBeDefined();
  const reading = fixture.selection.readDeviceRequests();
  await fixture.selection.readDeviceRequests();
  expect(fixture.staging.readAsync).toHaveBeenCalledTimes(1);
  if (action === 'clear') fixture.selection.clearPendingRequests();
  else fixture.selection.destroy();
  await rejected;
  resolveRead(new Uint8Array([7, 0, 0, 0]));
  await reading;
  expect(fixture.lookup).not.toHaveBeenCalled();
  expect(fixture.selection.feature).toBeNull();
  expect(fixture.staging.destroy).toHaveBeenCalledTimes(1);
  fixture.selection.destroy();
});

test('destroy during worker lookup rejects sent requests and ignores the late worker reply', async () => {
  const fixture = createSelection();
  let resolveWorker!: (message: {id: number; feature: {name: string}}) => void;
  fixture.lookup.mockImplementation(() => new Promise(resolve => { resolveWorker = resolve; }));
  const rejected = expect(fixture.selection.getFeatureAt({x: 0.5, y: 0.5}, {radius: undefined})).rejects.toThrow('destroyed');
  const reading = fixture.selection.readDeviceRequests();
  await vi.waitFor(() => expect(fixture.lookup).toHaveBeenCalledTimes(1));
  fixture.selection.destroy();
  await rejected;
  resolveWorker({id: 0, feature: {name: 'stale'}});
  await reading;
  expect(fixture.selection.feature).toBeNull();
  expect(fixture.framebuffer.destroy).toHaveBeenCalledTimes(1);
});

test('destroy cancels a scheduled read and refuses new requests', async () => {
  vi.useFakeTimers();
  const fixture = createSelection();
  const rejected = expect(fixture.selection.getFeatureAt({x: 0.5, y: 0.5}, {radius: undefined})).rejects.toThrow('destroyed');
  fixture.selection.read();
  fixture.selection.destroy();
  await rejected;
  await vi.runAllTimersAsync();
  expect(fixture.encoder.copyTextureToBuffer).not.toHaveBeenCalled();
  expect(fixture.selection.read_delay_timer).toBeNull();
  await expect(fixture.selection.getFeatureAt({x: 0.5, y: 0.5}, {radius: undefined})).rejects.toThrow('destroyed');
});

test('locked device selection defers reading until a later unlocked render', async () => {
  vi.useFakeTimers();
  const fixture = createSelection(new Uint8Array([0, 0, 0, 255]));
  fixture.selection._lock_fn = () => true;
  const pending = fixture.selection.getFeatureAt({x: 0.5, y: 0.5}, {radius: undefined});
  fixture.selection.read();
  await vi.runAllTimersAsync();
  expect(fixture.staging.readAsync).not.toHaveBeenCalled();
  fixture.selection._lock_fn = () => false;
  fixture.selection.read();
  await vi.runAllTimersAsync();
  expect(await pending).toMatchObject({changed: false});
  fixture.selection.destroy();
});
