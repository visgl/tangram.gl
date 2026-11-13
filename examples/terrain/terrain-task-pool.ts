// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {TaskRunner, type InitializedTask} from '@math.gl/tasks';
import {getTerrainWorkerTask, type TerrainTaskInput} from './terrain-task';
import {isTerrainGridData, isTerrainTileData, validateTerrainImage, type TerrainGridData, type TerrainTileData, type TerrainNoDataPolicy} from './terrain-payload';
import type {TerrainDecoderStatistics} from './decoder-pool';

type TerrainSlot = {
    runner?: TaskRunner;
    task?: Promise<InitializedTask<ReturnType<typeof getTerrainWorkerTask>>>;
    busy: boolean;
};

/** Bounded terrain task transport with explicit ownership and cancellation. */
export class TerrainTaskPool {
    private readonly slots: TerrainSlot[] = [];
    private readonly workerUrl: string;
    private readonly controllers = new Set<AbortController>();
    private readonly statistics: TerrainDecoderStatistics = {created: 0, active: 0, idle: 0, completed: 0, failed: 0, cancelled: 0};
    private disposed = false;

    /** Create a same-origin pool; tile scheduling remains the caller's responsibility. */
    constructor(workerUrl: string, private readonly capacity = 2) {
        const url = new URL(workerUrl, location.href);
        if (url.origin !== location.origin) throw new Error('Terrain worker must be same-origin');
        if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4) throw new Error('Terrain decoder capacity must be an integer in [1, 4]');
        this.workerUrl = url.href;
    }

    /** Decode physical elevation samples without producing a mesh. */
    decodeGrid(bytes: ArrayBuffer, bounds: readonly [number, number, number, number], signal: AbortSignal, noData: TerrainNoDataPolicy = 'opaque'): Promise<TerrainGridData> {
        return this.decode('grid', isTerrainGridData, bytes, bounds, 0, signal, noData);
    }

    /** Decode physical samples and adaptive mesh topology. */
    decodeMesh(bytes: ArrayBuffer, bounds: readonly [number, number, number, number], meshMaxError: number, signal: AbortSignal, noData: TerrainNoDataPolicy = 'opaque'): Promise<TerrainTileData> {
        return this.decode('mesh', isTerrainTileData, bytes, bounds, meshMaxError, signal, noData);
    }

    /** Return a detached diagnostics snapshot. */
    getStatistics(): TerrainDecoderStatistics {
        const idle = this.slots.filter(slot => !slot.busy && slot.task).length;
        return {...this.statistics, active: this.controllers.size, idle: this.disposed ? 0 : idle};
    }

    /** Cancel outstanding work and terminate owned workers. */
    destroy(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const controller of this.controllers) controller.abort(new DOMException('Terrain decode cancelled', 'AbortError'));
        for (const slot of this.slots) this.retire(slot);
    }

    /** Drop one slot without interrupting unrelated terrain requests. */
    private retire(slot: TerrainSlot): void {
        void slot.runner?.terminate().catch(() => {});
        slot.runner = undefined;
        slot.task = undefined;
    }

    /** Run one job, retaining caller-owned image bytes and validating the returned payload. */
    private async decode<Data extends TerrainGridData>(mode: 'grid' | 'mesh', validate: (value: unknown) => value is Data,
        bytes: ArrayBuffer, bounds: readonly [number, number, number, number], meshMaxError: number, signal: AbortSignal, noData: TerrainNoDataPolicy): Promise<Data> {
        if (this.disposed || signal.aborted) throw new DOMException('Terrain decode cancelled', 'AbortError');
        validateTerrainImage(bytes, bounds, noData);
        if (!Number.isFinite(meshMaxError) || meshMaxError < 0) throw new Error('Terrain mesh error must be non-negative meters');
        if (this.controllers.size >= this.capacity) throw new Error('Terrain decoder capacity exceeded; schedule work through TileBuildQueue');
        let slot = this.slots.find(candidate => !candidate.busy);
        if (!slot) {slot = {busy: false}; this.slots.push(slot);}
        slot.busy = true;
        const controller = new AbortController();
        const abort = () => controller.abort(new DOMException('Terrain decode cancelled', 'AbortError'));
        const timeout = setTimeout(() => controller.abort(new Error('Terrain worker timed out')), 30000);
        const started = performance.now();
        this.controllers.add(controller);
        signal.addEventListener('abort', abort, {once: true});
        if (signal.aborted) abort();
        try {
            if (!slot.task) {
                slot.runner = new TaskRunner();
                const task = getTerrainWorkerTask(() => {
                    const worker = new Worker(this.workerUrl, {type: 'module', name: 'Tangram terrain decode'});
                    this.statistics.created++;
                    return worker;
                });
                slot.task = slot.runner.initializeTask(task, {}, {execution: 'worker', signal: controller.signal});
            }
            const handle = await slot.task;
            const input: TerrainTaskInput = {mode, bytes, bounds: [...bounds], meshMaxError, noData};
            const {data: result, decodeMs} = await handle.runTask(input, {
                signal: controller.signal, inputOwnership: 'copy', outputOwnership: 'transfer'
            });
            if (!validate(result) || (mode === 'grid' && 'mesh' in result)) throw new Error('Invalid terrain worker output');
            this.statistics.completed++;
            this.statistics.lastDecodeMs = decodeMs;
            this.statistics.lastRoundTripMs = performance.now() - started;
            return result;
        } catch (error) {
            this.retire(slot);
            if (error instanceof Error && error.name === 'AbortError') this.statistics.cancelled++;
            else this.statistics.failed++;
            throw error;
        } finally {
            clearTimeout(timeout);
            signal.removeEventListener('abort', abort);
            this.controllers.delete(controller);
            slot.busy = false;
        }
    }
}
