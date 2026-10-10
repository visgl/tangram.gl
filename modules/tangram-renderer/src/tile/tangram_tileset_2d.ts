// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import TileBuildQueue from '../map-logic/tile-build-queue';
import {TileResidency} from '../map-logic/tile-residency';
import TileResourceCache from './tile_resource_cache';
import type {ResourceTile} from './tile_resource_cache';
import type {HostTileResourceOptions, TileResourceStatistics} from '../types';
import type {TileCoordinates} from './tile_id';

/** Host-independent traversal/bounds surface shared with loaders.gl's adapter contract. */
export interface TileTraversalAdapter<ViewStateT> {
    /** Logical tile indices before source/style normalization. */
    getTileIndices(context: {viewState: ViewStateT}): TileCoordinates[];
}

/**
 * Renderer-independent resident tile table, build scheduling, and cache policy.
 *
 * This is a pre-alignment boundary, not a replacement for loaders.gl's Tileset2D.
 * Tangram's adapter still owns traversal, style keys, refinement, and GPU disposal.
 */
export default class TangramTileset2D<TileT extends ResourceTile> {
    /** Shared submission queue; the adapter reports final worker replies and cancellation. */
    readonly buildQueue = new TileBuildQueue();
    /** Legacy keyed table, retained until renderer/worker adapters stop depending on its shape. */
    tileRecords: Record<string, TileT> = {};
    /** Recency and mesh-accounting metadata, separate from payload ownership. */
    private readonly resourceCache = new TileResourceCache();
    /** Limits already validated and copied by the host-frame boundary. */
    private resourceLimits?: Readonly<HostTileResourceOptions>;
    /** Optional shared consumers; the legacy renderer still supplies its own eye union. */
    private readonly residency = new TileResidency();

    /** Delegate logical selection without importing a View, Scene or host viewport implementation. */
    getTileIndices<ViewStateT>(context: {viewState: ViewStateT}, adapter: TileTraversalAdapter<ViewStateT>): TileCoordinates[] {
        return adapter.getTileIndices(context);
    }

    /** Attach a consumer without changing existing renderer-visible flags. */
    attachConsumer(id: symbol): void { this.residency.attachConsumer(id); }

    /** Replace one consumer's selections; other views continue protecting their own content. */
    updateConsumer(id: symbol, selected: readonly string[], visible: readonly string[]): void {
        this.residency.updateConsumer(id, selected, visible);
    }

    /** Release only this consumer's protection, never dispose another consumer's content. */
    detachConsumer(id: symbol): void { this.residency.detachConsumer(id); }

    /** Stable union of requested identities across optional shared consumers. */
    get selectedTileKeys(): string[] {
        return this.residency.getSelectedTileKeys();
    }

    /** Retained tiles in the same stable property order as the legacy manager. */
    get tiles(): TileT[] { return Object.values(this.tileRecords); }

    /** Retain a renderer-owned tile without submitting work or applying refinement. */
    setTile(tile: TileT): void {
        this.tileRecords[tile.key] = tile;
        this.resourceCache.touch(tile.key);
    }

    /** Resolve a source/style identity without re-normalizing its data coordinates. */
    getTile(key: string): TileT | undefined { return this.tileRecords[key]; }

    /** Release ownership, update the adapter's hierarchy, then forget already-disposed content. */
    forgetTile(key: string, beforeDelete?: (tile: TileT) => void): void {
        this.buildQueue.cancel(key);
        this.resourceCache.forget(key);
        const tile = this.getTile(key);
        if (tile !== undefined) beforeDelete?.(tile);
        delete this.tileRecords[key];
    }

    /** Install a shared policy without submitting old work before a visibility batch is installed. */
    setOptions(options: Readonly<HostTileResourceOptions> | undefined): void {
        this.resourceLimits = options;
        this.buildQueue.setLimit(options?.maxConcurrentBuilds);
    }

    /** Select eviction candidates; only the renderer adapter may dispose payload resources. */
    getEvictionKeys(isPinned: (key: string) => boolean): string[] {
        const tiles = this.tiles;
        const isProtected = (key: string): boolean => isPinned(key) || this.buildQueue.has(key) || this.residency.isProtected(key);
        for (const tile of tiles) {
            if (this.resourceCache.isProtected(tile, isProtected)) this.resourceCache.touch(tile.key);
        }
        return this.resourceCache.selectEvictions(tiles, this.resourceLimits, isProtected);
    }

    /** Detached shared residency and queue counters, independent of rendering backend. */
    getStatistics(isPinned: (key: string) => boolean): TileResourceStatistics {
        return this.resourceCache.getStatistics(this.tiles,
            key => isPinned(key) || this.buildQueue.has(key) || this.residency.isProtected(key), this.buildQueue.getCounts());
    }

    /** Stop scheduling, dispose adapter-owned content, and release all resident metadata. */
    finalize(onTileUnload: (tile: TileT) => void): void {
        this.buildQueue.clear();
        this.resourceCache.clear();
        this.residency.clear();
        for (const key in this.tileRecords) onTileUnload(this.tileRecords[key]);
        this.tileRecords = {};
    }
}
