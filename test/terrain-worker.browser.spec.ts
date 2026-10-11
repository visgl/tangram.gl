// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {beforeAll, expect, test} from 'vitest';
import {decodeTerrainInWorker} from '../examples/terrain/worker-client';
import {parseTerrainTile} from '../examples/terrain/load-terrain';
import {createTerrainFixture} from './terrain-fixture';

let bytes: ArrayBuffer;
const bounds: [number, number, number, number] = [0, 0, 0.01, 0.01];
const workerUrl = `${location.origin}/examples/terrain/dist/terrain-worker.js`;
beforeAll(async () => {bytes = (await createTerrainFixture()).bytes;});

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
