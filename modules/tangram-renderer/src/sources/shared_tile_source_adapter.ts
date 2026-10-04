// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import DataSource from './data_source';
import {MVTSource} from './mvt';
import {GeoJSONTileSource} from './geojson';
import {RasterTileSource} from './raster';
import Utils from '../utils/utils';
import AlignedTangramTileSource from './aligned_tile_source';
import TangramTileSourceAdapter from './tile_source_adapter';
import type {TileSourceContext} from './tile_source_adapter';
import {applyTilePayload, getTileSourceRequest, updateTileSourceRequest} from './tile_source_state';
import type {DecodedTilePayload, TileSourceRequestState} from './tile_source_state';
import DecodedTileStore, {createTileLeaseAbortError} from './decoded_tile_store';
import type {DecodedTileLease} from './decoded_tile_store';

/** Acquisition anchors copied from worker messages, without mesh or build ownership. */
export interface SharedTileContext extends TileSourceContext {
    /** Legacy diagnostic identity; never part of shared data identity. */
    key: string;
    /** Tile northwest in EPSG:3857 meters. */
    min: {x: number; y: number};
    /** Tile southeast in EPSG:3857 meters. */
    max: {x: number; y: number};
    /** Per-consumer detached diagnostic fields. */
    debug?: Record<string, unknown>;
}

/** Reusable content and acquisition diagnostics, excluding live request IDs and consumer contexts. */
interface SharedTileResult {
    /** Original postprocessed geometry, winding, seam padding and attached rasters. */
    readonly payload: DecodedTilePayload;
    /** Resolved legacy provider error and URL; never ownership of a cancellation ID. */
    readonly diagnostics: Pick<TileSourceRequestState, 'error' | 'url'>;
    /** Detached timing fields; each consumer receives its own debug shell. */
    readonly debug: Readonly<Record<string, unknown>>;
}

/** Only exact built-in tiled pipelines without custom hooks participate in production sharing. */
export function supportsSharedTileAcquisition(source: unknown): source is DataSource {
    if (!(source instanceof DataSource) || source.transform || source.preprocess || source.scripts?.length) return false;
    if (Object.getOwnPropertyNames(source).some(name => typeof Reflect.get(source, name) === 'function')) return false;
    if (source instanceof MVTSource && Object.getPrototypeOf(source) === MVTSource.prototype) {
        return source.decoder === 'tangram' && !source.tile_provider &&
            source.load === MVTSource.prototype.load && source.parseSourceData === MVTSource.prototype.parseSourceData;
    }
    if (source instanceof GeoJSONTileSource && Object.getPrototypeOf(source) === GeoJSONTileSource.prototype) {
        return source.load === GeoJSONTileSource.prototype.load && source.parseSourceData === GeoJSONTileSource.prototype.parseSourceData;
    }
    return source instanceof RasterTileSource && Object.getPrototypeOf(source) === RasterTileSource.prototype && source.load === RasterTileSource.prototype.load;
}

/** Worker-local ownership bridge; custom sources continue through the original first-match procedure. */
export default class SharedTileSourceAdapter<TileT extends SharedTileContext> {
    /** No unreferenced warm cache; content stays alive only while worker tile leases need it. */
    readonly store = new DecodedTileStore<SharedTileResult>(result => result.payload.byteLength);
    /** Worker tile identity owns its own lease, never the underlying request's cancellation ID. */
    private leases = new WeakMap<TileT, DecodedTileLease<SharedTileResult>>();
    /** Workers with imported external scripts cannot assume built-in prototype purity. */
    private readonly sharingEnabled: boolean;

    /** Enable only known built-in pipelines; external worker scripts conservatively disable sharing. */
    constructor(sharingEnabled = true) { this.sharingEnabled = sharingEnabled; }

    /** Acquire compatible decoded content or preserve the original custom-source loading path. */
    loadTile(tile: TileT, source: DataSource | undefined, getRetainedTiles: () => Iterable<TileT>): Promise<TileT> {
        this.releaseTile(tile);
        if (!this.sharingEnabled || !supportsSharedTileAcquisition(source)) {
            return new TangramTileSourceAdapter(source, getRetainedTiles).getTileData({index: tile.coords, id: tile.key, context: tile});
        }
        const context: SharedTileContext = {source: tile.source, key: tile.key, coords: {...tile.coords},
            min: {...tile.min}, max: {...tile.max}, debug: {}};
        const lease = this.store.acquireTile({source, key: tile.coords.key, load: async signal => {
            // The worker's traversal already applied display/bounds policy. Do not re-filter by data zoom.
            const aligned = new AlignedTangramTileSource({load: destination => source.load(destination),
                copyTileData: (reference, destination) => source.copyTileData(reference, destination),
                getMetadata: () => source.getMetadata()}, {createContext: () => context, cancel: destination => {
                const request = getTileSourceRequest(destination);
                if (request.requestId) Utils.cancelRequest(request.requestId);
                updateTileSourceRequest(destination, {requestId: null});
            }});
            const payload = await aligned.getTileData({index: context.coords, id: context.key,
                bbox: {left: context.min.x, top: context.min.y, right: context.max.x, bottom: context.max.y}, signal});
            if (!payload) throw new Error('Shared tile acquisition unexpectedly returned no payload');
            const request = getTileSourceRequest(context);
            return {payload, diagnostics: {error: request.error, url: request.url}, debug: {...context.debug}};
        }});
        this.leases.set(tile, lease);
        return lease.promise.then(result => {
            if (this.leases.get(tile) !== lease || !lease.isActive()) throw createTileLeaseAbortError();
            applyTilePayload(tile, result.payload);
            updateTileSourceRequest(tile, result.diagnostics);
            tile.debug = {...tile.debug, ...result.debug};
            return tile;
        }).catch(error => {
            if (this.leases.get(tile) === lease) this.releaseTile(tile);
            throw error;
        });
    }

    /** Release this tile's interest; the final consumer alone cancels pending acquisition. */
    releaseTile(tile: TileT): void {
        const lease = this.leases.get(tile);
        this.leases.delete(tile);
        lease?.release();
    }

    /** Invalidate one source instance while preserving unchanged sources and style-only rebuilds. */
    invalidateSource(source: object): void { this.store.invalidateSource(source); }

    /** Release all content and pending work at worker reinitialization or explicit teardown. */
    finalize(): void { this.store.finalize(); this.leases = new WeakMap(); }
}
