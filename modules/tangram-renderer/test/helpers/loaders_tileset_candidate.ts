// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Tileset2D} from '@loaders.gl/tiles';
import type {SharedTile2DHeader, Tileset2DAdapter} from '@loaders.gl/tiles';
import {TileID} from '../../src/tile/tile_id';
import type {TileCoordinates, TileSource} from '../../src/tile/tile_id';
import type {TangramTraversalState} from '../../src/tile/tile_traversal_adapter';
import {createTileLeaseAbortError} from '../../src/sources/decoded_tile_store';

/** Renderer-owned style identity with a separate source-normalized content index. */
export interface CandidateMeshTile<DataT> {
    /** Tangram source/data/style identity, not the loaders.gl XYZ cache ID. */
    readonly key: string;
    /** Display zoom must not be taken from the decoded data header. */
    readonly styleZoom: number;
    /** Published shared data header; no mesh or selection-buffer ownership. */
    readonly content: SharedTile2DHeader<DataT>;
}

/** Development-only candidate options; decoded cache budgets are not mesh budgets. */
export interface LoadersTilesetCandidateOptions<DataT> {
    /** One immutable source revision per candidate instance. */
    readonly source: TileSource;
    /** Existing Tangram traversal, including stereo, globe and bounded FirstPerson inputs. */
    readonly adapter: Tileset2DAdapter<TangramTraversalState>;
    /** Source acquisition receives cancellation independently of styled mesh builds. */
    load(index: TileCoordinates, signal: AbortSignal): Promise<DataT>;
    /** Optional allocation estimator; absent or invalid estimates remain unknown. */
    getByteLength?(content: DataT): number | undefined;
    /** Published source-procedure capacity; zero means unlimited. */
    readonly maxRequests?: number;
    /** Decoded warm entries, explicitly separate from HostFrame mesh-cache policy. */
    readonly maxDecodedTiles?: number;
    /** Release decoded resources, never renderer GPU meshes. */
    onContentUnload?(content: DataT): void;
}

/**
 * Executable loaders.gl-backed candidate, intentionally confined to test tooling.
 * Tangram still owns styled meshes, refinement decisions, labels and GPU disposal.
 */
export default class LoadersTilesetCandidate<DataT> {
    /** The actual published engine, not a copied scheduler or private cache implementation. */
    readonly decodedTileset: Tileset2D<DataT, TangramTraversalState>;
    /** Candidate source identity and allocation/release hooks. */
    private readonly options: LoadersTilesetCandidateOptions<DataT>;
    /** Each host keeps separate mesh identities while sharing decoded headers. */
    private readonly consumers = new Map<symbol, CandidateMeshTile<DataT>[]>();
    /** Globe fallback has its own protection and is not an ordinary selected detail consumer. */
    private readonly preloadConsumer = Symbol('globe-preload');
    /** Prevent source work or late publication after revision replacement. */
    private finalized = false;

    /** Create a source-local engine without importing it into any production renderer entry. */
    constructor(options: LoadersTilesetCandidateOptions<DataT>) {
        this.options = options;
        this.decodedTileset = new Tileset2D({adapter: options.adapter,
            maxRequests: options.maxRequests ?? 0, maxCacheSize: options.maxDecodedTiles ?? 0,
            getTileData: async ({index, signal}) => {
                if (!signal || signal.aborted || this.finalized) throw createTileLeaseAbortError();
                const content = await options.load(index, signal);
                // Published headers otherwise accept a late non-cooperative result after abort.
                if (signal.aborted || this.finalized) throw createTileLeaseAbortError();
                return content;
            }, onTileUnload: tile => {
                if (tile.isLoading) tile.abort();
                if (tile.content !== null) options.onContentUnload?.(tile.content);
            }});
        this.decodedTileset.getTileIndices({viewState: {eyes: []}, zRange: null});
    }

    /** Install the eye union and separately authored drawable ancestor/descendant protection. */
    updateConsumer(id: symbol, state: TangramTraversalState, styleZoom: number,
        fallbacks: readonly {index: TileCoordinates; styleZoom: number}[] = []): CandidateMeshTile<DataT>[] {
        if (this.finalized) throw new Error('Tileset candidate is finalized');
        const meshTiles = new Map<string, CandidateMeshTile<DataT>>();
        for (const index of this.decodedTileset.getTileIndices({viewState: state, zRange: null})) {
            for (const tile of this.createMeshTile(index, styleZoom)) meshTiles.set(tile.key, tile);
        }
        const selected = [...meshTiles.values()];
        const visible = fallbacks.flatMap(tile => this.createMeshTile(tile.index, tile.styleZoom));
        this.consumers.set(id, selected);
        this.decodedTileset.updateConsumer(id, [...new Set(selected.map(tile => tile.content))],
            [...new Set([...selected, ...visible].map(tile => tile.content))]);
        this.decodedTileset.prepareTiles();
        return selected;
    }

    /** Pin decoded coarse globe content without turning it into a visible styled mesh. */
    setPreload(indices: readonly TileCoordinates[]): void {
        if (this.finalized) throw new Error('Tileset candidate is finalized');
        const headers = indices.flatMap(index => this.createMeshTile(index, index.z)).map(tile => tile.content);
        this.decodedTileset.updateConsumer(this.preloadConsumer, [], [...new Set(headers)]);
        this.decodedTileset.prepareTiles();
    }

    /** Detach only this host; another eye/style or pinned preload still owns its header. */
    detachConsumer(id: symbol): void {
        this.consumers.delete(id);
        this.decodedTileset.detachConsumer(id);
    }

    /** Retry a cached failure explicitly rather than introducing automatic request loops. */
    retryTile(index: TileCoordinates): SharedTile2DHeader<DataT> {
        if (this.finalized) throw new Error('Tileset candidate is finalized');
        const normalized = TileID.normalizedCoord(index, this.options.source);
        const cached = this.decodedTileset.getTile(normalized);
        if (cached?.hasError) cached.setNeedsReload();
        return this.decodedTileset.getTile(normalized, true);
    }

    /** Report unknown allocation honestly instead of the upstream missing-byteLength zero. */
    getStatistics(): {decodedTiles: number; decodedBytes: number | undefined; meshConsumers: number} {
        this.decodedTileset.prepareTiles();
        const tiles = this.decodedTileset.tiles.filter(tile => tile.content !== null);
        let decodedBytes: number | undefined = 0;
        for (const tile of tiles) {
            if (tile.content === null) continue;
            const bytes = this.options.getByteLength?.(tile.content);
            if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) decodedBytes = undefined;
            else if (decodedBytes !== undefined) decodedBytes += bytes;
        }
        return {decodedTiles: tiles.length, decodedBytes, meshConsumers: this.consumers.size};
    }

    /** Finalize requires explicit release: published finalize does not emit onTileUnload. */
    finalize(): void {
        if (this.finalized) return;
        this.finalized = true;
        this.decodedTileset.prepareTiles();
        try {
            for (const tile of this.decodedTileset.tiles) {
                if (tile.content !== null) this.options.onContentUnload?.(tile.content);
            }
        } finally { this.decodedTileset.finalize(); this.consumers.clear(); }
    }

    /** Normalize sparse data levels while preserving source/style keys and unwrapped worlds. */
    private createMeshTile(index: TileCoordinates, styleZoom: number): CandidateMeshTile<DataT>[] {
        const normalized = TileID.normalizedCoord(index, this.options.source);
        const key = TileID.key(normalized, this.options.source, styleZoom);
        return key === undefined ? [] : [{key, styleZoom, content: this.decodedTileset.getTile(normalized, true)}];
    }
}
