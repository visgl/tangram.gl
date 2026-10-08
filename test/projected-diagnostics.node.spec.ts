// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, expect, test, vi} from 'vitest';
import {createProjectedDiagnosticsPoller, formatProjectedDiagnostics} from '../examples/projected/diagnostics.js';

const resources = {activeBuilds: 1, queuedBuilds: 2, cachedTiles: 3, cachedMeshBytes: 1200000};
const projectionWork = {completedMeshes: 2, failedMeshes: 1, sourceVertices: 6, outputVertices: 12,
  outputTriangles: 8, projectionBatches: 4, projectedPositions: 90, edgeRounds: 2, interiorRounds: 1};
afterEach(() => vi.useRealTimers());

/** Controllable async fixture using the repository's ES2022 baseline. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {throw new Error('Promise not initialized');};
  const promise = new Promise<T>(resolvePromise => {resolve = resolvePromise;});
  return {promise, resolve};
}

test('diagnostics sum optional work snapshots without conflating current cache residency or mutating inputs', () => {
  const workers = [{workerId: 0}, {projectionWork}, {projectionWork: {...projectionWork}}];
  const before = structuredClone(workers);
  const text = formatProjectedDiagnostics(workers, resources);
  expect(text).toContain('4 meshes, 12 → 24 vertices, 16 triangles');
  expect(text).toContain('4 edge / 2 interior rounds');
  expect(text).toContain('8 batches / 180 positions; 2 failures');
  expect(text).toContain('1 active / 2 queued builds, 3 evictable tiles (1.2 MB');
  expect(workers).toEqual(before);
  expect(formatProjectedDiagnostics([], resources)).toContain('Waiting');
});

test('polling skips unloaded scenes, never overlaps requests and discards replacement/disposal replies', async () => {
  vi.useFakeTimers();
  const first = deferred<unknown[]>();
  const second = deferred<unknown[]>();
  const getStatistics = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const firstScene = {getTileSourceStatistics: getStatistics, tile_manager: {getResourceStatistics: () => resources}};
  let scene: typeof firstScene | undefined;
  const updateText = vi.fn();
  const poller = createProjectedDiagnosticsPoller(() => scene, updateText);
  await vi.advanceTimersByTimeAsync(1000);
  expect(getStatistics).not.toHaveBeenCalled();
  scene = firstScene;
  const pending = poller.update();
  await vi.advanceTimersByTimeAsync(3000);
  expect(getStatistics).toHaveBeenCalledTimes(1);
  scene = {...firstScene};
  first.resolve([{projectionWork}]);
  await pending;
  expect(updateText).not.toHaveBeenCalled();
  const later = poller.update();
  poller.destroy();
  second.resolve([{projectionWork}]);
  await later;
  await vi.advanceTimersByTimeAsync(3000);
  expect(updateText).not.toHaveBeenCalled();
  expect(getStatistics).toHaveBeenCalledTimes(2);
});

test('polling reports failures without blocking subsequent successful diagnostics', async () => {
  vi.useFakeTimers();
  const getStatistics = vi.fn().mockRejectedValueOnce(new Error('worker unavailable')).mockResolvedValue([{projectionWork}]);
  const scene = {getTileSourceStatistics: getStatistics, tile_manager: {getResourceStatistics: () => resources}};
  const updateText = vi.fn();
  const poller = createProjectedDiagnosticsPoller(() => scene, updateText);
  await poller.update();
  expect(updateText).toHaveBeenLastCalledWith('Diagnostics unavailable: worker unavailable');
  await poller.update();
  expect(updateText.mock.lastCall?.[0]).toContain('2 meshes');
  poller.destroy();
});
