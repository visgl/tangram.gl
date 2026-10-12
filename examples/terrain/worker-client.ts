// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {TerrainDecoderPool} from './decoder-pool';
import type {TerrainTileData, TerrainNoDataPolicy} from './terrain-payload';

/** Decode in an owned, same-origin module worker; abort terminates actual CPU work. */
export function decodeTerrainInWorker(workerUrl: string, bytes: ArrayBuffer, bounds: readonly [number, number, number, number], meshMaxError: number, signal: AbortSignal, noData: TerrainNoDataPolicy = 'opaque'): Promise<TerrainTileData> {
    // Preserve the single-call lifecycle for compatibility; interactive mounts own a longer-lived pool.
    if (signal.aborted) return Promise.reject(new DOMException('Terrain decode cancelled', 'AbortError'));
    try {
        const pool = new TerrainDecoderPool(workerUrl, 1);
        return pool.decodeMesh(bytes, bounds, meshMaxError, signal, noData).finally(() => pool.destroy());
    } catch (error) {return Promise.reject(error);}
}
