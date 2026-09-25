// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test} from 'vitest';
import {MVTSource} from '../src/sources/mvt';
import {registerMvtDecoder} from '../src/procedures/mvt-parser';
import {registerMvtTileProvider} from '../src/procedures/mvt-tile-provider';

describe('MVTSource', () => {
    test('normalizes parse_json options for all properties', () => {
        const source = new MVTSource({url: 'tiles/{z}/{x}/{y}.mvt', parse_json: true});

        expect(source.parseJsonOption()).toBe(true);
        const feature = {properties: {metadata: '{"kind":"road"}', name: 'Main'}};
        source.parseJSONProperties(feature);
        expect(feature.properties.metadata).toEqual({kind: 'road'});
        expect(feature.properties.name).toBe('Main');
    });

    test('normalizes a property allowlist and preserves invalid JSON', () => {
        const source = new MVTSource({
            url: 'tiles/{z}/{x}/{y}.mvt',
            parse_json: ['metadata']
        });

        expect(source.parseJsonOption()).toEqual(['metadata']);
        const feature = {
            properties: {
                metadata: 'not-json',
                ignored: '{"kind":"building"}'
            }
        };
        source.parseJSONProperties(feature);
        expect(feature.properties.metadata).toBe('not-json');
        expect(feature.properties.ignored).toBe('{"kind":"building"}');
    });

    test('defaults to no property parsing', () => {
        const source = new MVTSource({url: 'tiles/{z}/{x}/{y}.mvt'});
        expect(source.parseJsonOption()).toBeUndefined();
    });

    test('uses the Tangram decoder by default and accepts a registered decoder', () => {
        const legacySource = new MVTSource({url: 'tiles/{z}/{x}/{y}.mvt'});
        const legacyData: {layers?: Record<string, unknown>} = {};
        legacySource.parseSourceData({min: {}, max: {}, coords: {x: 0, y: 0, z: 0}}, legacyData, new Uint8Array());

        const unregister = registerMvtDecoder('test', () => ({
            roads: {type: 'FeatureCollection', features: []}
        }));
        const pluginSource = new MVTSource({
            url: 'tiles/{z}/{x}/{y}.mvt',
            decoder: 'test'
        });
        const sourceData: {layers?: Record<string, unknown>} = {};
        pluginSource.parseSourceData({min: {}, max: {}, coords: {x: 0, y: 0, z: 0}}, sourceData, new Uint8Array([1]));
        unregister();

        expect(legacySource.decoder).toBe('tangram');
        expect(legacyData.layers).toEqual({});
        expect(pluginSource.decoder).toBe('test');
        expect(sourceData.layers).toEqual({
            roads: {type: 'FeatureCollection', features: []}
        });
    });

    test('reports an unknown decoder when parsing a tile', () => {
        const source = new MVTSource({
            url: 'tiles/{z}/{x}/{y}.mvt',
            decoder: 'unknown'
        });

        expect(() => source.parseSourceData(
            {min: {}, max: {}, coords: {x: 0, y: 0, z: 0}},
            {},
            new Uint8Array([1])
        )).toThrow("MVT decoder 'unknown' is not registered in this worker");
    });

    test('loads bytes from a registered tile provider before decoding', async () => {
        const requestedTiles: Array<{url: string; coords: {x: number; y: number; z: number}}> = [];
        const unregisterProvider = registerMvtTileProvider('test-provider', (url, coords) => {
            requestedTiles.push({url, coords});
            return new Uint8Array([7]);
        });
        const unregisterDecoder = registerMvtDecoder('test-provider-decoder', response => ({
            roads: {
                type: 'FeatureCollection',
                features: [{byte: response instanceof Uint8Array ? response[0] : new Uint8Array(response)[0]}]
            }
        }));
        const tileUrl = 'https://tiles.example.test/{z}/{x}/{y}.pmtiles';
        const source = new MVTSource({
            url: tileUrl,
            tile_provider: 'test-provider',
            decoder: 'test-provider-decoder'
        });
        const destination = {
            min: {},
            max: {},
            coords: {x: 2, y: 3, z: 4},
            source_data: {} as {layers?: Record<string, unknown>; error?: string | null; url?: string}
        };

        try {
            await source.loadURL(destination, tileUrl);
        } finally {
            unregisterProvider();
            unregisterDecoder();
        }

        expect(requestedTiles).toEqual([{
            url: 'https://tiles.example.test/4/2/3.pmtiles',
            coords: {x: 2, y: 3, z: 4}
        }]);
        expect(destination.source_data.layers).toEqual({
            roads: {type: 'FeatureCollection', features: [{byte: 7}]}
        });
        expect(destination.source_data.error).toBeNull();
    });

    test('resolves provider failures into source tile errors', async () => {
        const unregisterProvider = registerMvtTileProvider('failing-provider', () => {
            throw new Error('archive read failed');
        });
        const source = new MVTSource({url: 'archive.pmtiles', tile_provider: 'failing-provider'});
        const destination = {
            min: {},
            max: {},
            coords: {x: 0, y: 0, z: 0},
            source_data: {} as {layers?: Record<string, unknown>; error?: string | null; url?: string}
        };

        try {
            await source.loadURL(destination, 'archive.pmtiles');
        } finally {
            unregisterProvider();
        }

        expect(destination.source_data.error).toContain('archive read failed');
    });
});
