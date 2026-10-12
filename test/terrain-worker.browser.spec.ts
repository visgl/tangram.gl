// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {beforeAll, expect, test} from 'vitest';
import {decodeTerrainInWorker} from '../examples/terrain/worker-client';
import {TerrainDecoderPool} from '../examples/terrain/decoder-pool';
import {decodeTerrainGrid} from '../examples/terrain/decode-height-grid';
import {parseTerrainTile} from '../examples/terrain/load-terrain';
import {createTerrainFixture} from './terrain-fixture';

let bytes: ArrayBuffer;
const bounds: [number, number, number, number] = [0, 0, 0.01, 0.01];
const workerUrl = `${location.origin}/examples/terrain/dist/terrain-worker.js`;
beforeAll(async () => {bytes = (await createTerrainFixture()).bytes;});

test('one warm worker handles independent grid-only jobs then Mercator topology, preserving grid conformance and bytes', async () => {
  const pool = new TerrainDecoderPool(workerUrl, 1), original = bytes.slice(0);
  try {
    const first = await pool.decodeGrid(bytes, bounds, new AbortController().signal);
    const second = await pool.decodeGrid(bytes, bounds, new AbortController().signal);
    const local = await decodeTerrainGrid(bytes, bounds);
    const mesh = await pool.decodeMesh(bytes, bounds, 0, new AbortController().signal);
    expect(first).toEqual(local); expect(second).toEqual(local); expect(mesh.grid).toEqual(local.grid);
    expect('mesh' in first).toBe(false); expect(mesh.mesh.indices?.value.length).toBeGreaterThan(0);
    expect(bytes).toEqual(original); expect(first.grid.heights.buffer).not.toBe(second.grid.heights.buffer);
    expect(pool.getStatistics()).toMatchObject({created: 1, completed: 3, idle: 1, active: 0});
    expect(pool.getStatistics().lastDecodeMs).toBeGreaterThanOrEqual(0);
    expect(pool.getStatistics().lastRoundTripMs).toBeGreaterThanOrEqual(0);
  } finally {pool.destroy();}
  expect(pool.getStatistics()).toMatchObject({active: 0, idle: 0});
});

test('packaged same-origin worker matches local decoding without detaching warm source bytes', async () => {
  const original = bytes.slice(0);
  const worker = await decodeTerrainInWorker(workerUrl, bytes, bounds, 0, new AbortController().signal);
  const local = await parseTerrainTile(bytes, bounds, 0);
  expect(worker.grid).toEqual(local.grid);
  expect(worker.mesh.attributes.POSITION.value).toEqual(local.mesh.attributes.POSITION.value);
  expect(worker.mesh.indices?.value).toEqual(local.mesh.indices?.value);
  expect(bytes).toEqual(original);
});

test('real worker cancellation, malformed imagery and foreign worker URLs reject cleanly', async () => {
  const abort = new AbortController();
  const pending = decodeTerrainInWorker(workerUrl, bytes, bounds, 0, abort.signal);
  abort.abort();
  await expect(pending).rejects.toMatchObject({name: 'AbortError'});
  await expect(decodeTerrainInWorker(workerUrl, bytes, bounds, 0, abort.signal)).rejects.toMatchObject({name: 'AbortError'});
  await expect(decodeTerrainInWorker('https://invalid.example/terrain.js', bytes, bounds, 0, new AbortController().signal)).rejects.toThrow('same-origin');
  await expect(decodeTerrainInWorker(workerUrl, new ArrayBuffer(4), bounds, 0, new AbortController().signal)).rejects.toThrow();
  expect(bytes.byteLength).toBeGreaterThan(4);
});
