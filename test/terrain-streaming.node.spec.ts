// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import {TerrainTileset} from '../examples/terrain/terrain-tileset';
import {selectTerrainTiles, getTerrainTileKey, getTerrainParent, type TerrainTileCoordinate} from '../examples/terrain/tile-selection';
import {createTerrainStreamFixture} from './terrain-stream-fixture';
import type {TerrainTileData} from '../examples/terrain/decode-terrain';

/** Controlled completion without timers or public network. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(complete => {resolve = complete;});
  return {promise, resolve};
}
const child = {zoom: 2, column: 2, row: 2};
const sibling = {...child, column: 3};

test('coarse fallback waits for all selected siblings, stays non-overlapping and reuses warm bytes', async () => {
  const jobs = new Map<string, ReturnType<typeof deferred<TerrainTileData>>>();
  const fetch = vi.fn(async () => new ArrayBuffer(8));
  const decode = vi.fn((_bytes: ArrayBuffer, tile: TerrainTileCoordinate) => {const job = deferred<TerrainTileData>(); jobs.set(getTerrainTileKey(tile), job); return job.promise;});
  const tileset = new TerrainTileset({fetch, decode, onChange() {}, maxRequests: 2});
  try {
    tileset.update([child, sibling]);
    await vi.waitFor(() => expect(jobs.size).toBe(2));
    expect(tileset.getStatistics()).toMatchObject({active: 2, queued: 1});
    jobs.get('1/1/1')!.resolve(createTerrainStreamFixture());
    await vi.waitFor(() => expect(jobs.size).toBe(3));
    expect(tileset.getDrawableTiles().map(tile => tile.key)).toEqual(['1/1/1']);
    jobs.get('2/2/2')!.resolve(createTerrainStreamFixture());
    await vi.waitFor(() => expect(tileset.records.get('2/2/2')?.data).toBeDefined());
    expect(tileset.getDrawableTiles().map(tile => tile.key)).toEqual(['1/1/1']);
    jobs.get('2/3/2')!.resolve(createTerrainStreamFixture());
    await tileset.waitForIdle();
    expect(tileset.getDrawableTiles().map(tile => tile.key)).toEqual(['2/2/2', '2/3/2']);
    tileset.update([]); tileset.update([child, sibling]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(decode).toHaveBeenCalledTimes(3);
    tileset.update([child, sibling], 5);
    await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(5));
    expect(fetch).toHaveBeenCalledTimes(3);
    jobs.get('1/1/1')!.resolve(createTerrainStreamFixture()); jobs.get('2/2/2')!.resolve(createTerrainStreamFixture());
    await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(6));
    jobs.get('2/3/2')!.resolve(createTerrainStreamFixture()); await tileset.waitForIdle();
    expect(tileset.records.get('2/3/2')?.meshMaxError).toBe(5);
  } finally {tileset.destroy();}
});

test('cancelled generations terminate ownership and cannot publish late data; teardown settles waiters', async () => {
  const jobs: {signal: AbortSignal; job: ReturnType<typeof deferred<TerrainTileData>>}[] = [];
  const tileset = new TerrainTileset({fetch: async () => new ArrayBuffer(8), decode: (_bytes, _tile, _error, signal) => {const job = deferred<TerrainTileData>(); jobs.push({signal, job}); return job.promise;}, onChange() {}});
  tileset.update([child]);
  await vi.waitFor(() => expect(jobs).toHaveLength(2));
  tileset.update([child], 5);
  await vi.waitFor(() => expect(jobs).toHaveLength(4));
  expect(jobs[0].signal.aborted).toBe(true);
  jobs[0].job.resolve(createTerrainStreamFixture()); jobs[1].job.resolve(createTerrainStreamFixture());
  await Promise.resolve();
  expect(tileset.getDrawableTiles()).toEqual([]);
  const idle = tileset.waitForIdle(); tileset.destroy(); tileset.destroy(); await idle;
  expect(jobs.every(job => job.signal.aborted)).toBe(true);
  jobs.slice(2).forEach(job => job.job.resolve(createTerrainStreamFixture()));
  await Promise.resolve();
  expect(tileset.records.size).toBe(0);
});

test('failures retry explicitly; cache budgets evict only off-screen records', async () => {
  let fail = true;
  const fetch = vi.fn(async () => {if (fail) throw new Error('offline'); return new ArrayBuffer(8);});
  const decode = vi.fn(async () => createTerrainStreamFixture());
  const tileset = new TerrainTileset({fetch, decode, onChange() {}, maxCachedTiles: 0, maxCachedBytes: 0});
  tileset.update([child]); await tileset.waitForIdle();
  expect(tileset.getStatistics().failed).toBe(2);
  tileset.update([child]); await tileset.waitForIdle(); expect(fetch).toHaveBeenCalledTimes(2);
  fail = false; tileset.retry(); await tileset.waitForIdle();
  expect(tileset.getStatistics()).toMatchObject({failed: 0, resident: 2});
  expect(tileset.getStatistics().bytes).toBeGreaterThan(16);
  tileset.update([]); expect(tileset.records.size).toBe(0);
  tileset.destroy(); tileset.update([child]); expect(tileset.records.size).toBe(0);
});

test('z0 needs no fallback and unchanged selection does not interrupt an active job', async () => {
  const job = deferred<TerrainTileData>();
  const decode = vi.fn(() => job.promise);
  const tileset = new TerrainTileset({fetch: async () => new ArrayBuffer(1), decode, onChange() {}});
  tileset.update([{zoom: 0, column: 0, row: 0}]);
  await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
  tileset.update([{zoom: 0, column: 0, row: 0}]);
  job.resolve(createTerrainStreamFixture()); await tileset.waitForIdle();
  expect(decode).toHaveBeenCalledOnce(); expect(tileset.getDrawableTiles()).toHaveLength(1);
  tileset.destroy();
});

test('invalid budgets and noncanonical or unbounded selections reject before scheduling', () => {
  const options = {fetch: async () => new ArrayBuffer(1), decode: async () => createTerrainStreamFixture(), onChange() {}};
  for (const budget of [{maxRequests: 0}, {maxRequests: 5}, {maxCachedTiles: -1}, {maxCachedBytes: NaN}]) expect(() => new TerrainTileset({...options, ...budget})).toThrow();
  const tileset = new TerrainTileset(options);
  for (const coordinate of [{...child, column: -1}, {...child, row: 4}, {...child, zoom: NaN}, {...child, zoom: 13}]) expect(() => tileset.update([coordinate])).toThrow();
  expect(() => tileset.update([child, child])).toThrow();
  expect(() => tileset.update(Array(26).fill(child))).toThrow();
  expect(() => tileset.update([child], -1)).toThrow(); tileset.destroy();
});

test.each([{zoom: 30, longitude: 181, latitude: 90}, {zoom: -1, longitude: -181, latitude: -90}, {zoom: 8, longitude: 179.9, latitude: 0}])('selection is bounded, canonical and provider-limited: %j', camera => {
  const tiles = selectTerrainTiles({...camera, getBounds: () => [-1e9, -90, 1e9, 90]});
  expect(tiles.length).toBeGreaterThan(0); expect(tiles.length).toBeLessThanOrEqual(9);
  expect(new Set(tiles.map(getTerrainTileKey)).size).toBe(tiles.length);
  for (const tile of tiles) {expect(tile.zoom).toBeLessThanOrEqual(12); expect(tile.zoom).toBeGreaterThanOrEqual(0); expect(tile.column).toBeGreaterThanOrEqual(0); expect(tile.column).toBeLessThan(2 ** tile.zoom);}
});
test('nonfinite horizon bounds have a local fallback; invalid camera and budgets reject', () => {
  const view = {zoom: 11, longitude: 7, latitude: 46, getBounds: (): [number, number, number, number] => [NaN, NaN, NaN, NaN]};
  expect(selectTerrainTiles(view)).toHaveLength(9);
  expect(() => selectTerrainTiles({...view, zoom: NaN})).toThrow();
  expect(() => selectTerrainTiles(view, 26)).toThrow();
  expect(getTerrainParent({zoom: 0, column: 0, row: 0})).toBeNull();
});
