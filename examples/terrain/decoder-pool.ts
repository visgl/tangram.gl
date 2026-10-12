// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {isTerrainGridData, isTerrainTileData, validateTerrainImage, type TerrainGridData, type TerrainTileData, type TerrainNoDataPolicy} from './terrain-payload';

/** Detached diagnostics; elapsed times include async image work, not just CPU execution. */
export interface TerrainDecoderStatistics {
    /** Total owned worker constructions, including replacements after cancellation. */
    created: number;
    /** Current running requests. */
    active: number;
    /** Current warm idle workers. */
    idle: number;
    /** Completed requests. */
    completed: number;
    /** Failed requests, excluding cancellation. */
    failed: number;
    /** Requests cancelled by their signal or pool teardown. */
    cancelled: number;
    /** Last completed request's host elapsed time, including startup, transfer and scheduling. */
    lastRoundTripMs?: number;
    /** Last completed request's worker decode elapsed time, if reported. */
    lastDecodeMs?: number;
}

/** One worker executes at most one request; TileBuildQueue remains the only job scheduler. */
interface DecoderSlot {
    worker?: Worker;
    finish?: (error: Error) => void;
}

/** Bounded lazy same-origin workers; successful jobs keep modules warm, aborted CPU jobs terminate their worker. */
export class TerrainDecoderPool {
    private readonly url: URL;
    private readonly slots: DecoderSlot[] = [];
    private readonly statistics: TerrainDecoderStatistics = {created: 0, active: 0, idle: 0, completed: 0, failed: 0, cancelled: 0};
    private sequence = 0;
    private disposed = false;

    /** Validate ownership and capacity without constructing workers. No hidden pending queue is created. */
    constructor(workerUrl: string, private readonly capacity = 2) {
        this.url = new URL(workerUrl, location.href);
        if (this.url.origin !== location.origin) throw new Error('Terrain worker must be same-origin');
        if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4) throw new Error('Terrain decoder capacity must be an integer in [1, 4]');
    }

    /** Physical-grid request skips adaptive mesh construction. Cached image bytes remain attached. */
    decodeGrid(bytes: ArrayBuffer, bounds: readonly [number, number, number, number], signal: AbortSignal, noData: TerrainNoDataPolicy = 'opaque'): Promise<TerrainGridData> {
        return this.decode('grid', isTerrainGridData, bytes, bounds, 0, signal, noData);
    }

    /** Adaptive geographic mesh request preserves the Mercator example's decoder contract. */
    decodeMesh(bytes: ArrayBuffer, bounds: readonly [number, number, number, number], meshMaxError: number, signal: AbortSignal, noData: TerrainNoDataPolicy = 'opaque'): Promise<TerrainTileData> {
        return this.decode('mesh', isTerrainTileData, bytes, bounds, meshMaxError, signal, noData);
    }

    /** Snapshot counters without exposing owned workers or mutable internal state. */
    getStatistics(): TerrainDecoderStatistics {
        return {...this.statistics, active: this.slots.filter(slot => slot.finish).length, idle: this.slots.filter(slot => slot.worker && !slot.finish).length};
    }

    /** Cancel active CPU work and release idle workers; safe to repeat. */
    destroy(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const slot of this.slots) {
            if (slot.finish) slot.finish(new DOMException('Terrain decode cancelled', 'AbortError'));
            else slot.worker?.terminate();
            slot.worker = undefined;
        }
        this.slots.length = 0;
    }

    /** Correlate each reply, reuse successful transports and reject capacity overflow instead of duplicating scheduling policy. */
    private decode<Data extends TerrainGridData>(mode: 'grid' | 'mesh', validate: (value: unknown) => value is Data,
        bytes: ArrayBuffer, bounds: readonly [number, number, number, number], meshMaxError: number, signal: AbortSignal, noData: TerrainNoDataPolicy): Promise<Data> {
        return new Promise((resolve, reject) => {
            if (signal.aborted || this.disposed) {reject(new DOMException('Terrain decode cancelled', 'AbortError')); return;}
            validateTerrainImage(bytes, bounds, noData);
            if (!Number.isFinite(meshMaxError) || meshMaxError < 0) {reject(new Error('Terrain mesh error must be non-negative meters')); return;}
            let slot = this.slots.find(candidate => !candidate.finish);
            if (!slot && this.slots.length < this.capacity) {slot = {}; this.slots.push(slot);}
            if (!slot) {reject(new Error('Terrain decoder capacity exceeded; schedule work through TileBuildQueue')); return;}
            const owned = slot, requestId = ++this.sequence, started = performance.now();
            let settled = false, timeout: ReturnType<typeof setTimeout> | undefined, worker: Worker | undefined;
            const abort = () => finish(new DOMException('Terrain decode cancelled', 'AbortError'));
            const messageError = () => finish(new Error('Terrain worker response could not be cloned'));
            const workerError = (event: ErrorEvent) => {event.preventDefault(); finish(new Error(event.message || 'Terrain worker failed to start'));};
            const message = (event: MessageEvent<unknown>) => {
                const response = event.data;
                if (!response || typeof response !== 'object' || !('requestId' in response) || !Number.isSafeInteger(response.requestId)) {finish(new Error('Malformed terrain worker response')); return;}
                if (response.requestId !== requestId) return; // Late or duplicated replies cannot complete another request.
                if ('type' in response && response.type === 'result' && 'data' in response && validate(response.data) && (mode !== 'grid' || !('mesh' in response.data)) &&
                    (!('decodeMs' in response) || typeof response.decodeMs === 'number' && Number.isFinite(response.decodeMs) && response.decodeMs >= 0)) {
                    this.statistics.lastDecodeMs = 'decodeMs' in response && typeof response.decodeMs === 'number' ? response.decodeMs : undefined;
                    finish(undefined, response.data);
                } else finish(new Error('message' in response && typeof response.message === 'string' ? response.message : 'Invalid terrain worker output'));
            };
            /** Settle exactly once, removing this request's listeners before the worker can be reused. */
            function finish(error?: Error, data?: Data): void {
                if (settled) return;
                settled = true; clearTimeout(timeout); signal.removeEventListener('abort', abort);
                worker?.removeEventListener('message', message); worker?.removeEventListener('error', workerError); worker?.removeEventListener('messageerror', messageError);
                owned.finish = undefined;
                if (error) {worker?.terminate(); owned.worker = undefined; recordFailure(error); reject(error);}
                else if (data) {recordSuccess(); resolve(data);}
            }
            const recordFailure = (error: Error) => {if (error.name === 'AbortError') this.statistics.cancelled++; else this.statistics.failed++;};
            const recordSuccess = () => {this.statistics.completed++; this.statistics.lastRoundTripMs = performance.now() - started;};
            owned.finish = finish;
            try {
                worker = owned.worker;
                if (!worker) {worker = new Worker(this.url, {type: 'module', name: 'terrain-decoder'}); owned.worker = worker; this.statistics.created++;}
                timeout = setTimeout(() => finish(new Error('Terrain worker timed out')), 30000);
                worker.addEventListener('message', message); worker.addEventListener('error', workerError); worker.addEventListener('messageerror', messageError);
                signal.addEventListener('abort', abort, {once: true});
                if (signal.aborted) {abort(); return;}
                const copy = bytes.slice(0);
                if (settled) return;
                worker.postMessage({requestId, mode, bytes: copy, bounds: [...bounds], meshMaxError, noData}, [copy]);
            } catch (error) {finish(error instanceof Error ? error : new Error(String(error)));}
        });
    }
}
