// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import {TerrainTileset} from '../examples/terrain/terrain-tileset';
import {selectTerrainTiles, getTerrainTileKey, getTerrainParent, type TerrainTileCoordinate} from '../examples/terrain/tile-selection';
import {createTerrainStreamFixture} from './terrain-stream-fixture';
import type {TerrainTileData, TerrainGridData} from '../examples/terrain/terrain-payload';

/** Controlled completion without timers or public network. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(complete => {resolve = complete;});
  return {promise, resolve};
}
const child = {zoom: 2, column: 2, row: 2};
const sibling = {...child, column: 3};

test('grid-only payload admission retains parent coverage without unused mesh bytes and stays warm', async () => {
  const fetch = vi.fn(async () => new ArrayBuffer(8));
  const decode = vi.fn(async () => ({grid: createTerrainStreamFixture().grid}));
  const tileset = new TerrainTileset<TerrainGridData>({fetch, decode, minZoom: 1, maxResidentBytes: 84, onChange() {}});
  tileset.update([child, sibling]); await tileset.waitForIdle();
  expect(tileset.getStatistics()).toMatchObject({bytes: 84, sourceBytes: 24, gridBytes: 60, meshBytes: 0, failed: 0});
  expect(tileset.getDrawableTiles()).toHaveLength(2);
  tileset.update([child]); await tileset.waitForIdle();
  expect(fetch).toHaveBeenCalledTimes(3); expect(decode).toHaveBeenCalledTimes(3);
  tileset.destroy(); expect(tileset.getStatistics()).toMatchObject({bytes: 0, sourceBytes: 0, gridBytes: 0, meshBytes: 0});
});

test('memory categories count shared backing storage once and preserve existing admission totals', async () => {
  const data = createTerrainStreamFixture();
  data.mesh.attributes.SHARED_HEIGHT = {size: 1, value: data.grid.heights};
  const tileset = new TerrainTileset({fetch: async () => new ArrayBuffer(8), decode: async () => data, minZoom: 2, onChange() {}});
  tileset.update([child]); await tileset.waitForIdle();
  const statistics = tileset.getStatistics();
  expect(statistics.bytes).toBe(statistics.sourceBytes + statistics.gridBytes + statistics.meshBytes);
  expect(statistics).toMatchObject({bytes: 132, sourceBytes: 8, gridBytes: 20, meshBytes: 104});
  tileset.destroy();
});

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
  for (const budget of [{maxRequests: 0}, {maxRequests: 5}, {maxCachedTiles: -1}, {maxCachedBytes: NaN}, {maxResidentBytes: -1}, {maxResidentBytes: Infinity}, {maxResidentBytes: 1.5}]) expect(() => new TerrainTileset({...options, ...budget})).toThrow();
  const tileset = new TerrainTileset(options);
  for (const coordinate of [{...child, column: -1}, {...child, row: 4}, {...child, zoom: NaN}, {...child, zoom: 13}]) expect(() => tileset.update([coordinate])).toThrow();
  expect(() => tileset.update([child, child])).toThrow();
  expect(() => tileset.update([child, {zoom: 3, column: 4, row: 4}])).toThrow('one source zoom');
  expect(() => tileset.update(Array(26).fill(child))).toThrow();
  expect(() => tileset.update([child], -1)).toThrow(); tileset.destroy();
});

test('hard resident budget includes protected children and preserves coarse coverage on admission failure', async () => {
  const snapshots: number[] = [];
  const tileset = new TerrainTileset({fetch: async () => new ArrayBuffer(8), decode: async () => createTerrainStreamFixture(), maxRequests: 1, maxResidentBytes: 200, onChange() {snapshots.push(tileset.getStatistics().bytes);}});
  try {
    tileset.update([child]); await tileset.waitForIdle();
    expect(tileset.getStatistics()).toMatchObject({bytes: 140, byteLimit: 200, failed: 1});
    expect(tileset.getDrawableTiles().map(record => record.key)).toEqual(['1/1/1']);
    expect(tileset.records.get('2/2/2')?.error).toContain('retained-array budget');
    expect(snapshots.every(bytes => bytes <= 200)).toBe(true);
  } finally {tileset.destroy();}
});

test('oversized downloads do not enter the cache or start decoding', async () => {
  const decode = vi.fn(async () => createTerrainStreamFixture());
  const tileset = new TerrainTileset({fetch: async () => new ArrayBuffer(33), decode, maxResidentBytes: 32, onChange() {}});
  try {
    tileset.update([{zoom: 0, column: 0, row: 0}]); await tileset.waitForIdle();
    expect(decode).not.toHaveBeenCalled();
    expect(tileset.getStatistics()).toMatchObject({bytes: 0, failed: 1});
    expect(tileset.records.get('0/0/0')?.bytes).toBeUndefined();
  } finally {tileset.destroy();}
});

test.each([{first: 'parent', budget: 132}, {first: 'child', budget: 132}, {first: 'parent', budget: 200}, {first: 'child', budget: 200}])('concurrent $first-first decoding preserves parent admission at $budget bytes', async ({first, budget}) => {
  const jobs = new Map<string, ReturnType<typeof deferred<TerrainTileData>>>();
  const fetch = vi.fn(async () => new ArrayBuffer(8));
  const tileset = new TerrainTileset({fetch, decode: (_bytes, tile) => {const job = deferred<TerrainTileData>(); jobs.set(getTerrainTileKey(tile), job); return job.promise;}, maxResidentBytes: budget, onChange() {}});
  try {
    tileset.update([child]); await vi.waitFor(() => expect(jobs.size).toBe(2));
    if (first === 'child') {
      jobs.get('2/2/2')!.resolve(createTerrainStreamFixture()); await Promise.resolve(); await Promise.resolve();
      expect(tileset.records.get('2/2/2')?.data).toBeUndefined();
    }
    jobs.get('1/1/1')!.resolve(createTerrainStreamFixture());
    if (first === 'parent') jobs.get('2/2/2')!.resolve(createTerrainStreamFixture());
    await tileset.waitForIdle();
    expect(tileset.getDrawableTiles().map(record => record.key)).toEqual(['1/1/1']);
    expect(tileset.getStatistics().bytes).toBeLessThanOrEqual(budget);
    expect(tileset.records.get('2/2/2')?.error).toContain('retained-array budget');
    const previousChild = jobs.get('2/2/2');
    tileset.retry();
    if (budget === 200) {
      await vi.waitFor(() => expect(jobs.get('2/2/2')).not.toBe(previousChild));
      jobs.get('2/2/2')!.resolve(createTerrainStreamFixture());
    }
    await tileset.waitForIdle();
    expect(tileset.getDrawableTiles().map(record => record.key)).toEqual(['1/1/1']);
    expect(tileset.getStatistics().bytes).toBeLessThanOrEqual(budget);
  } finally {tileset.destroy();}
});

test('navigation cancels decoded admission waiters without retaining stale payloads or idle ownership', async () => {
  const parent = deferred<TerrainTileData>();
  const decode = vi.fn(async (_bytes: ArrayBuffer, tile: TerrainTileCoordinate) => tile.zoom === 1 ? parent.promise : createTerrainStreamFixture());
  const tileset = new TerrainTileset({fetch: async () => new ArrayBuffer(8), decode, onChange() {}});
  try {
    tileset.update([child]); await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(2));
    await Promise.resolve(); expect(tileset.records.get('2/2/2')?.data).toBeUndefined();
    tileset.update([]); await tileset.waitForIdle();
    parent.resolve(createTerrainStreamFixture()); await Promise.resolve(); await Promise.resolve();
    expect([...tileset.records.values()].every(record => !record.data)).toBe(true);
    expect(tileset.getStatistics()).toMatchObject({active: 0, queued: 0});
  } finally {tileset.destroy();}
});

test.each([1, 2])('expanded selection starts queued parents ahead of old detail with %i request slots', async maxRequests => {
  const jobs: {key: string; signal: AbortSignal; job: ReturnType<typeof deferred<TerrainTileData>>}[] = [];
  const fetch = vi.fn(async () => new ArrayBuffer(8));
  const tileset = new TerrainTileset({fetch, maxRequests, maxResidentBytes: 264, decode: (_bytes, tile, _error, signal) => {
    const job = deferred<TerrainTileData>(); jobs.push({key: getTerrainTileKey(tile), signal, job}); return job.promise;
  }, onChange() {}});
  try {
    tileset.update([child]);
    await vi.waitFor(() => expect(jobs.some(job => job.key === '1/1/1')).toBe(true));
    jobs.find(job => job.key === '1/1/1')!.job.resolve(createTerrainStreamFixture());
    await vi.waitFor(() => expect(jobs.some(job => job.key === '2/2/2')).toBe(true));
    const oldDetail = jobs.find(job => job.key === '2/2/2')!;
    const adjacent = {...child, column: 0};
    tileset.update([child, adjacent]);
    expect(oldDetail.signal.aborted).toBe(true);
    oldDetail.job.resolve(createTerrainStreamFixture());
    await vi.waitFor(() => expect(jobs.some(job => job.key === '1/0/1')).toBe(true));
    expect(tileset.records.get('2/2/2')?.data).toBeUndefined();
    jobs.find(job => job.key === '1/0/1')!.job.resolve(createTerrainStreamFixture());
    await tileset.waitForIdle();
    expect(tileset.getDrawableTiles().map(record => record.key)).toEqual(['1/1/1', '1/0/1']);
    expect(tileset.getStatistics()).toMatchObject({bytes: 264, active: 0, queued: 0});
    expect(tileset.records.get('1/0/1')?.error).toBeUndefined();
  } finally {tileset.destroy();}
});

test('a failed parent releases lower-priority completed data rather than stalling admission', async () => {
  let failParent = () => {};
  const parent = new Promise<ArrayBuffer>((_resolve, reject) => {failParent = () => reject(new Error('parent offline'));});
  const decode = vi.fn(async () => createTerrainStreamFixture());
  const tileset = new TerrainTileset({fetch: async tile => tile.zoom === 1 ? parent : new ArrayBuffer(8), decode, onChange() {}});
  try {
    tileset.update([child]); await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
    expect(tileset.getDrawableTiles()).toEqual([]);
    failParent(); await tileset.waitForIdle();
    expect(tileset.getDrawableTiles().map(record => record.key)).toEqual(['2/2/2']);
    expect(tileset.getStatistics()).toMatchObject({active: 0, queued: 0, failed: 1});
  } finally {tileset.destroy();}
});

test.each([{maxRequests: 1, failure: 'decode'}, {maxRequests: 2, failure: 'decode'}, {maxRequests: 1, failure: 'admission'}, {maxRequests: 2, failure: 'admission'}])('failed-parent bytes yield to completed detail after $failure with $maxRequests request slots', async ({maxRequests, failure}) => {
  const tileset = new TerrainTileset({maxRequests, maxResidentBytes: 132, fetch: async () => new ArrayBuffer(8), decode: async (_bytes, tile) => {
    if (tile.zoom === 1 && failure === 'decode') throw new Error('parent decode failed');
    const data = createTerrainStreamFixture();
    if (tile.zoom === 1) data.mesh.attributes.POSITION.value = new Float32Array(128);
    return data;
  }, onChange() {}});
  try {
    tileset.update([child]); await tileset.waitForIdle();
    expect(tileset.getDrawableTiles().map(record => record.key)).toEqual(['2/2/2']);
    expect(tileset.getStatistics()).toMatchObject({bytes: 132, active: 0, queued: 0, failed: 1});
    const parent = tileset.records.get('1/1/1')!;
    expect(parent.bytes).toBeUndefined();
    expect(parent.error).toContain(failure === 'decode' ? 'parent decode failed' : 'retained-array budget');
    const previous = tileset.records.get('2/2/2')?.data;
    tileset.retry(); await tileset.waitForIdle();
    expect(tileset.records.get('2/2/2')?.data).toBe(previous);
    expect(tileset.getDrawableTiles().map(record => record.key)).toEqual(['2/2/2']);
    expect(tileset.getStatistics().bytes).toBe(132);
  } finally {tileset.destroy();}
});

test('atomic topology replacement preserves warm bytes and previous mesh when the hard budget rejects it', async () => {
  let oversized = false;
  const fetch = vi.fn(async () => new ArrayBuffer(8));
  const decode = vi.fn(async () => {
    const data = createTerrainStreamFixture();
    if (oversized) data.mesh.attributes.POSITION.value = new Float32Array(128);
    return data;
  });
  const tileset = new TerrainTileset({fetch, decode, minZoom: 2, maxResidentBytes: 132, onChange() {}});
  try {
    tileset.update([child]); await tileset.waitForIdle();
    const previous = tileset.records.get('2/2/2')?.data;
    oversized = true; tileset.update([child], 5); await tileset.waitForIdle();
    expect(tileset.getStatistics()).toMatchObject({bytes: 132, failed: 1});
    expect(tileset.records.get('2/2/2')?.data).toBe(previous);
    expect(tileset.records.get('2/2/2')?.meshMaxError).toBe(20);
    oversized = false; tileset.retry(); await tileset.waitForIdle();
    expect(fetch).toHaveBeenCalledOnce(); expect(decode).toHaveBeenCalledTimes(3);
    expect(tileset.records.get('2/2/2')?.meshMaxError).toBe(5);
    expect(tileset.getStatistics()).toMatchObject({bytes: 132, failed: 0});
  } finally {tileset.destroy();}
});

test('resident admission evicts cold LRU buffers before rejecting protected resources', async () => {
  const fetch = vi.fn(async () => new ArrayBuffer(8));
  const tileset = new TerrainTileset({fetch, decode: async () => createTerrainStreamFixture(), minZoom: 2, maxResidentBytes: 132, onChange() {}});
  try {
    tileset.update([child]); await tileset.waitForIdle();
    tileset.update([sibling]); await tileset.waitForIdle();
    expect(tileset.records.has('2/2/2')).toBe(false);
    expect(tileset.getStatistics()).toMatchObject({bytes: 132, resident: 1, failed: 0});
    expect(tileset.getDrawableTiles().map(record => record.key)).toEqual(['2/3/2']);
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {tileset.destroy();}
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

test('source minimum zoom excludes unsupported parents while preserving cache/retry policy', async () => {
  const fetch = vi.fn(async () => new ArrayBuffer(1));
  const tileset = new TerrainTileset({minZoom: 2, maxZoom: 3, fetch, decode: async () => createTerrainStreamFixture(), onChange() {}});
  tileset.update([child, sibling]); await tileset.waitForIdle();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(tileset.getDrawableTiles().map(tile => tile.key)).toEqual(['2/2/2', '2/3/2']);
  expect(() => tileset.update([{zoom: 1, column: 0, row: 0}])).toThrow();
  expect(() => tileset.update([{zoom: 4, column: 0, row: 0}])).toThrow();
  tileset.destroy();
  const options = {fetch, decode: async () => createTerrainStreamFixture(), onChange() {}};
  for (const bounds of [{minZoom: -1}, {maxZoom: 13}, {minZoom: 3, maxZoom: 2}]) expect(() => new TerrainTileset({...options, ...bounds})).toThrow();
});
