// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {TileBuildQueue, TileCachePolicy, TileResidency} from '@vis.gl/tangram-renderer/map-logic';
import type {TerrainTileData, TerrainPayload} from './terrain-payload';
import {getTerrainParent, getTerrainTileKey, type TerrainTileCoordinate} from './tile-selection';
import {getTerrainChildren, terrainTileContains, terrainTilesTouch} from './globe-detail';
import type {TerrainResourceBudget, TerrainResourceLease} from '@vis.gl/tangram-renderer/map-logic';

/** One cached source tile; presentation changes never discard its image bytes. */
export interface TerrainTileRecord<Data extends TerrainPayload = TerrainTileData> {
    /** Source-normalized identity. */
    readonly key: string;
    /** Canonical XYZ address. */
    readonly coordinate: TerrainTileCoordinate;
    /** Warm downloaded bytes, retained across topology changes. */
    bytes?: ArrayBuffer;
    /** Last completed adaptive topology and physical grid. */
    data?: Data;
    /** Topology setting that produced data. */
    meshMaxError?: number;
    /** Current request failure; retry is explicit, not an infinite network loop. */
    error?: string;
}

/** Example-local loading adapter; policy is supplied by reusable renderer utilities. */
export interface TerrainTilesetOptions<Data extends TerrainPayload = TerrainTileData> {
    /** Fetch owned bytes with cancellation. */
    fetch(tile: TerrainTileCoordinate, signal: AbortSignal): Promise<ArrayBuffer>;
    /** Decode a cached copy in an owned worker. */
    decode(bytes: ArrayBuffer, tile: TerrainTileCoordinate, error: number, signal: AbortSignal): Promise<Data>;
    /** Notify the host after data, visibility, scheduling or error state changes. */
    onChange(): void;
    /** Simultaneous fetch+decode jobs, at most four. */
    maxRequests?: number;
    /** Off-screen cache entries; selected/fallback records are separately protected. */
    maxCachedTiles?: number;
    /** Off-screen byte budget, including source and decoded arrays. */
    maxCachedBytes?: number;
    /** Hard retained source/decoded-array limit, including visible and fallback records. */
    maxResidentBytes?: number;
    /** Optional shared admission with other application owners, separate from the cache-only limit. */
    resourceBudget?: TerrainResourceBudget;
    /** Conservative fetch/decode scratch and output reservation per active job; default 32 MiB. */
    decodeReservationBytes?: number;
    /** Supported source zoom interval; protects parent fallback from unsupported URLs. */
    minZoom?: number;
    maxZoom?: number;
    /** Complete mixed-zoom world cover, all ancestors retained and 2:1 drawable fallback; opt-in. */
    hierarchical?: boolean;
}

/** Fetch/decode ownership is transferred synchronously into the retained cache without double charging. */
interface TerrainDecodeReservation {
    /** Reservation still owning job scratch and not-yet-retained output. */
    lease: TerrainResourceLease;
    /** Bytes not yet handed to the retained owner. */
    bytes: number;
}

/** Bounded scheduling, warm acquisition, parent refinement and explicit resource ownership. */
export class TerrainTileset<Data extends TerrainPayload = TerrainTileData> {
    /** Retained immutable payloads keyed by source identity. */
    readonly records = new Map<string, TerrainTileRecord<Data>>();
    /** Shared scheduling policy, without a parallel scheduler implementation. */
    private readonly queue = new TileBuildQueue();
    /** Shared protection and eviction policies, separate from payload ownership. */
    private readonly residency = new TileResidency<string>();
    private readonly cache = new TileCachePolicy();
    /** Active generation identity prevents late completions replacing new content. */
    private readonly active = new Map<string, {token: string; controller: AbortController; meshMaxError: number}>();
    /** Parent-first order shared by scheduling and completed-payload admission. */
    private readonly priorities = new Map<string, number>();
    /** Completion/cancellation wakes lower-priority decoded results without polling. */
    private readonly admissionWaiters = new Set<() => void>();
    /** Requested visible detail, in stable priority order. */
    private selected: TerrainTileCoordinate[] = [];
    /** Monotonic build generation and currently requested physical error. */
    private sequence = 0;
    private meshMaxError = 20;
    private disposed = false;
    /** Idle waiters belong to this host and resolve on completion or teardown. */
    private readonly waiters: (() => void)[] = [];
    /** Source/decoded arrays share one lease; running jobs retain independent scratch leases. */
    private readonly retainedLease?: TerrainResourceLease;
    /** Last admitted shared retained total, separate from the full cache-domain byte count. */
    private retainedBytes = 0;
    /** Source buffers remain job-owned through cancellation, even after cache eviction or disposal. */
    private readonly decodingSources = new Map<ArrayBuffer, number>();

    /** Construct validated resource limits; no network or worker starts at import time. */
    constructor(private readonly options: TerrainTilesetOptions<Data>) {
        const limit = options.maxRequests ?? 2;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4 || (options.maxCachedTiles !== undefined && (!Number.isSafeInteger(options.maxCachedTiles) || options.maxCachedTiles < 0)) ||
            (options.maxCachedBytes !== undefined && (!Number.isSafeInteger(options.maxCachedBytes) || options.maxCachedBytes < 0)) ||
            (options.maxResidentBytes !== undefined && (!Number.isSafeInteger(options.maxResidentBytes) || options.maxResidentBytes < 0))) throw new Error('Invalid terrain resource budget');
        const minimum = options.minZoom ?? 0, maximum = options.maxZoom ?? 12;
        if (!Number.isSafeInteger(options.decodeReservationBytes ?? 32 * 1024 * 1024) || (options.decodeReservationBytes ?? 0) < 0) throw new Error('Invalid terrain decode reservation');
        if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum < 0 || maximum > 12 || minimum > maximum) throw new Error('Invalid terrain source domain');
        this.queue.setLimit(limit);
        this.retainedLease = options.resourceBudget?.reserve('retained', 0) ?? undefined;
    }

    /** Select bounded detail and its immediate parents; obsolete fetch/CPU work is cancelled. */
    update(tiles: readonly TerrainTileCoordinate[], meshMaxError = this.meshMaxError): void {
        if (this.disposed) return;
        if (!Number.isFinite(meshMaxError) || meshMaxError < 0 || tiles.length > (this.options.hierarchical ? 128 : 25) || new Set(tiles.map(getTerrainTileKey)).size !== tiles.length || tiles.some(tile => !Number.isSafeInteger(tile.zoom) || tile.zoom < (this.options.minZoom ?? 0) || tile.zoom > (this.options.maxZoom ?? 12) || !Number.isSafeInteger(tile.column) || !Number.isSafeInteger(tile.row) || tile.column < 0 || tile.row < 0 || tile.column >= 2 ** tile.zoom || tile.row >= 2 ** tile.zoom)) throw new Error('Invalid terrain detail selection');
        if (this.options.hierarchical) {
            if (tiles.length && (tiles.reduce((sum, tile) => sum + 4 ** -tile.zoom, 0) !== 1 || tiles.some((tile, index) => tiles.some((other, otherIndex) => index !== otherIndex && terrainTileContains(tile, other))))) throw new Error('Hierarchical terrain selection requires a complete non-overlapping world cover');
            if (tiles.some(tile => tiles.some(neighbor => Math.abs(tile.zoom - neighbor.zoom) > 1 && terrainTilesTouch(tile, neighbor)))) throw new Error('Hierarchical terrain selection requires balanced 2:1 edges');
        } else if (tiles.some(tile => tile.zoom !== tiles[0].zoom)) throw new Error('Terrain detail selection must use one source zoom; parents are managed internally');
        this.selected = tiles.map(tile => ({...tile}));
        this.meshMaxError = meshMaxError;
        const requested = new Map<string, TerrainTileCoordinate>();
        // Coarse coverage loads first; siblings only replace their parent together.
        for (const tile of tiles) {
            let parent = this.getParent(tile);
            while (parent) {
                requested.set(getTerrainTileKey(parent), parent);
                parent = this.options.hierarchical ? this.getParent(parent) : null;
            }
        }
        for (const tile of tiles) requested.set(getTerrainTileKey(tile), tile);
        if (this.options.hierarchical) {
            const ordered = [...requested.values()].sort((first, second) => first.zoom - second.zoom || first.row - second.row || first.column - second.column);
            requested.clear(); for (const tile of ordered) requested.set(getTerrainTileKey(tile), tile);
        }
        this.priorities.clear();
        [...requested.keys()].forEach((key, priority) => this.priorities.set(key, priority));
        this.residency.updateConsumer('view', [...requested.keys()], this.getDrawableTiles().map(record => record.key));
        this.queue.suspend();
        try {
            // A newly selected coarse request must acquire a slot before old detail can
            // publish. Waiting for queued work inside a full active pool would deadlock.
            const pendingPriority = Math.min(...[...requested.keys()].filter(key => {
                const record = this.records.get(key);
                return !record?.error && !(record?.data && record.meshMaxError === meshMaxError) && this.active.get(key)?.meshMaxError !== meshMaxError;
            }).map(key => this.priorities.get(key) ?? Infinity));
            for (const [key, active] of this.active) if (!requested.has(key) || (this.priorities.get(key) ?? Infinity) > pendingPriority) {this.active.delete(key); active.controller.abort(); this.queue.cancel(key);}
            // Remove queued work too; cancellation must not wait for an active slot.
            for (const key of this.records.keys()) if (!requested.has(key)) this.queue.cancel(key);
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
                this.queue.enqueue({key, token, priority: this.priorities.get(key) ?? Infinity, start: () => {void this.load(selectedRecord, token, meshMaxError);}, fail: error => {selectedRecord.error = String(error);}});
            }
            this.evict();
        } finally {this.queue.resume(); this.wakeAdmission();}
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
    getDrawableTiles(): TerrainTileRecord<Data>[] {
        if (this.options.hierarchical) return this.getDrawableHierarchy();
        const groups = new Map<string, TerrainTileCoordinate[]>();
        for (const tile of this.selected) {const parent = this.getParent(tile); const key = parent ? getTerrainTileKey(parent) : getTerrainTileKey(tile); const group = groups.get(key) ?? []; group.push(tile); groups.set(key, group);}
        const drawable: TerrainTileRecord<Data>[] = [];
        for (const [parentKey, children] of groups) {
            const ready = children.flatMap(tile => {const record = this.records.get(getTerrainTileKey(tile)); return record?.data ? [record] : [];});
            const parent = this.records.get(parentKey);
            if (ready.length !== children.length && parent?.data) drawable.push(parent);
            else drawable.push(...ready);
        }
        return drawable;
    }

    /** Complete sibling substitution and rollback keep loaded fallback edges at most 2:1. */
    private getDrawableHierarchy(): TerrainTileRecord<Data>[] {
        const selected = new Set(this.selected.map(getTerrainTileKey)), roots = new Map<string, TerrainTileCoordinate>();
        for (const tile of this.selected) {
            let root = tile, parent = this.getParent(root);
            while (parent) {root = parent; parent = this.getParent(root);}
            roots.set(getTerrainTileKey(root), root);
        }
        /** A branch either has full child coverage or retains its loaded ancestor. */
        const visit = (tile: TerrainTileCoordinate): TerrainTileRecord<Data>[] | null => {
            const key = getTerrainTileKey(tile), record = this.records.get(key);
            if (selected.has(key)) return record?.data ? [record] : null;
            const children = getTerrainChildren(tile).map(visit);
            return children.every(child => child !== null) ? children.flatMap(child => child ?? []) : record?.data ? [record] : null;
        };
        let drawable = [...roots.values()].flatMap(root => visit(root) ?? []);
        for (;;) {
            const fine = drawable.find(tile => drawable.some(neighbor => tile.coordinate.zoom > neighbor.coordinate.zoom + 1 && terrainTilesTouch(tile.coordinate, neighbor.coordinate)));
            if (!fine) return drawable;
            const coarse = drawable.find(neighbor => fine.coordinate.zoom > neighbor.coordinate.zoom + 1 && terrainTilesTouch(fine.coordinate, neighbor.coordinate))!;
            let ancestor = fine.coordinate;
            while (ancestor.zoom > coarse.coordinate.zoom + 1) ancestor = this.getParent(ancestor)!;
            let fallback = this.records.get(getTerrainTileKey(ancestor));
            // A provider may fail an intermediate ancestor. Prefer an older loaded ancestor;
            // if even the root is missing, omit the branch rather than draw an unsupported seam.
            while (!fallback?.data) {
                const parent = this.getParent(ancestor);
                if (!parent) break;
                ancestor = parent; fallback = this.records.get(getTerrainTileKey(ancestor));
            }
            drawable = drawable.filter(tile => !terrainTileContains(ancestor, tile.coordinate));
            if (fallback?.data) drawable.push(fallback);
        }
    }

    /** Detached queue, error and byte counts for user-visible resource diagnostics. */
    getStatistics(): {active: number; queued: number; resident: number; bytes: number; sourceBytes: number; gridBytes: number; meshBytes: number; byteLimit: number; failed: number; failure?: string} {
        const counts = this.queue.getCounts();
        const memory = [...this.records.values()].map(record => this.getRecordMemory(record));
        return {active: counts.activeBuilds, queued: counts.queuedBuilds, resident: this.records.size,
            bytes: memory.reduce((sum, record) => sum + record.bytes, 0), sourceBytes: memory.reduce((sum, record) => sum + record.sourceBytes, 0),
            gridBytes: memory.reduce((sum, record) => sum + record.gridBytes, 0), meshBytes: memory.reduce((sum, record) => sum + record.meshBytes, 0),
            byteLimit: this.options.maxResidentBytes ?? 128 * 1024 * 1024, failed: [...this.records.values()].filter(record => record.error).length,
            failure: [...this.records.values()].find(record => record.error)?.error};
    }

    /** Cancel actual work before releasing queue/cache metadata; safe to repeat. */
    destroy(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const request of this.active.values()) request.controller.abort();
        this.active.clear(); this.queue.clear(); this.cache.clear(); this.residency.clear(); this.records.clear(); this.priorities.clear(); this.wakeAdmission();
        this.retainedLease?.release();
        this.retainedBytes = 0;
        this.resolveIdle();
    }

    /** Acquire once, decode a warm copy, then publish only the currently owned generation. */
    private async load(record: TerrainTileRecord<Data>, token: string, meshMaxError: number): Promise<void> {
        const controller = new AbortController();
        this.active.set(record.key, {token, controller, meshMaxError});
        let scratch: TerrainDecodeReservation | undefined;
        let decodingSource: ArrayBuffer | undefined;
        try {
            const reservationBytes = this.options.decodeReservationBytes ?? 32 * 1024 * 1024;
            const lease = this.options.resourceBudget?.reserve('transient', reservationBytes);
            if (lease) scratch = {lease, bytes: reservationBytes};
            if (this.options.resourceBudget && !scratch) throw new Error('Terrain shared resource budget cannot admit fetch/decode');
            const bytes = record.bytes ?? await this.options.fetch(record.coordinate, controller.signal);
            if (controller.signal.aborted || this.disposed) return;
            if (scratch && bytes.byteLength > (this.options.decodeReservationBytes ?? 32 * 1024 * 1024)) throw new Error('Terrain source exceeds decode reservation');
            if (scratch) {
                decodingSource = bytes;
                this.decodingSources.set(bytes, (this.decodingSources.get(bytes) ?? 0) + 1);
            }
            this.admit({...record, bytes}, scratch);
            record.bytes = bytes;
            const data = await this.options.decode(bytes, record.coordinate, meshMaxError, controller.signal);
            if (scratch && bytes.byteLength * 2 + this.getRecordBytes({key: record.key, coordinate: record.coordinate, data}) > (this.options.decodeReservationBytes ?? 32 * 1024 * 1024)) throw new Error('Terrain output exceeds decode reservation');
            await this.waitForAdmission(record.key, controller.signal);
            if (this.disposed || controller.signal.aborted || this.active.get(record.key)?.token !== token) return;
            this.admit({...record, data}, scratch);
            record.data = data; record.meshMaxError = meshMaxError; record.error = undefined;
        } catch (error) {
            if (!this.disposed && !controller.signal.aborted && this.active.get(record.key)?.token === token) record.error = error instanceof Error ? error.message : String(error);
        } finally {
            if (decodingSource) {
                const owners = (this.decodingSources.get(decodingSource) ?? 1) - 1;
                if (owners) this.decodingSources.set(decodingSource, owners);
                else this.decodingSources.delete(decodingSource);
                if (!this.disposed) this.resizeRetainedLease([...this.records.values()].reduce((sum, record) => sum + this.getSharedRecordBytes(record), 0), scratch);
            }
            scratch?.lease.release();
            if (this.active.get(record.key)?.token === token) {
                this.active.delete(record.key); this.queue.finish(record.key, token);
                this.residency.updateConsumer('view', this.residency.getSelectedTileKeys(), this.getDrawableTiles().map(tile => tile.key));
                this.evict(); this.queue.pump(); this.wakeAdmission(); this.options.onChange(); this.resolveIdle();
            }
        }
    }

    /** Concurrent decoding is allowed, but lower-priority results cannot starve pending parents. */
    private async waitForAdmission(key: string, signal: AbortSignal): Promise<void> {
        while (!this.disposed && !signal.aborted && [...this.active.keys()].some(other => (this.priorities.get(other) ?? Infinity) < (this.priorities.get(key) ?? Infinity))) {
            await new Promise<void>(resolve => {
                const wake = () => {this.admissionWaiters.delete(wake); signal.removeEventListener('abort', wake); resolve();};
                this.admissionWaiters.add(wake); signal.addEventListener('abort', wake, {once: true});
            });
        }
    }

    /** Notify admission waiters after any active ownership transition. */
    private wakeAdmission(): void {
        for (const wake of [...this.admissionWaiters]) wake();
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
    private getRecordBytes(record: TerrainTileRecord<Data>): number {
        return this.getRecordMemory(record).bytes;
    }

    /** Unique backing storage belongs to the first source/grid/mesh category referencing it; sums match admission. */
    private getRecordMemory(record: TerrainTileRecord<Data>): {bytes: number; sourceBytes: number; gridBytes: number; meshBytes: number} {
        const buffers = new Set<ArrayBufferLike>();
        const add = (buffer: ArrayBufferLike): number => {if (buffers.has(buffer)) return 0; buffers.add(buffer); return buffer.byteLength;};
        const sourceBytes = record.bytes ? add(record.bytes) : 0;
        let gridBytes = 0, meshBytes = 0;
        if (record.data) {
            gridBytes += add(record.data.grid.heights.buffer) + add(record.data.grid.valid.buffer);
            for (const attribute of Object.values(record.data.mesh?.attributes ?? {})) meshBytes += add(attribute.value.buffer);
            if (record.data.mesh?.indices) meshBytes += add(record.data.mesh.indices.value.buffer);
        }
        return {bytes: sourceBytes + gridBytes + meshBytes, sourceBytes, gridBytes, meshBytes};
    }

    /** Admit atomically: evict cold arrays first, never exceed the cap or discard a warm fallback. */
    private admit(candidate: TerrainTileRecord<Data>, scratch?: TerrainDecodeReservation): void {
        const records = [...this.records.values()].map(record => {
            const retained = record.key === candidate.key ? candidate : record;
            return {key: record.key, bytes: this.getRecordBytes(retained), protected: record.key === candidate.key || this.residency.isProtected(record.key) || this.queue.has(record.key)};
        });
        let protectedBytes = records.filter(record => record.protected).reduce((sum, record) => sum + record.bytes, 0);
        const limit = this.options.maxResidentBytes ?? 128 * 1024 * 1024;
        const yielded: TerrainTileRecord<Data>[] = [];
        // A lower-priority warm download must not prevent the first complete coarse tile.
        // Plan all releases before mutating ownership; completed fallback geometry is never sacrificed.
        for (const record of [...this.records.values()].sort((first, second) => (this.priorities.get(second.key) ?? Infinity) - (this.priorities.get(first.key) ?? Infinity))) {
            if (protectedBytes <= limit) break;
            const failedInactive = record.error && !this.queue.has(record.key) && !this.active.has(record.key);
            if (record.key === candidate.key || record.data || !record.bytes || !this.residency.isProtected(record.key) || !failedInactive && (this.priorities.get(record.key) ?? Infinity) <= (this.priorities.get(candidate.key) ?? Infinity)) continue;
            yielded.push(record); protectedBytes -= this.getRecordBytes(record);
            const snapshot = records.find(snapshot => snapshot.key === record.key);
            if (snapshot) snapshot.bytes = 0;
        }
        if (protectedBytes > limit) throw new Error(`Terrain retained-array budget exceeded (${protectedBytes} > ${limit} bytes); use coarser detail or mesh error`);
        const evictions = this.cache.selectEvictions(records, {maxCachedTiles: this.options.maxCachedTiles ?? 24, maxCachedBytes: Math.min(this.options.maxCachedBytes ?? 32 * 1024 * 1024, limit - protectedBytes)});
        const removed = new Set([...evictions, ...yielded.map(record => record.key)]);
        const bytes = [...this.records.values()].reduce((sum, record) => sum + (removed.has(record.key) ? 0 : this.getSharedRecordBytes(record.key === candidate.key ? candidate : record)), 0);
        // Reserve the complete planned result before evicting bytes or aborting lower-priority work.
        this.resizeRetainedLease(bytes, scratch);
        for (const record of yielded) {
            const active = this.active.get(record.key);
            this.active.delete(record.key); active?.controller.abort(); this.queue.cancel(record.key);
            record.bytes = undefined; record.error ??= 'Terrain retained-array budget yielded to higher-priority coverage; use coarser detail or mesh error';
        }
        for (const key of evictions) {
            this.records.delete(key); this.cache.forget(key);
        }
    }

    /** In-flight source buffers are covered by job reservations until the last decoder settles. */
    private getSharedRecordBytes(record: TerrainTileRecord<Data>): number {
        return this.getRecordBytes(record) - (record.bytes && this.decodingSources.has(record.bytes) ? record.bytes.byteLength : 0);
    }

    /** Synchronous handoff/rollback cannot expose duplicate output charges or mutate cache ownership on refusal. */
    private resizeRetainedLease(bytes: number, scratch?: TerrainDecodeReservation): void {
        if (!this.retainedLease) return;
        const credit = scratch ? Math.min(scratch.bytes, Math.max(0, bytes - this.retainedBytes)) : 0;
        if (scratch && credit && !scratch.lease.resize(scratch.bytes - credit)) throw new Error('Terrain decode reservation is no longer owned');
        if (!this.retainedLease.resize(bytes)) {
            if (scratch && credit) scratch.lease.resize(scratch.bytes);
            throw new Error('Terrain shared resource budget cannot retain decoded replacement');
        }
        if (scratch) scratch.bytes -= credit;
        this.retainedBytes = bytes;
    }

    /** Only release off-screen, inactive records; protected memory is bounded by selection. */
    private evict(): void {
        const records = [...this.records.values()].map(record => ({key: record.key, bytes: this.getRecordBytes(record), protected: this.residency.isProtected(record.key) || this.queue.has(record.key)}));
        for (const key of this.cache.selectEvictions(records, {maxCachedTiles: this.options.maxCachedTiles ?? 24, maxCachedBytes: this.options.maxCachedBytes ?? 32 * 1024 * 1024})) {this.records.delete(key); this.cache.forget(key);}
        this.resizeRetainedLease([...this.records.values()].reduce((sum, record) => sum + this.getSharedRecordBytes(record), 0));
    }
}
