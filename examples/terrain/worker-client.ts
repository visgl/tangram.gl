// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {isTerrainMesh, type TerrainTileData, type TerrainNoDataPolicy} from './decode-terrain';

/** Validate structured-cloned data at the worker boundary. */
function isTerrainData(value: unknown): value is TerrainTileData {
    if (!value || typeof value !== 'object' || !('mesh' in value) || !isTerrainMesh(value.mesh) || !('grid' in value) || !value.grid || typeof value.grid !== 'object') return false;
    const grid = value.grid;
    if (!('valid' in grid) || !(grid.valid instanceof Uint8Array)) return false;
    const valid = grid.valid;
    return 'width' in grid && typeof grid.width === 'number' && Number.isSafeInteger(grid.width) && grid.width >= 2 &&
        'height' in grid && typeof grid.height === 'number' && Number.isSafeInteger(grid.height) && grid.height >= 2 &&
        'heights' in grid && grid.heights instanceof Float32Array && grid.heights.length === grid.width * grid.height &&
        'valid' in grid && grid.valid instanceof Uint8Array && grid.valid.length === grid.heights.length &&
        grid.heights.every((height, index) => !valid[index] || Number.isFinite(height)) &&
        'bounds' in grid && Array.isArray(grid.bounds) && grid.bounds.length === 4 && grid.bounds.every(Number.isFinite) && grid.bounds[0] < grid.bounds[2] && grid.bounds[1] < grid.bounds[3] &&
        'registration' in grid && grid.registration === 'pixel-center' && 'verticalDatum' in grid && grid.verticalDatum === 'unknown';
}

/** Decode in an owned, same-origin module worker; abort terminates actual CPU work. */
export function decodeTerrainInWorker(workerUrl: string, bytes: ArrayBuffer, bounds: readonly [number, number, number, number], meshMaxError: number, signal: AbortSignal, noData: TerrainNoDataPolicy = 'opaque'): Promise<TerrainTileData> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {reject(new DOMException('Terrain decode cancelled', 'AbortError')); return;}
        const url = new URL(workerUrl, location.href);
        if (url.origin !== location.origin) {reject(new Error('Terrain worker must be same-origin')); return;}
        const worker = new Worker(url, {type: 'module', name: 'terrain-decoder'});
        let settled = false;
        const timeout = setTimeout(() => finish(new Error('Terrain worker timed out')), 30000);
        const abort = () => finish(new DOMException('Terrain decode cancelled', 'AbortError'));
        function finish(error?: Error, data?: TerrainTileData): void {
            if (settled) return;
            settled = true; clearTimeout(timeout); signal.removeEventListener('abort', abort); worker.terminate();
            if (error) reject(error);
            else if (data) resolve(data);
        }
        worker.addEventListener('message', (event: MessageEvent<unknown>) => {
            const response = event.data;
            if (!response || typeof response !== 'object' || !('type' in response)) {finish(new Error('Malformed terrain worker response')); return;}
            if (response.type === 'result' && 'data' in response && isTerrainData(response.data)) finish(undefined, response.data);
            else finish(new Error('message' in response && typeof response.message === 'string' ? response.message : 'Invalid terrain worker output'));
        });
        worker.addEventListener('error', event => {event.preventDefault(); finish(new Error(event.message || 'Terrain worker failed to start'));});
        worker.addEventListener('messageerror', () => finish(new Error('Terrain worker response could not be cloned')));
        signal.addEventListener('abort', abort, {once: true});
        try {
            const copy = bytes.slice(0);
            worker.postMessage({bytes: copy, bounds: [...bounds], meshMaxError, noData}, [copy]);
        } catch (error) {finish(error instanceof Error ? error : new Error(String(error)));}
    });
}
