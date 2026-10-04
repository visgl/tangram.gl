// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import DataSource, {NetworkTileSource} from './data_source';
import Geo from '../utils/geo';
import log from '../utils/log';
import {
    convertMvtTileWithLegacy,
    decodeMultiPolygon,
    parseMvtWithLegacy,
    type MvtTile
} from '../procedures/mvt-legacy';
import {parseMvt, registerMvtDecoder} from '../procedures/mvt-parser';
import {getMvtTileProvider} from '../procedures/mvt-tile-provider';
import type {MvtTileProviderSource} from '../procedures/mvt-tile-provider';
import {parseMvtJsonProperties} from '../procedures/mvt-properties';
import {createTileSourceMetadata} from './tile_source_metadata';
import type {TangramTileSourceMetadata} from './tile_source_metadata';
import {updateTileSourceRequest} from './tile_source_state';

const PARSE_JSON_TYPE = {
    NONE: 0,
    ALL: 1,
    SOME: 2
};

type MvtSourceConfig = {
    decoder?: string;
    tile_provider?: string;
    parse_json?: boolean | readonly string[];
    name?: string;
    [key: string]: unknown;
};

type TileData = {
    /** Worker cancellation may precede deferred TileJSON URL resolution. */
    canceled?: boolean;
    min: Record<string, unknown>;
    max: Record<string, unknown>;
    coords: Record<string, unknown> & {x: number; y: number; z: number};
    source_data?: SourceData;
    debug?: Record<string, any>;
};

type SourceData = {
    layers?: Record<string, unknown>;
    url?: string;
    error?: string | null;
};

/**
 Mapbox Vector Tile format
 @class MVTSource
*/
export class MVTSource extends NetworkTileSource {

    decoder!: string;
    tile_provider?: string;
    parse_json_type!: number;
    parse_json_prop_list?: readonly string[];
    /** Archive handles belong to this source instance, never a global URL cache. */
    private providerSources = new Map<string, MvtTileProviderSource>();
    /** Source replacement cancels every live tile request, including custom function providers. */
    private providerRequests = new Set<AbortController>();
    /** Additional archive credits are retained separately from scene-authored attribution. */
    private providerAttributions: string[] = [];
    /** Disposed instances cannot reopen an archive after asynchronous URL resolution. */
    private disposed = false;

    /** Resolve a factory once per effective URL; stateless registered functions stay unchanged. */
    private getProviderSource(url: string): MvtTileProviderSource | undefined {
        if (this.disposed) throw new Error('MVT source is disposed');
        const provider = this.tile_provider && getMvtTileProvider(this.tile_provider);
        if (!provider) throw new Error(`MVT tile provider '${this.tile_provider}' is not registered in this worker`);
        if (typeof provider === 'function') return undefined;
        let source = this.providerSources.get(url);
        if (!source) {
            source = provider.createSource(url, {headers: this.request_headers});
            this.providerSources.set(url, source);
        }
        return source;
    }

    /** Include provider credits alongside authored and TileJSON attribution. */
    getAttributions(): string[] { return [...new Set([...super.getAttributions(), ...this.providerAttributions])]; }

    /** Normalize TileJSON and archive capabilities without changing authored layout or decoder choice. */
    async getMetadata(): Promise<TangramTileSourceMetadata> {
        if (!this.tile_provider) return super.getMetadata();
        const url = await this.resolveURL();
        const provider = this.getProviderSource(url);
        const metadata = await provider?.getMetadata?.();
        if (this.disposed) throw new Error('MVT source is disposed');
        this.providerAttributions = (metadata?.attributions ?? []).filter(value => typeof value === 'string' && value.trim()).map(value => value.trim());
        return createTileSourceMetadata(this, {...this.tile_metadata, ...metadata});
    }

    /** Dispose source-owned archive resources and cancel requests on replacement/removal/worker reset. */
    dispose(): void {
        super.dispose();
        this.disposed = true;
        for (const controller of this.providerRequests) controller.abort();
        this.providerRequests.clear();
        for (const provider of this.providerSources.values()) provider.dispose();
        this.providerSources.clear();
    }

    constructor (source: MvtSourceConfig, sources?: Record<string, unknown>) {
        super(source, sources);
        this.response_type = 'arraybuffer'; // binary data
        this.decoder = source.decoder || 'tangram';
        this.tile_provider = source.tile_provider;

        // Optionally parse some or all properties from JSON strings
        if (source.parse_json === true) {
            // try to parse all properties (least efficient)
            this.parse_json_type = PARSE_JSON_TYPE.ALL;
        }
        else if (Array.isArray(source.parse_json)) {
            // try to parse a specific list of property names (more efficient)
            this.parse_json_type = PARSE_JSON_TYPE.SOME;
            this.parse_json_prop_list = source.parse_json;
        }
        else {
            if (source.parse_json != null) {
                let msg = `Data source '${this.name}': 'parse_json' parameter should be 'true', or an array of ` +
                    `property names (was '${JSON.stringify(source.parse_json)}')`;
                log({ level: 'warn', once: true }, msg);
            }

            // skip parsing entirely (default behavior)
            this.parse_json_type = PARSE_JSON_TYPE.NONE;
        }
    }

    loadURL (dest: TileData, url_template: string): Promise<any> {
        if (!this.tile_provider) {
            return super.loadURL(dest, url_template);
        }

        const tileProvider = getMvtTileProvider(this.tile_provider);
        if (!tileProvider) {
            return Promise.reject(new Error(`MVT tile provider '${this.tile_provider}' is not registered in this worker`));
        }

        const url = this.formatURL(url_template, dest);
        const sourceData = dest.source_data as SourceData;
        dest.debug = dest.debug || {};
        const debug = dest.debug;
        debug.network = +new Date();
        sourceData.url = url;
        sourceData.error = null;

        const providerTileIndex = Geo.wrapTile(dest.coords, {x: true, y: false});
        if (this.tms) {
            providerTileIndex.y = Math.pow(2, providerTileIndex.z) - 1 - providerTileIndex.y;
        }

        const controller = new AbortController();
        if (dest.canceled) controller.abort();
        this.providerRequests.add(controller);
        updateTileSourceRequest(dest, {cancel: () => controller.abort()});
        const checkActive = (): void => {
            if (controller.signal.aborted || this.disposed) {
                const error = new Error('MVT provider request aborted');
                error.name = 'AbortError';
                throw error;
            }
        };
        return Promise.resolve().then(() => {
            checkActive();
            return typeof tileProvider === 'function' ? tileProvider(url, providerTileIndex) :
                this.getProviderSource(url)?.getTile(providerTileIndex, controller.signal);
        }).then(response => {
            checkActive();
            debug.network = +new Date() - debug.network;
            debug.parsing = +new Date();
            const preprocessedResponse = response != null && typeof this.preprocess === 'function'
                ? this.preprocess(response)
                : response;
            return Promise.resolve(preprocessedResponse).then(processedResponse => {
                checkActive();
                if (processedResponse != null) {
                    this.parseSourceData(dest, sourceData, processedResponse);
                }
                else {
                    sourceData.layers = {};
                }
                debug.parsing = +new Date() - debug.parsing;
                return dest;
            });
        }).catch(error => {
            sourceData.error = error instanceof Error ? error.stack || error.message : String(error);
            return dest;
        }).finally(() => {
            this.providerRequests.delete(controller);
            updateTileSourceRequest(dest, {cancel: undefined});
        });
    }

    parseSourceData (tile?: TileData, source?: SourceData, response?: ArrayBuffer | Uint8Array): void {
        if (!tile || !source || !response) {
            throw new Error('MVT source parsing requires a tile, source data and response');
        }
        source.layers = parseMvt(this.decoder, response, {parseJson: this.parseJsonOption()});

        // Apply optional data transform
        if (typeof this.transform === 'function') {
            const tile_data = {
                min: Object.assign({}, tile.min),
                max: Object.assign({}, tile.max),
                coords: Object.assign({}, tile.coords)
            };
            source.layers = this.transform(source.layers, this.extra_data, tile_data);
        }

    }

    // Loop through layers/features using Mapbox lib API, convert to GeoJSON features
    // Returns an object with keys for each layer, e.g. { layer: geojson }
    toGeoJSON (tile: MvtTile) {
        return convertMvtTileWithLegacy(tile, {parseJson: this.parseJsonOption()});
    }

    // Optionally parse some or all feature properties from JSON strings
    parseJSONProperties (feature: {properties: Record<string, unknown>}): void {
        parseMvtJsonProperties(feature, this.parseJsonOption());
    }

    parseJsonOption (): boolean | readonly string[] | undefined {
        if (this.parse_json_type === PARSE_JSON_TYPE.ALL) {
            return true;
        }
        if (this.parse_json_type === PARSE_JSON_TYPE.SOME) {
            return this.parse_json_prop_list;
        }
        return undefined;
    }
}

export {decodeMultiPolygon};

DataSource.register('MVT', () => MVTSource);

registerMvtDecoder('tangram', parseMvtWithLegacy);
