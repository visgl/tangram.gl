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
import {parseMvtJsonProperties} from '../procedures/mvt-properties';

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

        return Promise.resolve().then(() => tileProvider(url, providerTileIndex)).then(response => {
            debug.network = +new Date() - debug.network;
            debug.parsing = +new Date();
            const preprocessedResponse = response != null && typeof this.preprocess === 'function'
                ? this.preprocess(response)
                : response;
            return Promise.resolve(preprocessedResponse).then(processedResponse => {
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
