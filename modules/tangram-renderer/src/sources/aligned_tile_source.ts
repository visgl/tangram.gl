// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import TangramTileSourceAdapter from './tile_source_adapter';
import type {LegacyTileDataSource, TileSourceContext} from './tile_source_adapter';
import {bindTileSourceCancellation, captureTilePayload, getTileSourceRequest} from './tile_source_state';
import type {DecodedTilePayload} from './tile_source_state';
import type {TangramTileSourceMetadata} from './tile_source_metadata';
import {getTileGeographicBounds} from '../tile/tile_traversal_adapter';
import type {TileCoordinates} from '../tile/tile_id';

/** Structural loaders.gl request contract, with no runtime loaders.gl dependency. */
export interface AlignedTileParameters {
    /** Source-normalized XYZ data index. */
    index: TileCoordinates;
    /** Consumer identity, never used as decoded payload identity. */
    id: string;
    /** Geographic or Cartesian bounds supplied by the tileset. */
    bbox: {west: number; south: number; east: number; north: number} | {left: number; top: number; right: number; bottom: number};
    /** Cancellation supplied by the shared tileset. */
    signal?: AbortSignal;
    /** Optional consumer zoom; data coordinates remain independently source-normalized. */
    zoom?: number;
    /** Host metadata; styleZoom explicitly preserves Tangram's display filtering under overzoom. */
    userData?: Record<string, unknown>;
}

/** Source procedures needed by the candidate source bridge. */
export interface AlignedLegacySource<TileT extends TileSourceContext> extends LegacyTileDataSource<TileT> {
    /** Resolved source metadata, including provider credits. */
    getMetadata(): Promise<TangramTileSourceMetadata>;
    /** Existing sparse-zoom/bounds/display policy; the caller still supplies normalized indices. */
    includesTile?(index: TileCoordinates, styleZoom: number): boolean;
}

/** Explicit request ownership hooks; no renderer or GPU object enters this bridge. */
export interface AlignedTileSourceOptions<TileT extends TileSourceContext> {
    /** Construct a fresh legacy context with source identity, normalized coords and transform bounds. */
    createContext(parameters: AlignedTileParameters): TileT;
    /** Cancel underlying legacy work; providers without cancellation still have their late result ignored. */
    cancel(context: TileT): void;
    /** Optional existing worker registry for legacy first-match reuse. */
    getRetainedTiles?(): Iterable<TileT>;
    /** Observe legacy warn-and-continue errors without putting request diagnostics in reusable content. */
    onResolvedError?(error: string, context: TileT): void;
    /** Optional decoded-content allocation estimate for loaders.gl byte-budget accounting. */
    getPayloadByteLength?(payload: DecodedTilePayload): number;
}

/**
 * Structural loaders.gl TileSource bridge around the original Tangram loading procedures.
 * Built-in worker sharing uses detached contexts; custom sources retain the legacy adapter path.
 */
export default class AlignedTangramTileSource<TileT extends TileSourceContext> {
    /** Content remains in Tangram-local tile space, never silently converted to geographic GeoJSON. */
    readonly localCoordinates = true;
    /** Original parser/transform/source procedures. */
    private readonly source: AlignedLegacySource<TileT>;
    /** Request creation and cancellation stay with the worker adapter. */
    private readonly options: AlignedTileSourceOptions<TileT>;

    /** Bind a legacy source without selecting a new decoder or changing global registrations. */
    constructor(source: AlignedLegacySource<TileT>, options: AlignedTileSourceOptions<TileT>) {
        this.source = source;
        this.options = options;
    }

    /** Resolve source metadata using its existing URL and TileJSON initialization. */
    getMetadata(): Promise<TangramTileSourceMetadata> { return this.source.getMetadata(); }

    /** Flat TileSource request, retaining source-normalized XYZ and generated geographic bounds. */
    getTile({x, y, z, signal}: TileCoordinates & {signal?: AbortSignal}): Promise<DecodedTilePayload | null> {
        const index = {x, y, z};
        return this.getTileData({index, id: `${x}/${y}/${z}`, bbox: getTileGeographicBounds(index), signal});
    }

    /** Acquire detached content with AbortSignal-to-legacy cancellation and no stale publication. */
    getTileData(parameters: AlignedTileParameters): Promise<DecodedTilePayload | null> {
        const signal = parameters.signal;
        if (signal?.aborted) return Promise.reject(createAbortError());
        const styleZoom = typeof parameters.userData?.styleZoom === 'number' ? parameters.userData.styleZoom : parameters.zoom ?? parameters.index.z;
        if (this.source.includesTile && !this.source.includesTile(parameters.index, styleZoom)) return Promise.resolve(null);
        const context = this.options.createContext(parameters);
        const adapter = new TangramTileSourceAdapter(this.source, this.options.getRetainedTiles ?? (() => []));
        return new Promise((resolve, reject) => {
            const cancel = (): void => { if (signal?.aborted) this.options.cancel(context); };
            const unbind = bindTileSourceCancellation(context, cancel);
            const abort = (): void => {
                try { cancel(); } catch (error) { reject(error); return; }
                reject(createAbortError());
            };
            signal?.addEventListener('abort', abort, {once: true});
            const cleanup = (): void => { signal?.removeEventListener('abort', abort); unbind(); };
            if (signal?.aborted) { cleanup(); abort(); return; }
            let loading: Promise<TileT>;
            try { loading = adapter.getTileData({index: parameters.index, id: parameters.id, context}); }
            catch (error) { cleanup(); reject(error); return; }
            loading.then(destination => {
                cleanup();
                if (signal?.aborted) { reject(createAbortError()); return; }
                try {
                    const error = getTileSourceRequest(destination).error;
                    if (error) this.options.onResolvedError?.(error, destination);
                    const payload = captureTilePayload(destination);
                    const byteLength = this.options.getPayloadByteLength?.(payload);
                    if (byteLength !== undefined && (!Number.isFinite(byteLength) || byteLength < 0)) {
                        throw new Error('Decoded tile byte length must be finite and non-negative');
                    }
                    resolve(byteLength === undefined ? payload : {...payload, byteLength});
                } catch (error) { reject(error); }
            }, error => { cleanup(); reject(error); });
        });
    }
}

/** Portable cancellation error shared by browser and Node conformance tests. */
function createAbortError(): Error {
    const error = new Error('Tile source request aborted');
    error.name = 'AbortError';
    return error;
}
