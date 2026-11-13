// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {TaskRunner, type InitializedTask, type Task} from '@math.gl/tasks';
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
    | {operation: 'tile-source-statistics'}
    | {operation: 'source-metadata'; names: readonly string[]; generation: number}
    | {operation: 'update-config' | 'update-terrain-view'; configuration: unknown; debug: unknown}
    | {operation: 'build-tile'; tile: unknown}
    | {operation: 'remove-tile'; key: string}
    | {operation: 'feature-selection'; request: {id: number; key?: number}}
    | {operation: 'reset-feature-selection'; sources: string[] | null}
    | {operation: 'feature-selection-map-size'}
    | {operation: 'query-features'; query: unknown}
    | {operation: 'initialize'; parameters: unknown[]}
    | {operation: 'update-device-pixel-ratio'; pixelRatio: number | undefined}
    | {operation: 'clear-function-cache'}
    | {operation: 'profile' | 'profile-end'; name: string};

/** A record envelope for results that may themselves be arrays or primitives. */
export type SceneWorkerTaskResult = {value: unknown};

const SCENE_TASK_CONCURRENCY = 32;

/** Shared task protocol, independent of the scene implementation and the broker. */
export const sceneWorkerTask = {
    id: 'tangram-scene',
    concurrency: {
        maxConcurrency: SCENE_TASK_CONCURRENCY,
        getSchedulingMode: (_input: SceneWorkerTask) => 'parallel' as const
    }
};

type SceneTask = Task<{input: SceneWorkerTask; output: SceneWorkerTaskResult}>;

/** Owns a scene worker through math.gl while its bidirectional broker remains in use. */
export class SceneWorkerThread {
    private readonly runner?: TaskRunner;
    private readonly task?: Promise<InitializedTask<SceneTask>>;
    private readonly shimURL?: string;
    private readonly lifetime = new AbortController();
    private terminalError: Error | undefined;

    /** The browser worker used by Tangram's concurrent broker protocol. */
    readonly worker: Worker;

    /** Start a classic worker at the existing scene worker URL. */
    constructor(url: string, id: number, readonly supportsTasks = true) {
        const scriptURL = new URL(url, location.href);
        // Classic workers still support importScripts for projection and source sidecars.
        if (/^https?:$/.test(scriptURL.protocol) && scriptURL.origin !== location.origin) {
            this.shimURL = URL.createObjectURL(new Blob(
                [`importScripts(${JSON.stringify(scriptURL.href)});`],
                {type: 'text/javascript'}
            ));
        }
        try {
            this.worker = new Worker(this.shimURL ?? url, {name: `Tangram scene ${id}`, type: 'classic'});
        } catch (error) {
            if (this.shimURL) URL.revokeObjectURL(this.shimURL);
            throw error;
        }
        sceneWorkerThreads.set(this.worker, this);
        this.worker.addEventListener('error', event => {
            this.terminalError ??= new Error(`Failed to load or execute scene worker: ${event.message}`);
            this.lifetime.abort(this.terminalError);
        });
        if (supportsTasks) {
            this.runner = new TaskRunner();
            const definition: SceneTask = {
                ...sceneWorkerTask,
                worker: {create: () => this.worker, capabilities: {atomic: true, streaming: false}}
            };
            this.task = this.runner.initializeTask(definition, {}, {
                execution: 'worker', operationConcurrency: SCENE_TASK_CONCURRENCY, signal: this.lifetime.signal
            });
            void this.task.catch(error => {
                this.terminalError ??= error instanceof Error ? error : new Error(String(error));
            });
        }
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

    private async runTask(task: SceneWorkerTask): Promise<unknown> {
        if (this.terminalError) throw this.terminalError;
        if (!this.task) throw new Error('Scene worker does not support tasks');
        try {
            const handle = await this.task;
            return (await handle.runTask(task, {signal: this.lifetime.signal, inputOwnership: 'copy', outputOwnership: 'copy'})).value;
        } catch (error) {
            throw this.terminalError ?? error;
        }
    }

    /** Terminate the owned worker and release math.gl's thread resources. */
    destroy(): void {
        sceneWorkerThreads.delete(this.worker);
        this.terminalError ??= new Error('Scene worker was destroyed');
        this.lifetime.abort(this.terminalError);
        if (this.runner) void this.runner.terminate(this.terminalError).catch(() => {});
        else this.worker.terminate();
        if (this.shimURL) URL.revokeObjectURL(this.shimURL);
    }
}
