// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {WorkerThread} from '@math.gl/core-legacy-tasks/tasks';
import type {TangramTileSourceMetadata} from '../sources/tile_source_metadata';
import type {BrokerWorker} from '../utils/worker-types';
import type {SelectionReply} from '../selection/selection-types';
import type {SceneFeature} from '../types';

const sceneWorkerThreads = new WeakMap<BrokerWorker, SceneWorkerThread>();

/** Return the task transport associated with an owned, task-capable scene worker. */
export function getSceneWorkerThread(worker: BrokerWorker): SceneWorkerThread | undefined {
    const thread = sceneWorkerThreads.get(worker);
    return thread?.supportsTasks ? thread : undefined;
}

/** Operations that can execute on the scene worker through the task protocol. */
export type SceneWorkerTask =
    | {id: number; operation: 'tile-source-statistics'}
    | {id: number; operation: 'source-metadata'; names: readonly string[]; generation: number}
    | {id: number; operation: 'update-config' | 'update-terrain-view'; configuration: unknown; debug: unknown}
    | {id: number; operation: 'build-tile'; tile: unknown}
    | {id: number; operation: 'remove-tile'; key: string}
    | {id: number; operation: 'feature-selection'; request: {id: number; key?: number}}
    | {id: number; operation: 'reset-feature-selection'; sources: string[] | null}
    | {id: number; operation: 'feature-selection-map-size'}
    | {id: number; operation: 'query-features'; query: unknown}
    | {id: number; operation: 'initialize'; parameters: unknown[]}
    | {id: number; operation: 'update-device-pixel-ratio'; pixelRatio: number | undefined}
    | {id: number; operation: 'clear-function-cache'}
    | {id: number; operation: 'profile' | 'profile-end'; name: string};

type SceneWorkerTaskInput = SceneWorkerTask extends infer Task ? Task extends SceneWorkerTask ? Omit<Task, 'id'> : never : never;

/** Owns a scene worker through math.gl while its bidirectional broker remains in use. */
export class SceneWorkerThread {
    private readonly thread: WorkerThread;
    private readonly pending = new Map<number, {resolve: (value: unknown) => void; reject: (error: Error) => void}>();
    private nextTaskId = 0;
    private terminalError: Error | undefined;

    /** The browser worker used by Tangram's concurrent broker protocol. */
    readonly worker: Worker;

    /** Start a classic worker at the existing scene worker URL. */
    constructor(url: string, id: number, readonly supportsTasks = false) {
        this.thread = new WorkerThread({name: `Tangram scene ${id}`, url, workerType: 'classic'});
        this.worker = this.thread.worker as Worker;
        sceneWorkerThreads.set(this.worker, this);
        this.thread.onMessage = message => {
            if (message?.source !== 'loaders.gl') return;
            if (message.type === 'error') {
                this.rejectPending(new Error(message.payload?.error || 'Scene worker task failed'));
                return;
            }
            if (message.type !== 'done') return;
            const result = message.payload?.result;
            const pending = this.pending.get(result?.id);
            if (!pending) return;
            this.pending.delete(result.id);
            if (typeof result.error === 'string') pending.reject(new Error(result.error));
            else pending.resolve(result.value);
        };
        this.thread.onError = error => {
            this.terminalError = error;
            this.rejectPending(error);
        };
    }

    /** Request a source statistics snapshot using the math.gl task protocol. */
    getTileSourceStatistics(): Promise<unknown> {
        return this.runTask({operation: 'tile-source-statistics'});
    }

    /** Resolve provider metadata against a specific worker configuration generation. */
    getSourceMetadata(names: readonly string[], generation: number): Promise<Record<string, TangramTileSourceMetadata>> {
        return this.runTask({operation: 'source-metadata', names, generation}) as Promise<Record<string, TangramTileSourceMetadata>>;
    }

    /** Update worker scene configuration or terrain view without transferring caller-owned data. */
    updateConfiguration(terrainView: boolean, configuration: unknown, debug: unknown): Promise<unknown> {
        return this.runTask({operation: terrainView ? 'update-terrain-view' : 'update-config', configuration, debug});
    }

    /** Build a tile while preserving asynchronous worker-to-main mesh callbacks. */
    buildTile(tile: unknown): Promise<unknown> {
        return this.runTask({operation: 'build-tile', tile});
    }

    /** Release a tile and cancel its outstanding source work. */
    removeTile(key: string): Promise<unknown> {
        return this.runTask({operation: 'remove-tile', key});
    }

    /** Look up a selection without transferring worker-owned feature data. */
    getFeatureSelection(request: {id: number; key?: number}): Promise<SelectionReply> {
        return this.runTask({operation: 'feature-selection', request}) as Promise<SelectionReply>;
    }

    /** Clear selection entries for the specified sources. */
    resetFeatureSelection(sources: string[] | null): Promise<unknown> {
        return this.runTask({operation: 'reset-feature-selection', sources});
    }

    /** Count feature selection entries on this worker. */
    getFeatureSelectionMapSize(): Promise<number> {
        return this.runTask({operation: 'feature-selection-map-size'}) as Promise<number>;
    }

    /** Query worker-local tile features without transferring retained source data. */
    queryFeatures(query: unknown): Promise<SceneFeature[]> {
        return this.runTask({operation: 'query-features', query}) as Promise<SceneFeature[]>;
    }

    /** Initialize worker identity, capabilities and optional source scripts. */
    initialize(...parameters: unknown[]): Promise<number> {
        return this.runTask({operation: 'initialize', parameters}) as Promise<number>;
    }

    /** Update the worker's device-pixel ratio. */
    updateDevicePixelRatio(pixelRatio: number | undefined): Promise<unknown> {
        return this.runTask({operation: 'update-device-pixel-ratio', pixelRatio});
    }

    /** Clear cached compiled function strings before loading a new scene. */
    clearFunctionCache(): Promise<unknown> {
        return this.runTask({operation: 'clear-function-cache'});
    }

    /** Start or end a worker-side diagnostic profile. */
    profile(name: string, end = false): Promise<unknown> {
        return this.runTask({operation: end ? 'profile-end' : 'profile', name});
    }

    private runTask(task: SceneWorkerTaskInput): Promise<unknown> {
        if (this.terminalError) return Promise.reject(this.terminalError);
        const id = this.nextTaskId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, {resolve, reject});
            try {
                this.thread.postMessage({source: 'loaders.gl', type: 'process', payload: {input: {...task, id}, options: {}}}, []);
            } catch (error) {
                this.pending.delete(id);
                reject(error);
            }
        });
    }

    private rejectPending(error: Error): void {
        for (const request of this.pending.values()) request.reject(error);
        this.pending.clear();
    }

    /** Terminate the owned worker and release math.gl's thread resources. */
    destroy(): void {
        sceneWorkerThreads.delete(this.worker);
        if (this.terminalError && this.thread.terminated) return;
        this.terminalError ||= new Error('Scene worker was destroyed');
        this.rejectPending(this.terminalError);
        void this.thread.destroy().catch(() => {});
    }
}
