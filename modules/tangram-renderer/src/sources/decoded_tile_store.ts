// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** One consumer's interest in a decoded tile; releasing it cannot cancel another consumer. */
export interface DecodedTileLease<ValueT> {
    /** Independent completion, rejected promptly when this lease is released before completion. */
    readonly promise: Promise<ValueT>;
    /** Whether this consumer still owns a lease, including after synchronous source invalidation. */
    isActive(): boolean;
    /** Idempotently release this consumer's residency and request ownership. */
    release(): void;
}

/** Source revision and unwrapped normalized data identity, never a mesh/style key. */
export interface DecodedTileAcquisition<ValueT> {
    /** Opaque source-instance revision, owned by the worker adapter. */
    readonly source: object;
    /** Normalized data coordinate key, preserving world-copy distinctions. */
    readonly key: string;
    /** Original acquisition/decode procedure; invoked once for compatible concurrent leases. */
    load(signal: AbortSignal): Promise<ValueT>;
}

/** Detached diagnostics; missing allocation estimates never masquerade as zero decoded bytes. */
export interface DecodedTileStatistics {
    /** Pending unique acquisitions. */
    loadingTiles: number;
    /** Ready records protected by live leases; there is no unreferenced warm cache. */
    readyTiles: number;
    /** Live consumer leases across pending and ready records. */
    consumers: number;
    /** Actual acquisition attempts since store creation. */
    acquisitions: number;
    /** Acquisitions served by an existing pending or ready record. */
    sharedAcquisitions: number;
    /** Requests cancelled when their final lease or source revision was released. */
    cancelledAcquisitions: number;
    /** Rejected acquisition attempts, excluding invalidated late completions. */
    failedAcquisitions: number;
    /** Ready payload bytes, undefined if any live ready record has unknown size. */
    decodedBytes: number | undefined;
}

/** Consumer settlement hooks do not contain renderer or worker tile objects. */
interface LeaseSettlement<ValueT> {
    /** Resolve only this lease. */
    resolve(value: ValueT): void;
    /** Reject only this lease. */
    reject(error: unknown): void;
}

/** One source/data acquisition, independent of styled meshes and build generations. */
interface DecodedRecord<ValueT> {
    /** Cancellation belongs to the unique acquisition, not its first consumer. */
    readonly controller: AbortController;
    /** Live consumers, including ready records retained for overzoom/rebuild reuse. */
    readonly consumers: Set<LeaseSettlement<ValueT>>;
    /** Successful content publication, absent while acquisition is pending. */
    result?: {value: ValueT};
}

/** Portable cancellation error for leases, source invalidation, and stale publication. */
export function createTileLeaseAbortError(): Error {
    const error = new Error('Decoded tile lease released');
    error.name = 'AbortError';
    return error;
}

/** Worker-local shared acquisition with source-instance revisions and zero warm retention. */
export default class DecodedTileStore<ValueT> {
    /** Source revisions stay retained only while they have live records. */
    private readonly sources = new Map<object, Map<string, DecodedRecord<ValueT>>>();
    /** Optional decoded allocation estimator; encoded network bytes are not a substitute. */
    private readonly getByteLength: (value: ValueT) => number | undefined;
    /** Actual unique acquisition attempts. */
    private acquisitions = 0;
    /** Reused pending/ready acquisitions. */
    private sharedAcquisitions = 0;
    /** Underlying requests cancelled at final release or invalidation. */
    private cancelledAcquisitions = 0;
    /** Underlying acquisition failures. */
    private failedAcquisitions = 0;

    /** Create an empty store without fetch, decode, traversal, or GPU dependencies. */
    constructor(getByteLength: (value: ValueT) => number | undefined = () => undefined) {
        this.getByteLength = getByteLength;
    }

    /** Acquire one consumer lease, sharing only the exact source revision and data key. */
    acquireTile(request: DecodedTileAcquisition<ValueT>): DecodedTileLease<ValueT> {
        let records = this.sources.get(request.source);
        if (!records) { records = new Map(); this.sources.set(request.source, records); }
        let record = records.get(request.key);
        const created = !record;
        if (!record) {
            record = {controller: new AbortController(), consumers: new Set()};
            records.set(request.key, record);
            this.acquisitions++;
        } else this.sharedAcquisitions++;
        const current = record;
        let resolveLease: (value: ValueT) => void = () => {};
        let rejectLease: (error: unknown) => void = () => {};
        const promise = new Promise<ValueT>((resolve, reject) => {
            resolveLease = resolve;
            rejectLease = reject;
        });
        const consumer = {resolve: resolveLease, reject: rejectLease};
        current.consumers.add(consumer);
        if (current.result) consumer.resolve(current.result.value);
        if (created) {
            Promise.resolve().then(() => {
                if (current.controller.signal.aborted) throw createTileLeaseAbortError();
                return request.load(current.controller.signal);
            }).then(value => {
                if (!this.isCurrent(request.source, request.key, current)) return;
                current.result = {value};
                for (const lease of current.consumers) lease.resolve(value);
            }, error => {
                if (!this.isCurrent(request.source, request.key, current)) return;
                this.failedAcquisitions++;
                this.forgetRecord(request.source, request.key, current);
                for (const lease of current.consumers) lease.reject(error);
                current.consumers.clear();
            });
        }
        return {promise, isActive: () => current.consumers.has(consumer), release: () => {
            if (!current.consumers.delete(consumer)) return;
            if (!current.result) consumer.reject(createTileLeaseAbortError());
            if (current.consumers.size === 0) {
                this.forgetRecord(request.source, request.key, current);
                this.cancelRecord(current);
            }
        }};
    }

    /** Release one obsolete source revision without touching a successor source instance. */
    invalidateSource(source: object): void {
        const records = this.sources.get(source);
        if (!records) return;
        this.sources.delete(source);
        for (const record of records.values()) {
            for (const lease of record.consumers) lease.reject(createTileLeaseAbortError());
            record.consumers.clear();
            this.cancelRecord(record);
        }
    }

    /** Return unique content and consumer counts without retaining or exposing internal records. */
    getStatistics(): DecodedTileStatistics {
        let loadingTiles = 0, readyTiles = 0, consumers = 0, decodedBytes: number | undefined = 0;
        for (const records of this.sources.values()) for (const record of records.values()) {
            consumers += record.consumers.size;
            if (!record.result) { loadingTiles++; continue; }
            readyTiles++;
            const bytes = this.getByteLength(record.result.value);
            if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) decodedBytes = undefined;
            else if (decodedBytes !== undefined) decodedBytes += bytes;
        }
        return {loadingTiles, readyTiles, consumers, decodedBytes, acquisitions: this.acquisitions,
            sharedAcquisitions: this.sharedAcquisitions, cancelledAcquisitions: this.cancelledAcquisitions,
            failedAcquisitions: this.failedAcquisitions};
    }

    /** Cancel all pending work and release content; subsequent use starts from an empty store. */
    finalize(): void { for (const source of this.sources.keys()) this.invalidateSource(source); }

    /** A late completion cannot publish over a replacement attempt for the same coordinate. */
    private isCurrent(source: object, key: string, record: DecodedRecord<ValueT>): boolean {
        return !record.controller.signal.aborted && this.sources.get(source)?.get(key) === record;
    }

    /** Forget only the matching attempt and release empty source maps immediately. */
    private forgetRecord(source: object, key: string, record: DecodedRecord<ValueT>): void {
        const records = this.sources.get(source);
        if (records?.get(key) !== record) return;
        records.delete(key);
        if (records.size === 0) this.sources.delete(source);
    }

    /** Ready content has no pending request; cancellation is issued at most once. */
    private cancelRecord(record: DecodedRecord<ValueT>): void {
        if (!record.result && !record.controller.signal.aborted) {
            this.cancelledAcquisitions++;
            record.controller.abort();
        }
    }
}
