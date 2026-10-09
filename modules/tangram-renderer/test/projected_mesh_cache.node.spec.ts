// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import {ProjectedMeshPreparationCache} from '../src/experimental/projected-mesh-cache';

test('byte-identical transferable copies reuse topology and detached source snapshots', () => {
    const cache = new ProjectedMeshPreparationCache();
    const vertices = new Uint8Array([1, 2, 3, 4]);
    const indices = new Uint16Array([0, 1, 2]);
    const prepare = vi.fn(() => ({vertices, indices}));
    const first = cache.getOrCreate('layout/refinement', vertices, indices, prepare);
    expect(cache.getOrCreate('layout/refinement', vertices.slice(), indices.slice(), prepare)).toBe(first);
    vertices[0] = 9;
    indices[0] = 2;
    expect(first.vertices[0]).toBe(1);
    expect(first.indices[0]).toBe(0);
    cache.getOrCreate('layout/refinement', vertices, indices, prepare);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(cache.getStatistics()).toEqual({entries: 2, bytes: 40, hits: 1, misses: 2});
});

test('LRU eviction accounts original and prepared bytes and updates recency', () => {
    const cache = new ProjectedMeshPreparationCache(24, 2);
    const prepare = vi.fn(() => ({vertices: new Uint8Array(2), indices: new Uint16Array(3)}));
    const get = (key: string) => cache.getOrCreate(key, new Uint8Array(2), false, prepare);
    get('first'); get('second'); get('first'); get('third'); get('first'); get('second');
    expect(prepare).toHaveBeenCalledTimes(4);
    expect(cache.getStatistics()).toEqual({entries: 2, bytes: 20, hits: 2, misses: 4});
});

test.each([[0, 2], [100, 0], [1, 10]])('oversized/disabled cache %s/%s does not retain preparation', (bytes, entries) => {
    const cache = new ProjectedMeshPreparationCache(bytes, entries);
    const prepare = vi.fn(() => ({vertices: new Uint8Array(2), indices: new Uint16Array(3)}));
    for (let attempt = 0; attempt < 2; attempt++) cache.getOrCreate('same', new Uint8Array(2), false, prepare);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(cache.getStatistics().bytes).toBe(0);
});

test('metadata, index format and content changes do not alias cache entries', () => {
    const cache = new ProjectedMeshPreparationCache();
    const prepare = vi.fn(() => ({vertices: new Uint8Array(2), indices: new Uint16Array(3)}));
    cache.getOrCreate('layout', new Uint8Array([0, 1]), false, prepare);
    cache.getOrCreate('other', new Uint8Array([0, 1]), false, prepare);
    cache.getOrCreate('layout', new Uint8Array([0, 1]), new Uint16Array([0, 1, 2]), prepare);
    cache.getOrCreate('layout', new Uint8Array([0, 1]), new Uint32Array([0, 1, 2]), prepare);
    cache.getOrCreate('layout', new Uint8Array([0, 2]), false, prepare);
    expect(prepare).toHaveBeenCalledTimes(5);
    cache.clear();
    expect(cache.getStatistics()).toEqual({entries: 0, bytes: 0, hits: 0, misses: 0});
});

test('failed preparation is never cached and can be retried', () => {
    const cache = new ProjectedMeshPreparationCache();
    const prepare = vi.fn(() => ({vertices: new Uint8Array(2), indices: new Uint16Array(3)}));
    prepare.mockImplementationOnce(() => {throw new Error('budget');});
    expect(() => cache.getOrCreate('same', new Uint8Array(2), false, prepare)).toThrow('budget');
    cache.getOrCreate('same', new Uint8Array(2), false, prepare);
    expect(prepare).toHaveBeenCalledTimes(2);
});

test('distinct byte arrays with the same lookup hash cannot reuse another mesh', () => {
    const cache = new ProjectedMeshPreparationCache();
    // Both FNV-1a byte hashes are 833407541; equality, not the hash, decides residency.
    const first = new Uint8Array([49, 109, 108, 19, 99, 92]);
    const second = new Uint8Array([33, 197, 61, 183, 134, 220]);
    const prepare = vi.fn(() => ({vertices: new Uint8Array(2), indices: new Uint16Array(3)}));
    cache.getOrCreate('same', first, false, prepare);
    cache.getOrCreate('same', second, false, prepare);
    cache.getOrCreate('same', first.slice(), false, prepare);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(cache.getStatistics()).toMatchObject({entries: 2, hits: 1, misses: 2});
});

test.each([[-1, 1], [1, -1], [NaN, 1], [1, Infinity], [1.5, 1]])('rejects invalid cache limits %s/%s', (bytes, entries) => {
    expect(() => new ProjectedMeshPreparationCache(bytes, entries)).toThrow(RangeError);
});

test('asynchronous results retain detached inputs and failed replies remain retryable', async () => {
    const cache = new ProjectedMeshPreparationCache();
    const vertices = new Uint8Array([1, 2]);
    const indices = new Uint16Array([0, 1, 0]);
    const prepare = vi.fn(async () => ({vertices: new Uint8Array([8, 9]), indices}));
    prepare.mockRejectedValueOnce(new Error('engine unavailable'));
    await expect(cache.getOrCreateAsync('target', vertices, indices, prepare)).rejects.toThrow('engine unavailable');
    const result = await cache.getOrCreateAsync('target', vertices, indices, prepare);
    expect(await cache.getOrCreateAsync('target', vertices.slice(), indices.slice(), prepare)).toBe(result);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(cache.getStatistics()).toMatchObject({entries: 1, hits: 1, misses: 2});
});

test('concurrent asynchronous misses retain one completed result, without pretending to coalesce work', async () => {
    const cache = new ProjectedMeshPreparationCache();
    const prepare = vi.fn(async () => ({vertices: new Uint8Array(2), indices: new Uint16Array(3)}));
    await Promise.all([cache.getOrCreateAsync('same', new Uint8Array(2), false, prepare),
        cache.getOrCreateAsync('same', new Uint8Array(2), false, prepare)]);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(cache.getStatistics()).toEqual({entries: 1, bytes: 10, hits: 0, misses: 2});
});

test('reset during an asynchronous preparation prevents stale residency', async () => {
    const cache = new ProjectedMeshPreparationCache();
    let complete = () => {};
    const pending = new Promise<void>(resolve => {complete = resolve;});
    const prepare = vi.fn(async () => {await pending; return {vertices: new Uint8Array(2), indices: new Uint16Array(3)};});
    const result = cache.getOrCreateAsync('target', new Uint8Array(2), false, prepare);
    cache.clear();
    complete();
    await result;
    expect(cache.getStatistics()).toEqual({entries: 0, bytes: 0, hits: 0, misses: 0});
    await cache.getOrCreateAsync('target', new Uint8Array(2), false, prepare);
    expect(prepare).toHaveBeenCalledTimes(2);
});

test('asynchronous preparation snapshots source before callers mutate its input', async () => {
    const cache = new ProjectedMeshPreparationCache();
    const vertices = new Uint8Array([1, 2]);
    const original = vertices.slice();
    const prepare = vi.fn(async () => ({vertices: new Uint8Array([7, 8]), indices: new Uint16Array(3)}));
    const pending = cache.getOrCreateAsync('target', vertices, false, prepare);
    vertices.fill(9);
    await pending;
    await cache.getOrCreateAsync('target', original, false, prepare);
    expect(prepare).toHaveBeenCalledOnce();
    await cache.getOrCreateAsync('target', vertices, false, prepare);
    expect(prepare).toHaveBeenCalledTimes(2);
});
