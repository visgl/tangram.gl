// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {TileBuildQueue, TileCachePolicy, TileResidency} from '@vis.gl/tangram-renderer/map-logic';
import type {TerrainTileData} from './decode-terrain';
import {getTerrainParent, getTerrainTileKey, type TerrainTileCoordinate} from './tile-selection';

/** One cached source tile; presentation changes never discard its image bytes. */
export interface TerrainTileRecord {
    /** Source-normalized identity. */
    readonly key: string;
    /** Canonical XYZ address. */
    readonly coordinate: TerrainTileCoordinate;
    /** Warm downloaded bytes, retained across topology changes. */
    bytes?: ArrayBuffer;
    /** Last completed adaptive topology and physical grid. */
    data?: TerrainTileData;
    /** Topology setting that produced data. */
    meshMaxError?: number;
    /** Current request failure; retry is explicit, not an infinite network loop. */
    error?: string;
}

/** Example-local loading adapter; policy is supplied by reusable renderer utilities. */
export interface TerrainTilesetOptions {
    /** Fetch owned bytes with cancellation. */
    fetch(tile: TerrainTileCoordinate, signal: AbortSignal): Promise<ArrayBuffer>;
    /** Decode a cached copy in an owned worker. */
    decode(bytes: ArrayBuffer, tile: TerrainTileCoordinate, error: number, signal: AbortSignal): Promise<TerrainTileData>;
    /** Notify the host after data, visibility, scheduling or error state changes. */
    onChange(): void;
    /** Simultaneous fetch+decode jobs, at most four. */
    maxRequests?: number;
    /** Off-screen cache entries; selected/fallback records are separately protected. */
    maxCachedTiles?: number;
    /** Off-screen byte budget, including source and decoded arrays. */
    maxCachedBytes?: number;
    /** Supported source zoom interval; protects parent fallback from unsupported URLs. */
    minZoom?: number;
    maxZoom?: number;
}

/** Bounded scheduling, warm acquisition, parent refinement and explicit resource ownership. */
export class TerrainTileset {
    /** Retained immutable payloads keyed by source identity. */
    readonly records = new Map<string, TerrainTileRecord>();
    /** Shared scheduling policy, without a parallel scheduler implementation. */
    private readonly queue = new TileBuildQueue();
    /** Shared protection and eviction policies, separate from payload ownership. */
    private readonly residency = new TileResidency<string>();
    private readonly cache = new TileCachePolicy();
    /** Active generation identity prevents late completions replacing new content. */
    private readonly active = new Map<string, {token: string; controller: AbortController; meshMaxError: number}>();
    /** Requested visible detail, in stable priority order. */
    private selected: TerrainTileCoordinate[] = [];
    /** Monotonic build generation and currently requested physical error. */
    private sequence = 0;
    private meshMaxError = 20;
    private disposed = false;
    /** Idle waiters belong to this host and resolve on completion or teardown. */
    private readonly waiters: (() => void)[] = [];

    /** Construct validated resource limits; no network or worker starts at import time. */
    constructor(private readonly options: TerrainTilesetOptions) {
        const limit = options.maxRequests ?? 2;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4 || (options.maxCachedTiles !== undefined && (!Number.isSafeInteger(options.maxCachedTiles) || options.maxCachedTiles < 0)) ||
            (options.maxCachedBytes !== undefined && (!Number.isFinite(options.maxCachedBytes) || options.maxCachedBytes < 0))) throw new Error('Invalid terrain resource budget');
        const minimum = options.minZoom ?? 0, maximum = options.maxZoom ?? 12;
        if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum < 0 || maximum > 12 || minimum > maximum) throw new Error('Invalid terrain source domain');
        this.queue.setLimit(limit);
    }

    /** Select bounded detail and its immediate parents; obsolete fetch/CPU work is cancelled. */
    update(tiles: readonly TerrainTileCoordinate[], meshMaxError = this.meshMaxError): void {
        if (this.disposed) return;
        if (!Number.isFinite(meshMaxError) || meshMaxError < 0 || tiles.length > 25 || new Set(tiles.map(getTerrainTileKey)).size !== tiles.length || tiles.some(tile => !Number.isSafeInteger(tile.zoom) || tile.zoom < (this.options.minZoom ?? 0) || tile.zoom > (this.options.maxZoom ?? 12) || !Number.isSafeInteger(tile.column) || !Number.isSafeInteger(tile.row) || tile.column < 0 || tile.row < 0 || tile.column >= 2 ** tile.zoom || tile.row >= 2 ** tile.zoom)) throw new Error('Invalid terrain detail selection');
        this.selected = tiles.map(tile => ({...tile}));
        this.meshMaxError = meshMaxError;
        const requested = new Map<string, TerrainTileCoordinate>();
        // Coarse coverage loads first; siblings only replace their parent together.
        for (const tile of tiles) {const parent = this.getParent(tile); if (parent) requested.set(getTerrainTileKey(parent), parent);}
        for (const tile of tiles) requested.set(getTerrainTileKey(tile), tile);
        this.residency.updateConsumer('view', [...requested.keys()], this.getDrawableTiles().map(record => record.key));
        this.queue.suspend();
        try {
            for (const [key, active] of this.active) if (!requested.has(key)) {this.active.delete(key); active.controller.abort(); this.queue.cancel(key);}
            // Remove queued work too; cancellation must not wait for an active slot.
            for (const key of this.records.keys()) if (!requested.has(key)) this.queue.cancel(key);
            let priority = 0;
            for (const [key, coordinate] of requested) {
                let record = this.records.get(key);
                if (!record) {record = {key, coordinate}; this.records.set(key, record);}
                this.cache.touch(key);
                const running = this.active.get(key);
                if (running && running.meshMaxError !== meshMaxError) {this.active.delete(key); running.controller.abort(); this.queue.cancel(key);}
                if (record.data && record.meshMaxError === meshMaxError) {this.queue.cancel(key); continue;}
                if (record.error || running?.meshMaxError === meshMaxError) continue;
                const token = String(++this.sequence);
                const selectedRecord = record;
                this.queue.enqueue({key, token, priority: priority++, start: () => {void this.load(selectedRecord, token, meshMaxError);}, fail: error => {selectedRecord.error = String(error);}});
            }
            this.evict();
        } finally {this.queue.resume();}
        this.options.onChange();
        this.resolveIdle();
    }

    /** Await the currently scheduled batch, including decode failures, without polling. */
    waitForIdle(): Promise<void> {
        const counts = this.queue.getCounts();
        return this.disposed || !counts.activeBuilds && !counts.queuedBuilds ? Promise.resolve() : new Promise(resolve => this.waiters.push(resolve));
    }

    /** Retry only selected failed resources, preserving successful cached acquisitions. */
    retry(): void {
        for (const record of this.records.values()) record.error = undefined;
        this.update(this.selected);
    }

    /** Non-overlapping parent fallback; never overlay a coarse tile with its ready siblings. */
    getDrawableTiles(): TerrainTileRecord[] {
        const groups = new Map<string, TerrainTileCoordinate[]>();
        for (const tile of this.selected) {const parent = this.getParent(tile); const key = parent ? getTerrainTileKey(parent) : getTerrainTileKey(tile); const group = groups.get(key) ?? []; group.push(tile); groups.set(key, group);}
        const drawable: TerrainTileRecord[] = [];
        for (const [parentKey, children] of groups) {
            const ready = children.flatMap(tile => {const record = this.records.get(getTerrainTileKey(tile)); return record?.data ? [record] : [];});
            const parent = this.records.get(parentKey);
            if (ready.length !== children.length && parent?.data) drawable.push(parent);
            else drawable.push(...ready);
        }
        return drawable;
    }

    /** Detached queue, error and byte counts for user-visible resource diagnostics. */
    getStatistics(): {active: number; queued: number; resident: number; bytes: number; failed: number} {
        const counts = this.queue.getCounts();
        return {active: counts.activeBuilds, queued: counts.queuedBuilds, resident: this.records.size,
            bytes: [...this.records.values()].reduce((sum, record) => sum + this.getRecordBytes(record), 0), failed: [...this.records.values()].filter(record => record.error).length};
    }

    /** Cancel actual work before releasing queue/cache metadata; safe to repeat. */
    destroy(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const request of this.active.values()) request.controller.abort();
        this.active.clear(); this.queue.clear(); this.cache.clear(); this.residency.clear(); this.records.clear();
        this.resolveIdle();
    }

    /** Acquire once, decode a warm copy, then publish only the currently owned generation. */
    private async load(record: TerrainTileRecord, token: string, meshMaxError: number): Promise<void> {
        const controller = new AbortController();
        this.active.set(record.key, {token, controller, meshMaxError});
        try {
            const bytes = record.bytes ?? await this.options.fetch(record.coordinate, controller.signal);
            if (controller.signal.aborted || this.disposed) return;
            record.bytes = bytes;
            const data = await this.options.decode(bytes, record.coordinate, meshMaxError, controller.signal);
            if (this.disposed || controller.signal.aborted || this.active.get(record.key)?.token !== token) return;
            record.data = data; record.meshMaxError = meshMaxError; record.error = undefined;
        } catch (error) {
            if (!this.disposed && !controller.signal.aborted && this.active.get(record.key)?.token === token) record.error = error instanceof Error ? error.message : String(error);
        } finally {
            if (this.active.get(record.key)?.token === token) {
                this.active.delete(record.key); this.queue.finish(record.key, token);
                this.residency.updateConsumer('view', this.residency.getSelectedTileKeys(), this.getDrawableTiles().map(tile => tile.key));
                this.evict(); this.queue.pump(); this.options.onChange(); this.resolveIdle();
            }
        }
    }

    /** Settle host readiness once no active or queued ownership remains. */
    private resolveIdle(): void {
        const counts = this.queue.getCounts();
        if (!counts.activeBuilds && !counts.queuedBuilds) this.waiters.splice(0).forEach(resolve => resolve());
    }

    /** Never acquire a parent outside the selected source's supported interval. */
    private getParent(tile: TerrainTileCoordinate): TerrainTileCoordinate | null {
        return tile.zoom > (this.options.minZoom ?? 0) ? getTerrainParent(tile) : null;
    }

    /** Count unique typed-array buffers as well as retained compressed bytes. */
    private getRecordBytes(record: TerrainTileRecord): number {
        const buffers = new Set<ArrayBufferLike>();
        if (record.bytes) buffers.add(record.bytes);
        if (record.data) {
            buffers.add(record.data.grid.heights.buffer); buffers.add(record.data.grid.valid.buffer);
            for (const attribute of Object.values(record.data.mesh.attributes)) buffers.add(attribute.value.buffer);
            if (record.data.mesh.indices) buffers.add(record.data.mesh.indices.value.buffer);
        }
        return [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0);
    }

    /** Only release off-screen, inactive records; protected memory is bounded by selection. */
    private evict(): void {
        const records = [...this.records.values()].map(record => ({key: record.key, bytes: this.getRecordBytes(record), protected: this.residency.isProtected(record.key) || this.queue.has(record.key)}));
        for (const key of this.cache.selectEvictions(records, {maxCachedTiles: this.options.maxCachedTiles ?? 24, maxCachedBytes: this.options.maxCachedBytes ?? 32 * 1024 * 1024})) {this.records.delete(key); this.cache.forget(key);}
    }
}
