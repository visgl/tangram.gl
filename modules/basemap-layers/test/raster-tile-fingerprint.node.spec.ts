// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {createHash} from 'node:crypto';
import {describe, expect, test} from 'vitest';
import {createRasterTileFingerprintFilter, getRasterTileFingerprint} from '../src/index';

const PLACEHOLDER = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]).buffer;
const OTHER = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 5]).buffer;

const tile = (arrayBuffer: ArrayBuffer) => ({
  url: 'https://tiles.test/1/0/0.png',
  sourceId: 'imagery',
  index: {x: 0, y: 0, z: 1},
  arrayBuffer
});

describe('raster tile fingerprints', () => {
  test('the fingerprint is the SHA-256 digest of the bytes', async () => {
    expect(await getRasterTileFingerprint(PLACEHOLDER)).toBe(
      createHash('sha256').update(new Uint8Array(PLACEHOLDER)).digest('hex')
    );
    expect(await getRasterTileFingerprint(new ArrayBuffer(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
  });

  test('the filter matches only the tiles with a known fingerprint', async () => {
    const rejectTile = createRasterTileFingerprintFilter([
      await getRasterTileFingerprint(PLACEHOLDER)
    ]);
    expect(await rejectTile(tile(PLACEHOLDER))).toBe(true);
    expect(await rejectTile(tile(PLACEHOLDER.slice(0)))).toBe(true);
    expect(await rejectTile(tile(OTHER))).toBe(false);
  });

  test('the filter waits for fingerprints given as a promise', async () => {
    const rejectTile = createRasterTileFingerprintFilter(
      getRasterTileFingerprint(PLACEHOLDER).then(fingerprint => new Set([fingerprint]))
    );
    expect(await rejectTile(tile(PLACEHOLDER))).toBe(true);
    expect(await rejectTile(tile(OTHER))).toBe(false);
  });

  test('the filter matches no tile without fingerprints', async () => {
    expect(await createRasterTileFingerprintFilter([])(tile(PLACEHOLDER))).toBe(false);
    const failed = createRasterTileFingerprintFilter(Promise.reject(new Error('offline')));
    expect(await failed(tile(PLACEHOLDER))).toBe(false);
  });
});
