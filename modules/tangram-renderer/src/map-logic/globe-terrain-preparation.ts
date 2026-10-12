// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {prepareGlobeTerrainMeshSteps, type GlobeTerrainMeshTemplate} from './globe-terrain';
import type {TerrainHeightGrid} from './terrain-data';

/** Complete, immutable neighborhood generation; only library-produced handles can resolve templates. */
export interface GlobeTerrainPreparationSnapshot {
    /** Ordered immutable source identities; applications must not mutate their samples. */
    readonly grids: readonly TerrainHeightGrid[];
    /** Uniform curved-cell resolution for all stitched tiles. */
    readonly resolution: number;
    /** Owned prepared typed arrays, excluding source, display/query buffers and GPU allocations. */
    readonly byteLength: number;
}

/** One source and the touching immutable neighbors that determined its topology and lighting. */
interface PreparedTile {
    grid: TerrainHeightGrid;
    neighbors: readonly TerrainHeightGrid[];
    template: GlobeTerrainMeshTemplate;
}

/** Snapshot internals cannot be forged or modified through an exported handle. */
const snapshots = new WeakMap<GlobeTerrainPreparationSnapshot, readonly PreparedTile[]>();

/** Resolve only a source identity belonging to a completed preparation generation. */
export function getPreparedGlobeTerrainTemplate(snapshot: GlobeTerrainPreparationSnapshot, grid: TerrainHeightGrid): GlobeTerrainMeshTemplate {
    const tile = snapshots.get(snapshot)?.find(candidate => candidate.grid === grid);
    if (!tile) throw new Error('Prepared globe terrain requires a completed snapshot and matching source identity');
    return tile.template;
}

/** Detached cooperative-work diagnostics, not a frame-time or whole-process memory measurement. */
export interface GlobeTerrainPreparationStatistics {
    /** Tiles still awaiting preparation in the latest request. */
    pending: number;
    /** Unique current and staged template storage; shared templates count once. */
    retainedBytes: number;
    /** Maximum retained template bytes permitted by this owner. */
    byteLimit: number;
    /** Fully published generations. */
    committed: number;
    /** Requests replaced before completion. */
    cancelled: number;
    /** New templates admitted by the latest generation. */
    prepared: number;
    /** Templates reused by the latest generation. */
    reused: number;
    /** Cooperative CPU slices in the latest generation. */
    slices: number;
    /** Last slice's elapsed time; an indivisible step may exceed its target. */
    lastSliceMs: number;
    /** Largest observed slice in the latest generation. */
    maxSliceMs: number;
    /** CPU slice elapsed sum, excluding time yielded back to the host. */
    workMs: number;
    /** Last preparation/admission failure; retry is explicit. */
    error?: string;
}

/** Same-datum touching footprints, including antimeridian edges and corners. */
function getNeighbors(grid: TerrainHeightGrid, grids: readonly TerrainHeightGrid[]): TerrainHeightGrid[] {
    const circumference = 2 * Math.PI * 6378137;
    return grids.filter(candidate => candidate !== grid && [-circumference, 0, circumference].some(shift =>
        candidate.bounds[0] + shift <= grid.bounds[2] && candidate.bounds[2] + shift >= grid.bounds[0] && candidate.bounds[1] <= grid.bounds[3] && candidate.bounds[3] >= grid.bounds[1]));
}

/** Ordered identity comparison; no expensive sample scan or source mutation is performed. */
function sameGrids(first: readonly TerrainHeightGrid[], second: readonly TerrainHeightGrid[]): boolean {
    return first.length === second.length && first.every((grid, index) => grid === second[index]);
}

/** Latest-request-wins preparation driven by the host, with atomic stitched snapshots and bounded retention. */
export class GlobeTerrainPreparation {
    private current?: GlobeTerrainPreparationSnapshot;
    private target?: {grids: readonly TerrainHeightGrid[]; resolution: number};
    private iterator?: Generator<void, void, void>;
    private staged: PreparedTile[] = [];
    private disposed = false;
    private readonly statistics: GlobeTerrainPreparationStatistics;

    /** Retention includes the currently displayed and partially prepared generations, but not transient scratch arrays. */
    constructor(maxRetainedBytes = 96 * 1024 * 1024) {
        if (!Number.isSafeInteger(maxRetainedBytes) || maxRetainedBytes < 0) throw new Error('Prepared terrain byte limit must be a non-negative integer');
        this.statistics = {pending: 0, retainedBytes: 0, byteLimit: maxRetainedBytes, committed: 0, cancelled: 0, prepared: 0, reused: 0, slices: 0, lastSliceMs: 0, maxSliceMs: 0, workMs: 0};
    }

    /** Replace obsolete staged work; unchanged requests and failed generations do not restart automatically. */
    request(grids: readonly TerrainHeightGrid[], resolution = 64): boolean {
        if (this.disposed) throw new Error('Globe terrain preparation is disposed');
        if (!Number.isSafeInteger(resolution) || resolution < 2 || resolution > 256) throw new Error('Globe terrain resolution must be an integer in [2, 256]');
        if (grids.some(grid => grid.verticalDatum !== grids[0].verticalDatum)) throw new Error('Globe terrain grids require one compatible vertical datum');
        if (new Set(grids.map(grid => grid.bounds.join(','))).size !== grids.length) throw new Error('Globe terrain grids must have distinct footprints');
        if (this.target?.resolution === resolution && sameGrids(this.target.grids, grids)) return false;
        if (this.iterator) this.statistics.cancelled++;
        this.iterator?.return(); this.staged = [];
        this.target = {grids: Object.freeze([...grids]), resolution};
        Object.assign(this.statistics, {pending: grids.length, prepared: 0, reused: 0, slices: 0, lastSliceMs: 0, maxSliceMs: 0, workMs: 0, error: undefined});
        this.iterator = this.prepare(this.target.grids, resolution);
        return true;
    }

    /** Run at least one bounded step, then yield after the elapsed target; true means a complete generation was committed. */
    advance(budgetMs = 4, now: () => number = () => performance.now()): boolean {
        if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new Error('Preparation slice target must be positive');
        if (!this.iterator) return false;
        const started = now();
        let committed = false;
        try {
            do {
                const result = this.iterator.next();
                if (result.done) {this.iterator = undefined; committed = true; break;}
            } while (now() - started < budgetMs);
        } catch (error) {
            this.iterator?.return(); this.iterator = undefined; this.staged = []; this.statistics.pending = 0;
            this.statistics.error = error instanceof Error ? error.message : String(error);
        }
        const elapsed = Math.max(0, now() - started);
        this.statistics.slices++; this.statistics.lastSliceMs = elapsed; this.statistics.maxSliceMs = Math.max(this.statistics.maxSliceMs, elapsed); this.statistics.workMs += elapsed;
        return committed;
    }

    /** Retry a failed immutable request without resetting the displayed snapshot. */
    retry(): boolean {
        if (!this.statistics.error || !this.target || this.disposed) return false;
        const {grids, resolution} = this.target; this.target = undefined;
        return this.request(grids, resolution);
    }

    /** Completed snapshot only; partial generations are never exposed for rendering or picking. */
    getSnapshot(): GlobeTerrainPreparationSnapshot | undefined {return this.current;}

    /** Detached diagnostic snapshot, including unique current/staged template backing storage. */
    getStatistics(): GlobeTerrainPreparationStatistics {
        return {...this.statistics, retainedBytes: this.getRetainedBytes(this.staged)};
    }

    /** True until the latest generation commits, fails or is cancelled by teardown. */
    isPending(): boolean {return Boolean(this.iterator);}

    /** Release references to current, staged and source data; safe to repeat. */
    destroy(): void {
        this.iterator?.return(); this.iterator = undefined; this.staged = []; this.current = undefined; this.target = undefined;
        this.statistics.pending = 0; this.disposed = true;
    }

    /** Count shared template handles once across visible and candidate generations. */
    private getRetainedBytes(staged: readonly PreparedTile[]): number {
        const templates = new Set([...(this.current ? snapshots.get(this.current) ?? [] : []), ...staged].map(tile => tile.template));
        return [...templates].reduce((sum, template) => sum + template.byteLength, 0);
    }

    /** Preserve unaffected immutable neighborhoods; commit every stitched tile together only after admission succeeds. */
    private *prepare(grids: readonly TerrainHeightGrid[], resolution: number): Generator<void, void, void> {
        const previous = new Map((this.current ? snapshots.get(this.current) ?? [] : []).map(tile => [tile.grid, tile]));
        for (const grid of grids) {
            const neighbors = getNeighbors(grid, grids), retained = previous.get(grid);
            const reuse = retained && this.current?.resolution === resolution && retained.neighbors.length === neighbors.length && retained.neighbors.every((neighbor, index) => neighbor === neighbors[index]);
            const template = reuse ? retained.template : yield* prepareGlobeTerrainMeshSteps(grid, {resolution, neighbors});
            const candidate = {grid, neighbors, template};
            if (this.getRetainedBytes([...this.staged, candidate]) > this.statistics.byteLimit) throw new Error('Prepared globe terrain retained-byte limit exceeded; current terrain retained');
            this.staged.push(candidate); this.statistics.pending--;
            if (reuse) this.statistics.reused++; else this.statistics.prepared++;
            yield;
        }
        const snapshot = Object.freeze({grids, resolution, byteLength: this.staged.reduce((sum, tile) => sum + tile.template.byteLength, 0)});
        snapshots.set(snapshot, this.staged); this.current = snapshot; this.staged = []; this.statistics.committed++;
    }
}
