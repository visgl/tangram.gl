// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {TerrainMeshSurface} from '@tangram.gl/tangram-renderer/core';
import {assertGlobeTerrainPreparationSnapshot, getPreparedGlobeTerrainTemplate, getGlobeTerrainExaggeration, scaleGlobeTerrainMeshSteps,
    type GlobeTerrainMesh, type GlobeTerrainMeshTemplate, type GlobeTerrainPreparationSnapshot, type TerrainHeightGrid,
    type TerrainResourceBudget, type TerrainResourceLease} from '@tangram.gl/tangram-renderer/map-logic';

/** Packed attributes shared with deck.gl; raw spherical/physical arrays are copied into the query owner. */
export function getTerrainRenderMesh(mesh: GlobeTerrainMesh) {
    return {attributes: {POSITION: {size: 3, value: mesh.geographicPositions}, COLOR_0: {size: 3, value: mesh.colors}}, indices: {size: 1, value: mesh.indices}};
}

/** Internal complete draw/query tile; never expose partial work or mutable mesh buffers through the package API. */
export interface GlobeTerrainDisplayTile {
    grid: TerrainHeightGrid;
    template: GlobeTerrainMeshTemplate;
    exaggeration: number;
    mesh: ReturnType<typeof getTerrainRenderMesh>;
    surface: TerrainMeshSurface;
    queryLimit: number;
}

/** Opaque complete display/query generation; only this library can produce usable handles. */
export interface GlobeTerrainDisplaySnapshot {
    /** Completed physical sampling/topology generation used by every tile. */
    readonly terrain: GlobeTerrainPreparationSnapshot;
    /** Actual display multiplier; physical height queries remain unexaggerated. */
    readonly exaggeration: number;
    /** Retained display/query geometry arrays, excluding templates, scratch and acceleration. */
    readonly byteLength: number;
    /** Controller's current-plus-replacement geometry cap, which must match the consuming layer. */
    readonly maxDisplayBytes: number;
    /** Current lazy acceleration cap, which must match the consuming layer. */
    readonly maxQueryIndexBytes: number;
}

/** Detached work/retention diagnostics; elapsed CPU work is not whole-frame or GPU time. */
export interface GlobeTerrainDisplayStatistics {
    /** Tiles still awaiting display preparation. */
    pending: number;
    /** Unique current/staged display/query geometry arrays. */
    retainedBytes: number;
    /** Current-plus-replacement geometry cap. */
    byteLimit: number;
    /** Full current-plus-new geometry requirement from preflight; zero until the request is advanced. */
    requiredPeakBytes: number;
    /** Allocated current/staged acceleration arrays, counting shared surfaces once. */
    queryIndexBytes: number;
    /** New tile indexes warmed before publication; insufficient peak space defers lazy acceleration. */
    warmedIndexes: number;
    /** New tile indexes left lazy because current-plus-staged acceleration would exceed the cap. */
    deferredIndexes: number;
    /** New tiles in the current request. */
    prepared: number;
    /** Reused display/query tiles in the current request. */
    reused: number;
    /** Completed atomically published generations. */
    committed: number;
    /** Requests replaced before completion. */
    cancelled: number;
    /** Work slices in the current request. */
    slices: number;
    /** Last slice elapsed time, including any indivisible query snapshot copy. */
    lastSliceMs: number;
    /** Largest slice elapsed time in the current request. */
    maxSliceMs: number;
    /** Sum of slice elapsed times, excluding host yields. */
    workMs: number;
    /** Last admission/scaling failure; unchanged requests do not automatically retry. */
    error?: string;
}

const displays = new WeakMap<GlobeTerrainDisplaySnapshot, readonly GlobeTerrainDisplayTile[]>();

/** Internal layer boundary: resolve only complete library-owned display/query generations. */
export function resolveGlobeTerrainDisplay(snapshot: GlobeTerrainDisplaySnapshot): readonly GlobeTerrainDisplayTile[] {
    const tiles = displays.get(snapshot);
    if (!tiles) throw new Error('Globe terrain display requires a completed library snapshot');
    return tiles;
}

/** Exact retained render attributes/topology plus the one owned query geometry snapshot. */
function displayBytes(template: GlobeTerrainMeshTemplate): number {return template.vertexCount * 56 + template.triangleCount * 24;}

/** Host-driven cooperative rescaling and query snapshots; owns no camera, device, source or animation loop. */
export class GlobeTerrainDisplayPreparation {
    private current?: GlobeTerrainDisplaySnapshot;
    private target?: {terrain: GlobeTerrainPreparationSnapshot; exaggeration: number};
    private iterator?: Generator<void, void, void>;
    private staged: GlobeTerrainDisplayTile[] = [];
    private disposed = false;
    private readonly maxDisplayBytes: number;
    private readonly maxQueryIndexBytes: number;
    private readonly statistics: Omit<GlobeTerrainDisplayStatistics, 'retainedBytes' | 'queryIndexBytes'>;
    /** Registered current/staged geometry only; query acceleration and external snapshots are separate owners. */
    private readonly leases = new Map<GlobeTerrainDisplayTile, readonly TerrainResourceLease[]>();
    /** Shared registered-allocation pool, without owning the pool or other clients. */
    private readonly resourceBudget?: TerrainResourceBudget;

    /** Budget retained geometry and lazy acceleration separately; scratch, templates and GPU memory are excluded. */
    constructor(options: {
        /** Current plus replacement display/query geometry cap; defaults to 128 MiB. */
        maxDisplayBytes?: number;
        /** Current lazy query hierarchy cap; defaults to 64 MiB. */
        maxQueryIndexBytes?: number;
        /** Shared registered-allocation budget for retained display/query geometry, excluding lazy indexes and scratch. */
        resourceBudget?: TerrainResourceBudget;
    } = {}) {
        this.maxDisplayBytes = options.maxDisplayBytes ?? 128 * 1024 * 1024;
        this.maxQueryIndexBytes = options.maxQueryIndexBytes ?? 64 * 1024 * 1024;
        this.resourceBudget = options.resourceBudget;
        for (const limit of [this.maxDisplayBytes, this.maxQueryIndexBytes]) if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Globe terrain byte limits must be non-negative integers');
        this.statistics = {pending: 0, byteLimit: this.maxDisplayBytes, requiredPeakBytes: 0, warmedIndexes: 0, deferredIndexes: 0, prepared: 0, reused: 0, committed: 0, cancelled: 0, slices: 0, lastSliceMs: 0, maxSliceMs: 0, workMs: 0};
    }

    /** Latest complete source generation and multiplier win; unchanged or failed requests do not restart. */
    request(terrain: GlobeTerrainPreparationSnapshot, exaggeration: number): boolean {
        if (this.disposed) throw new Error('Globe terrain display preparation is disposed');
        assertGlobeTerrainPreparationSnapshot(terrain); getGlobeTerrainExaggeration(0, exaggeration);
        if (this.target?.terrain === terrain && this.target.exaggeration === exaggeration) return false;
        this.cancel(); this.target = {terrain, exaggeration};
        Object.assign(this.statistics, {pending: terrain.grids.length, requiredPeakBytes: 0, warmedIndexes: 0, deferredIndexes: 0, prepared: 0, reused: 0, slices: 0, lastSliceMs: 0, maxSliceMs: 0, workMs: 0, error: undefined});
        this.iterator = this.prepare(terrain, exaggeration);
        return true;
    }

    /** Advance at least one chunk; query-snapshot construction remains an indivisible per-tile step. */
    advance(budgetMs = 4, now: () => number = () => performance.now()): boolean {
        if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new Error('Display slice target must be positive');
        if (!this.iterator) return false;
        const started = now(); let committed = false;
        try {
            do {
                const result = this.iterator.next();
                if (result.done) {this.iterator = undefined; committed = true; break;}
            } while (now() - started < budgetMs);
        } catch (error) {
            this.iterator?.return(); this.iterator = undefined; this.staged = []; this.statistics.pending = 0;
            this.releaseUnusedLeases();
            this.statistics.error = error instanceof Error ? error.message : String(error);
        }
        const elapsed = Math.max(0, now() - started);
        this.statistics.slices++; this.statistics.lastSliceMs = elapsed; this.statistics.maxSliceMs = Math.max(this.statistics.maxSliceMs, elapsed); this.statistics.workMs += elapsed;
        return committed;
    }

    /** Explicitly retry a failed request while retaining the displayed generation. */
    retry(): boolean {
        if (!this.statistics.error || !this.target || this.disposed) return false;
        const {terrain, exaggeration} = this.target; this.target = undefined;
        return this.request(terrain, exaggeration);
    }

    /** Complete generation only; drawing and picking always adopt the same geometry. */
    getSnapshot(): GlobeTerrainDisplaySnapshot | undefined {return this.current;}

    /** Detached exact array retention and cooperative-work counters. */
    getStatistics(): GlobeTerrainDisplayStatistics {
        const tiles = this.getOwnedTiles();
        return {...this.statistics, retainedBytes: tiles.reduce((sum, tile) => sum + displayBytes(tile.template), 0), queryIndexBytes: tiles.reduce((sum, tile) => sum + tile.surface.getStatistics().queryIndexBytes, 0)};
    }

    /** True while work awaits the next host slice. */
    isPending(): boolean {return Boolean(this.iterator);}

    /** Cancel staged rescaling and release its reservations while keeping the displayed generation. */
    cancel(): boolean {
        const pending = Boolean(this.iterator);
        if (pending) this.statistics.cancelled++;
        this.iterator?.return(); this.iterator = undefined; this.staged = []; this.target = undefined; this.statistics.pending = 0;
        this.releaseUnusedLeases();
        return pending;
    }

    /** Close staged generators and release owned references; external snapshots remain the caller's responsibility. */
    destroy(): void {
        this.cancel(); this.current = undefined; this.releaseUnusedLeases(); this.disposed = true;
    }

    /** Count shared tile handles once, including already allocated lazy query indexes. */
    private getOwnedTiles(): GlobeTerrainDisplayTile[] {return [...new Set([...(this.current ? resolveGlobeTerrainDisplay(this.current) : []), ...this.staged])];}

    /** External snapshots are not owned by this preparation object and require their own lifetime accounting. */
    private releaseUnusedLeases(): void {
        const retained = new Set(this.getOwnedTiles());
        for (const [tile, leases] of this.leases) if (!retained.has(tile)) {for (const lease of leases) lease.release(); this.leases.delete(tile);}
    }

    /** Preflight a whole replacement before scaling; reuse compatible complete tiles and commit them together. */
    private *prepare(terrain: GlobeTerrainPreparationSnapshot, exaggeration: number): Generator<void, void, void> {
        const previous = new Map((this.current ? resolveGlobeTerrainDisplay(this.current) : []).map(tile => [tile.template, tile]));
        const queryLimit = Math.floor(this.maxQueryIndexBytes / Math.max(1, terrain.grids.length));
        const candidates = terrain.grids.map(grid => {
            const template = getPreparedGlobeTerrainTemplate(terrain, grid), tile = previous.get(template);
            const required = tile?.surface.getStatistics().requiredQueryIndexBytes ?? 0;
            const retained = tile?.exaggeration === exaggeration && (required <= tile.queryLimit) === (required <= queryLimit) ? tile : undefined;
            return {grid, template, retained};
        });
        const currentBytes = this.current?.byteLength ?? 0, newBytes = candidates.reduce((sum, tile) => sum + (tile.retained ? 0 : displayBytes(tile.template)), 0);
        this.statistics.requiredPeakBytes = currentBytes + newBytes;
        if (newBytes > 0 && currentBytes + newBytes > this.maxDisplayBytes) throw new Error('Globe terrain display-byte limit exceeded; previous terrain retained');
        const reservations = this.resourceBudget?.reserveAll(candidates.filter(tile => !tile.retained).flatMap(tile => [
            {domain: 'retained' as const, bytes: tile.template.byteLength, identity: tile.template},
            {domain: 'retained' as const, bytes: displayBytes(tile.template)}])) ??
            (this.resourceBudget ? null : []);
        if (!reservations) throw new Error('Globe terrain display shared resource budget exceeded; previous terrain retained');
        let reservationIndex = 0;
        try {
            for (const candidate of candidates) {
                if (candidate.retained) {this.staged.push(candidate.retained); this.statistics.reused++;}
                else {
                    let scaled: GlobeTerrainMesh | undefined = yield* scaleGlobeTerrainMeshSteps(candidate.template, exaggeration);
                    const surface = new TerrainMeshSurface({projection: 'globe', positions: scaled.positions, indices: scaled.indices, physicalHeights: scaled.physicalHeights, cullBackfaces: true, maxQueryIndexBytes: queryLimit});
                    const tile = {grid: candidate.grid, template: candidate.template, exaggeration, mesh: getTerrainRenderMesh(scaled), surface, queryLimit};
                    const tileReservations = reservations.slice(reservationIndex, reservationIndex + 2); reservationIndex += 2;
                    if (tileReservations.length) this.leases.set(tile, tileReservations);
                    this.staged.push(tile);
                    scaled = undefined; this.statistics.prepared++;
                    const required = surface.getStatistics().requiredQueryIndexBytes;
                    if (required > 0 && required <= queryLimit) {
                        // Reserve even cold current indexes: an input event may build them between host slices.
                        const currentTiles = new Set(this.current ? resolveGlobeTerrainDisplay(this.current) : []);
                        const reserved = this.getOwnedTiles().reduce((sum, tile) => {
                            const statistics = tile.surface.getStatistics();
                            return sum + (currentTiles.has(tile) && statistics.requiredQueryIndexBytes <= tile.queryLimit ? statistics.requiredQueryIndexBytes : statistics.queryIndexBytes);
                        }, 0);
                        if (reserved + required <= this.maxQueryIndexBytes) {
                            yield* surface.prepareQueryIndexSteps(); this.statistics.warmedIndexes++;
                        } else this.statistics.deferredIndexes++;
                    }
                }
                this.statistics.pending--; yield;
            }
            const snapshot = Object.freeze({terrain, exaggeration, byteLength: this.staged.reduce((sum, tile) => sum + displayBytes(tile.template), 0), maxDisplayBytes: this.maxDisplayBytes, maxQueryIndexBytes: this.maxQueryIndexBytes});
            displays.set(snapshot, this.staged); this.current = snapshot; this.staged = []; this.statistics.committed++; this.releaseUnusedLeases();
        } finally {
            const adopted = new Set([...this.leases.values()].flat());
            for (const reservation of reservations) if (!adopted.has(reservation)) reservation.release();
        }
    }
}
