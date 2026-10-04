// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import type {TileCoordinates} from '../tile/tile_id';

/** Worker-side request context; contains source data, never main-thread GPU meshes. */
export interface TileSourceContext {
    /** Scene source identity, kept distinct from data and style tile identity. */
    source: string;
    /** Source-normalized data coordinates; style zoom must not enter data-reuse matching. */
    coords: TileCoordinates & {key: string};
    /** Whether source data is available for reuse. */
    loaded?: boolean;
    /** Legacy decoded data and request bookkeeping, mutated in place for cancellation. */
    source_data?: unknown;
}

/** Existing source procedures, preserved until individual loaders.gl switches pass conformance. */
export interface LegacyTileDataSource<TileT extends TileSourceContext> {
    /** Load and postprocess data into the live worker context. */
    load(tile: TileT): Promise<TileT>;
    /** Reuse decoded source data while preserving the destination's style/build identity. */
    copyTileData(reference: TileT, destination: TileT): TileT;
}

/**
 * Index/id request envelope analogous to loaders.gl's getTileData parameters.
 * The required context is Tangram-specific: this is not yet a loaders.gl TileSource.
 */
export interface TangramTileDataRequest<TileT extends TileSourceContext> {
    /** Data index, not the source/style mesh-cache key. */
    readonly index: TileCoordinates;
    /** Destination build identity; not used to decide decoded-data reuse. */
    readonly id: string;
    /** Live legacy context, retained so request IDs and cancellation stay on the worker's tile. */
    readonly context: TileT;
}

/** Preserve the worker's legacy enumerable-property order without allocating a table snapshot. */
export function* iterateSourceTiles<TileT>(tiles: Readonly<Record<string, TileT>>): Iterable<TileT> {
    for (const key in tiles) yield tiles[key];
}

/**
 * Data acquisition/reuse seam with no renderer, traversal, or GPU dependency.
 *
 * Keep the mutable context and resolved-versus-rejected error behavior intact.
 * Metadata, AbortSignal translation, and detached decoded payloads are later steps.
 */
export default class TangramTileSourceAdapter<TileT extends TileSourceContext> {
    /** Current legacy source; undefined preserves the missing-source worker behavior. */
    private readonly source: LegacyTileDataSource<TileT> | undefined;
    /** Read the current worker table at request time, never a stale registry snapshot. */
    private readonly getRetainedTiles: () => Iterable<TileT>;

    /** Bind one source to a caller-owned decoded-data registry. */
    constructor(source: LegacyTileDataSource<TileT> | undefined, getRetainedTiles: () => Iterable<TileT>) {
        this.source = source;
        this.getRetainedTiles = getRetainedTiles;
    }

    /** Acquire source data using the original first-match reuse and loading procedures. */
    getTileData({context}: TangramTileDataRequest<TileT>): Promise<TileT> {
        if (this.source) {
            for (const reference of this.getRetainedTiles()) {
                if (reference.source === context.source && reference.coords.key === context.coords.key && reference.loaded) {
                    return Promise.resolve(this.source.copyTileData(reference, context));
                }
            }
            return this.source.load(context);
        }
        context.source_data = {};
        return Promise.resolve(context);
    }
}
