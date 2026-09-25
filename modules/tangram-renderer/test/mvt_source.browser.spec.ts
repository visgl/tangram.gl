// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test} from 'vitest';
import {MVTSource} from '../src/sources/mvt';
import {registerMvtDecoder} from '../src/procedures/mvt-parser';

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
        legacySource.parseSourceData({min: {}, max: {}, coords: {}}, legacyData, new Uint8Array());

        const unregister = registerMvtDecoder('test', () => ({
            roads: {type: 'FeatureCollection', features: []}
        }));
        const pluginSource = new MVTSource({
            url: 'tiles/{z}/{x}/{y}.mvt',
            decoder: 'test'
        });
        const sourceData: {layers?: Record<string, unknown>} = {};
        pluginSource.parseSourceData({min: {}, max: {}, coords: {}}, sourceData, new Uint8Array([1]));
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
            {min: {}, max: {}, coords: {}},
            {},
            new Uint8Array([1])
        )).toThrow("MVT decoder 'unknown' is not registered in this worker");
    });
});
