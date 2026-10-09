// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {ProjectionEngineTransform} from '../types';

/** Cooperative host-side execution policy; does not limit tile loading or mesh-build capacity. */
export interface ProjectionExecutionOptions {
    /** Maximum coordinate pairs per synchronous kernel call, 1–65,536; defaults to 4,096. */
    maxBatchPositions?: number;
}

/** Per-operation cancellation and output coordinate contract. */
export interface ProjectionBatchRequestOptions {
    /** Cancel this operation without cancelling shared compilation or other requests. */
    signal?: AbortSignal;
    /** Multiply kernel output by this finite scale; defaults to one. */
    scale?: number;
    /** Optional positive finite output magnitude bound, checked after scaling. */
    maxAbsoluteValue?: number;
    /** Preserve nonfinite inverse-domain sentinels for caller validation; defaults to false. */
    allowNonfinite?: boolean;
}

/** Detached cumulative host work; counts kernel submissions, not worker/GPU memory or wall-clock time. */
export interface ProjectionExecutionStatistics {
    /** Requests still awaiting compilation or cooperative execution. */
    activeRequests: number;
    /** Requests that returned a fully validated output. */
    completedRequests: number;
    /** Requests rejected by compilation, kernels or invalid output. */
    failedRequests: number;
    /** Requests cancelled by a signal or executor teardown. */
    cancelledRequests: number;
    /** Coordinate pairs submitted to kernels, including requests that subsequently fail/cancel. */
    submittedPositions: number;
    /** Synchronous kernel calls attempted, including failed calls. */
    batches: number;
    /** Event-loop yields scheduled between chunks. */
    yieldCount: number;
    /** Configured per-call coordinate pair limit. */
    maxBatchPositions: number;
}

/** Validate policy before allocating a renderer, worker endpoint or navigation helper. */
export function normalizeProjectionExecutionOptions(options: ProjectionExecutionOptions = {}): Required<ProjectionExecutionOptions> {
    const maxBatchPositions = options.maxBatchPositions === undefined ? 4096 : options.maxBatchPositions;
    if (!Number.isSafeInteger(maxBatchPositions) || maxBatchPositions < 1 || maxBatchPositions > 65536) {
        throw new Error('Projection execution requires maxBatchPositions in [1, 65536]');
    }
    return {maxBatchPositions};
}

/** Run independent packed batches with detached input, cooperative yields and prompt cancellation. */
export class ProjectionBatchExecutor {
    /** Cancels pending operations without taking ownership of transforms or factories. */
    private readonly lifetime = new AbortController();
    /** Detached snapshots are returned instead of exposing these mutable counters. */
    private readonly statistics: ProjectionExecutionStatistics;

    /** Capture an immutable per-kernel-call execution policy. */
    constructor(options: ProjectionExecutionOptions = {}) {
        this.statistics = {...normalizeProjectionExecutionOptions(options), activeRequests: 0,
            completedRequests: 0, failedRequests: 0, cancelledRequests: 0, submittedPositions: 0,
            batches: 0, yieldCount: 0};
    }

    /** Capture input before compilation; abort only this output, never a shared factory promise. */
    async execute(coordinates: Float64Array, getTransform: () => Promise<ProjectionEngineTransform>,
        options: ProjectionBatchRequestOptions = {}): Promise<Float64Array> {
        const scale = options.scale ?? 1;
        const maximum = options.maxAbsoluteValue ?? Infinity;
        const allowNonfinite = options.allowNonfinite ?? false;
        if (!(coordinates instanceof Float64Array) || coordinates.length % 2 !== 0 ||
            !coordinates.every(Number.isFinite) || !Number.isFinite(scale) ||
            maximum <= 0 || (options.maxAbsoluteValue !== undefined && !Number.isFinite(maximum))) {
            throw new Error('Projection batches require finite coordinate pairs, scale and output bounds');
        }
        const signals = [this.lifetime.signal, ...(options.signal ? [options.signal] : [])];
        const cancelled = () => signals.some(signal => signal.aborted);
        const abortError = () => {const error = new Error(this.lifetime.signal.aborted ? 'Projection operation disposed' : 'Projection operation aborted'); error.name = 'AbortError'; return error;};
        if (cancelled()) throw abortError();
        const result = coordinates.slice();
        let rejectCancellation: (error: Error) => void = () => {};
        const cancellation = new Promise<never>((_resolve, reject) => {rejectCancellation = reject;});
        const onAbort = () => rejectCancellation(abortError());
        for (const signal of signals) signal.addEventListener('abort', onAbort, {once: true});
        this.statistics.activeRequests++;
        try {
            const work = async () => {
                // Stop awaiting a caller-owned compilation on abort; do not retain this
                // request's coordinate snapshot until an unrelated factory settles.
                const transform = await Promise.race([getTransform(), cancellation]);
                if (cancelled()) throw abortError();
                const stride = this.statistics.maxBatchPositions * 2;
                for (let offset = 0; offset < result.length; offset += stride) {
                    if (cancelled()) throw abortError();
                    const chunk = result.subarray(offset, Math.min(result.length, offset + stride));
                    this.statistics.batches++;
                    this.statistics.submittedPositions += chunk.length / 2;
                    transform.projectFlatSync(chunk, 2);
                    for (let index = 0; index < chunk.length; index++) {
                        chunk[index] *= scale;
                        if ((!allowNonfinite && !Number.isFinite(chunk[index])) || Math.abs(chunk[index]) > maximum) {
                            throw new Error(maximum === Infinity ?
                                'Projection engine produced nonfinite output coordinates' : 'Projection engine produced an invalid Float32 common position');
                        }
                    }
                    if (offset + stride < result.length) {
                        this.statistics.yieldCount++;
                        await new Promise<void>(resolve => setTimeout(resolve, 0));
                    }
                }
                if (cancelled()) throw abortError();
                return result;
            };
            const output = await Promise.race([work(), cancellation]);
            if (cancelled()) throw abortError();
            this.statistics.completedRequests++;
            return output;
        } catch (error) {
            if (cancelled()) this.statistics.cancelledRequests++;
            else this.statistics.failedRequests++;
            throw error;
        } finally {
            this.statistics.activeRequests--;
            for (const signal of signals) signal.removeEventListener('abort', onAbort);
        }
    }

    /** Return detached counters; no factory objects, coordinate buffers or mutable references escape. */
    getStatistics(): ProjectionExecutionStatistics {
        return {...this.statistics};
    }

    /** Reject pending requests immediately; synchronous kernels cannot be interrupted mid-call. */
    dispose(): void {
        this.lifetime.abort();
    }
}
